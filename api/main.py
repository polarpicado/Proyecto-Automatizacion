import html
import io
import logging
import mimetypes
import os
import re
import secrets
import csv
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional
from xml.etree import ElementTree as ET

from bson import ObjectId
from fastapi import FastAPI, HTTPException, Query, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from pymongo import MongoClient, ReturnDocument

from catalog import flatten_catalog, load_catalog, search_catalog_entries


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[logging.StreamHandler()],
)
logger = logging.getLogger("ServiceDeskAPI")

app = FastAPI(
    title="ServiceDesk Pro API",
    description="API para la gestión de tickets integrada con Agente de IA",
    version="1.3.0",
)

BASE_DIR = Path(__file__).resolve().parent
UPLOADS_DIR = BASE_DIR / "uploads"
REPOSITORY_DIR = BASE_DIR / "repository_storage"
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
REPOSITORY_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=UPLOADS_DIR), name="uploads")
app.mount("/repository-files", StaticFiles(directory=REPOSITORY_DIR), name="repository-files")

ALLOWED_TIPOS = {"Requerimiento", "Incidente"}
ALLOWED_PRIORIDADES = {"Alta", "Normal", "Baja"}
ALLOWED_ESTADOS = {"Abierto", "Asignado", "En espera", "En progreso", "Resuelto", "Cerrado"}
ALLOWED_MODOS = {"Chat", "Email", "Mobile App", "Phone Call", "Web Form"}
ALLOWED_CHATBOT_DECISIONS = {"resolver", "escalar"}
ALLOWED_RESUELTO_POR = {"chatbot", "humano"}
ALLOWED_EXPERIMENT_PHASES = {"pretest", "posttest"}
ALLOWED_RAG_SOURCES = {"base_conocimiento", "generativa"}
ALLOWED_ESCALATION_LEVELS = {"N1", "N2", "N3"}
ALLOWED_SUCURSALES = {
    "Ancon",
    "Callao",
    "Casona",
    "Limana",
    "Remoto",
    "San Isidro",
    "Santa Rosa",
    "Surco",
    "Surquillo",
}
MAX_ASUNTO_LENGTH = 250
MAX_HTML_LENGTH = 20000
MAX_COMMENT_LENGTH = 10000
MAX_ATTACHMENTS_PER_TICKET = 5
MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024
MAX_REPOSITORY_FILE_SIZE = 20 * 1024 * 1024
MAX_KNOWLEDGE_TITLE_LENGTH = 180
AUTO_CLOSE_AFTER = timedelta(days=7)
REOPENABLE_STATUS = "Resuelto"
WEEKDAY_LABELS = {
    0: "lun.",
    1: "mar.",
    2: "mie.",
    3: "jue.",
    4: "vie.",
    5: "sab.",
    6: "dom.",
}
FIELD_LABELS = {
    "tickets": "los tickets",
    "counters": "los correlativos",
    "solutions": "la base de conocimientos",
    "tipo_solicitud": "El tipo de solicitud",
    "prioridad": "La prioridad",
    "estado": "El estado",
    "modo": "El modo",
    "sucursal": "La sucursal",
    "solicitante": "El solicitante",
    "categoria": "La categoría",
    "subcategoria": "La subcategoría",
    "articulo": "El artículo",
    "asunto": "El asunto",
    "descripcion_html": "La descripción",
    "resolucion_html": "La resolución",
    "decision_chatbot": "La decisión del chatbot",
    "resuelto_por": "La resolución final",
    "fase_experimento": "La fase del experimento",
    "categoria_sugerida_ia": "La categoría sugerida por IA",
    "prioridad_sugerida_ia": "La prioridad sugerida por IA",
}

SYSTEM_MANAGED_CREATE_FIELDS = {
    "ID-ITIL",
    "fcr",
    "tiempo_creacion_ticket",
    "tiempo_resolucion_total",
    "fecha_creacion",
    "fecha_actualizacion",
    "fecha_resolucion",
    "adjuntos",
    "comentarios",
    "historial",
}

IMMUTABLE_UPDATE_FIELDS = {
    "ID-ITIL",
    "solicitante",
    "fcr",
    "decision_chatbot",
    "fue_resuelto_en_chat",
    "fue_escalado",
    "numero_interacciones",
    "numero_interacciones_previas",
    "tiempo_inicio_atencion",
    "tiempo_respuesta_chatbot",
    "tiempo_creacion_ticket",
    "tiempo_resolucion_total",
    "resuelto_por",
    "categoria_sugerida_ia",
    "prioridad_sugerida_ia",
    "fecha_creacion",
    "fecha_actualizacion",
    "fecha_resolucion",
    "adjuntos",
    "comentarios",
    "historial",
}

client = None
db = None
tickets_col = None
counters_col = None
solutions_col = None
chat_interactions_col = None


def connect_to_mongo():
    global client, db, tickets_col, counters_col, solutions_col, chat_interactions_col

    mongo_uri = os.getenv("MONGO_URI", "mongodb://admin:admin123@mongo:27017/")
    try:
        client = MongoClient(mongo_uri, serverSelectionTimeoutMS=5000)
        client.server_info()
        db = client["servicedesk"]
        tickets_col = db["tickets"]
        counters_col = db["counters"]
        solutions_col = db["solutions"]
        chat_interactions_col = db["chat_interactions"]
        logger.info("Conexión a MongoDB establecida exitosamente.")
    except Exception as exc:
        client = None
        db = None
        tickets_col = None
        counters_col = None
        solutions_col = None
        chat_interactions_col = None
        logger.error(f"Error critico al conectar a MongoDB: {exc}")


connect_to_mongo()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class TicketCommentSchema(BaseModel):
    autor: str = Field(..., min_length=2, max_length=100)
    comentario_html: str = Field(..., min_length=1, max_length=MAX_COMMENT_LENGTH)


class KnowledgeBaseSchema(BaseModel):
    titulo: str = Field(..., min_length=4, max_length=MAX_KNOWLEDGE_TITLE_LENGTH)
    carpeta: str = Field("", max_length=120)
    descripcion_html: str = Field(..., min_length=1, max_length=MAX_HTML_LENGTH)


class RepositoryExtractionRequest(BaseModel):
    file_name: str = Field(..., min_length=1, max_length=255)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def ensure_utc_datetime(value: datetime | None) -> datetime | None:
    if not isinstance(value, datetime):
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def require_collection(collection, resource_name: str):
    global tickets_col, counters_col, solutions_col, chat_interactions_col
    if collection is None:
        connect_to_mongo()
        if resource_name == "tickets":
            collection = tickets_col
        elif resource_name == "counters":
            collection = counters_col
        elif resource_name == "solutions":
            collection = solutions_col
        elif resource_name == "chat_interactions":
            collection = chat_interactions_col
    if collection is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"No se pudo acceder a {FIELD_LABELS.get(resource_name, resource_name)} porque la base de datos no esta disponible.",
        )
    return collection


def get_catalog_map():
    try:
        return load_catalog()
    except RuntimeError as exc:
        logger.error("No se pudo cargar el catalogo: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="No se pudo cargar el catalogo de categorias en este momento.",
        ) from exc


def strip_html(value: str) -> str:
    text = re.sub(r"<[^>]+>", " ", value or "")
    return html.unescape(text).strip()


def clean_text(value: Any) -> str:
    return str(value or "").strip()


def normalize_title_case(value: str) -> str:
    return clean_text(value).title()


def normalize_capitalized(value: str) -> str:
    text = clean_text(value)
    return text[:1].upper() + text[1:] if text else text


def parse_boolish(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    text = clean_text(value).lower()
    if text in {"true", "1", "si", "sí", "yes"}:
        return True
    if text in {"false", "0", "no"}:
        return False
    return None


def parse_numeric(value: Any, field_name: str, *, integer: bool = False) -> int | float:
    text = clean_text(value)
    if text == "":
        raise HTTPException(status_code=422, detail=f"{FIELD_LABELS.get(field_name, field_name)} no puede estar vacío.")
    try:
        number = int(text) if integer else float(text)
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail=f"{FIELD_LABELS.get(field_name, field_name)} debe ser un valor numérico válido.",
        ) from exc
    if number < 0:
        raise HTTPException(
            status_code=422,
            detail=f"{FIELD_LABELS.get(field_name, field_name)} no puede ser negativo.",
        )
    return number


def parse_datetimeish(value: Any, field_name: str) -> datetime:
    if isinstance(value, datetime):
        return ensure_utc_datetime(value) or utc_now()
    text = clean_text(value)
    if not text:
        raise HTTPException(status_code=422, detail=f"{FIELD_LABELS.get(field_name, field_name)} no puede estar vacío.")
    normalized = text.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail=f"{FIELD_LABELS.get(field_name, field_name)} debe tener formato de fecha válido.",
        ) from exc
    return ensure_utc_datetime(parsed) or utc_now()


def assert_allowed(value: str, allowed_values: set[str], field_name: str):
    if value not in allowed_values:
        allowed = ", ".join(sorted(allowed_values))
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"{FIELD_LABELS.get(field_name, field_name)} debe ser uno de estos valores: {allowed}.",
        )


def validate_catalog_selection(categoria: str, subcategoria: str, articulo: str):
    catalog = get_catalog_map()
    if categoria not in catalog:
        raise HTTPException(status_code=422, detail="La categoría seleccionada no es válida.")
    if subcategoria not in catalog[categoria]:
        raise HTTPException(status_code=422, detail="La subcategoría no corresponde a la categoría seleccionada.")
    if articulo not in catalog[categoria][subcategoria]:
        raise HTTPException(status_code=422, detail="El artículo no corresponde a la subcategoría seleccionada.")


def history_entry(event_type: str, message: str, actor: str = "Sistema", **extra):
    entry = {
        "id": secrets.token_hex(8),
        "event_type": event_type,
        "message": message,
        "actor": actor,
        "created_at": utc_now(),
    }
    entry.update(extra)
    return entry


def detect_reopen_count(ticket: dict[str, Any]) -> int:
    count = 0
    for entry in ticket.get("historial", []):
        if entry.get("event_type") != "status_change":
            continue
        old_value = entry.get("old_value")
        new_value = entry.get("new_value")
        if old_value in {"Resuelto", "Cerrado"} and new_value not in {"Resuelto", "Cerrado"}:
            count += 1
    return count


def calculate_fcr(ticket: dict[str, Any]) -> bool:
    estado = ticket.get("estado")
    if estado not in {"Resuelto", "Cerrado"}:
        return False

    if detect_reopen_count(ticket) > 0:
        return False

    escalation_level = clean_text(ticket.get("nivel_escalamiento")).upper()
    if escalation_level in {"N2", "N3"}:
        return False

    if ticket.get("fue_escalado"):
        return False

    return True


def infer_resolved_by(ticket: dict[str, Any]) -> str | None:
    resolved_by = clean_text(ticket.get("resuelto_por")).lower()
    if resolved_by in ALLOWED_RESUELTO_POR:
        return resolved_by
    if ticket.get("fue_resuelto_en_chat") or ticket.get("decision_chatbot") == "resolver":
        return "chatbot"
    if ticket.get("estado") in {"Resuelto", "Cerrado"}:
        return "humano"
    return None


def calculate_resolution_seconds(ticket: dict[str, Any]) -> float | None:
    resolved_at = ensure_utc_datetime(ticket.get("fecha_resolucion"))
    if resolved_at is None:
        return None

    start_at = ensure_utc_datetime(ticket.get("tiempo_inicio_atencion")) or ensure_utc_datetime(ticket.get("fecha_creacion"))
    if start_at is None:
        return None

    delta = (resolved_at - start_at).total_seconds()
    return round(max(delta, 0.0), 2)


def enrich_ticket_metrics(ticket: dict[str, Any]) -> dict[str, Any]:
    enriched = dict(ticket)
    enriched["categoria_final"] = clean_text(enriched.get("categoria_final") or enriched.get("categoria"))
    enriched["prioridad_final"] = clean_text(enriched.get("prioridad_final") or enriched.get("prioridad"))
    enriched["numero_interacciones_previas"] = int(
        enriched.get("numero_interacciones_previas") or enriched.get("numero_interacciones") or 0
    )
    enriched["resuelto_por"] = infer_resolved_by(enriched)
    enriched["tiempo_creacion_ticket"] = ensure_utc_datetime(
        enriched.get("tiempo_creacion_ticket") or enriched.get("fecha_creacion")
    )
    enriched["tiempo_resolucion_total"] = calculate_resolution_seconds(enriched)
    enriched["fcr"] = calculate_fcr(enriched)
    return enriched


def apply_ticket_lifecycle(ticket_collection, ticket):
    if not ticket:
        return ticket

    resolved_at = ensure_utc_datetime(ticket.get("fecha_resolucion"))
    if ticket.get("estado") != "Resuelto" or resolved_at is None:
        return enrich_ticket_metrics(ticket)

    if utc_now() - resolved_at < AUTO_CLOSE_AFTER:
        return enrich_ticket_metrics(ticket)

    ticket_collection.update_one(
        {"_id": ticket["_id"]},
        {
            "$set": {
                "estado": "Cerrado",
                "fecha_actualizacion": utc_now(),
            },
            "$push": {
                "historial": {
                    "$each": [
                        history_entry(
                            "status_change",
                            "Ticket cerrado automáticamente después de 7 días en estado resuelto.",
                            actor="Sistema",
                            old_value="Resuelto",
                            new_value="Cerrado",
                        )
                    ]
                }
            },
        },
    )
    refreshed = ticket_collection.find_one({"_id": ticket["_id"]}) or ticket
    return enrich_ticket_metrics(refreshed)


def serialize_value(value):
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, ObjectId):
        return str(value)
    if isinstance(value, list):
        return [serialize_value(item) for item in value]
    if isinstance(value, dict):
        return {key: serialize_value(item) for key, item in value.items()}
    return value


def build_attachment_url(ticket_id: str, stored_name: str) -> str:
    return f"/uploads/{ticket_id}/{stored_name}"


def build_knowledge_markdown_url(stored_name: str) -> str:
    return f"/repository-files/knowledge_base/{stored_name}"


def slugify_filename(value: str) -> str:
    normalized = clean_text(value).lower()
    normalized = normalized.replace("ñ", "n")
    normalized = re.sub(r"[^a-z0-9]+", "-", normalized)
    normalized = normalized.strip("-")
    return normalized or f"solucion-{secrets.token_hex(4)}"


def sanitize_repository_filename(filename: str) -> str:
    candidate = Path(filename or "").name.strip()
    candidate = re.sub(r"[^A-Za-z0-9._ -]+", "_", candidate)
    candidate = candidate.replace(" ", "_")
    return candidate or f"archivo_{secrets.token_hex(4)}"


def build_repository_file_url(stored_name: str) -> str:
    return f"/repository-files/{stored_name}"


def serialize_repository_file(path: Path) -> dict[str, Any]:
    stat = path.stat()
    modified_at = datetime.fromtimestamp(stat.st_mtime, timezone.utc)
    return {
        "name": path.name,
        "original_name": path.name,
        "size": stat.st_size,
        "modified_at": modified_at.isoformat(),
        "url": build_repository_file_url(path.name),
        "extension": path.suffix.lower(),
    }


def decode_text_file(content: bytes) -> str:
    for encoding in ("utf-8", "utf-8-sig", "latin-1", "cp1252"):
        try:
            return content.decode(encoding)
        except UnicodeDecodeError:
            continue
    return content.decode("utf-8", errors="replace")


def normalize_plain_text(value: str) -> str:
    text = value.replace("\r\n", "\n").replace("\r", "\n").replace("\ufeff", "")
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in text.split("\n")]
    blocks: list[str] = []
    current: list[str] = []
    for line in lines:
        if not line:
            if current:
                blocks.append(" ".join(current).strip())
                current = []
            continue
        current.append(line)
    if current:
        blocks.append(" ".join(current).strip())
    return "\n\n".join(block for block in blocks if block).strip()


def extract_text_from_docx(content: bytes) -> str:
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            document_xml = archive.read("word/document.xml")
    except KeyError as exc:
        raise HTTPException(status_code=422, detail="El archivo DOCX no contiene el documento principal.") from exc
    except zipfile.BadZipFile as exc:
        raise HTTPException(status_code=422, detail="El archivo DOCX está dañado o no es válido.") from exc

    namespace = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    root = ET.fromstring(document_xml)
    paragraphs = []
    for paragraph in root.findall(".//w:p", namespace):
        texts = [node.text or "" for node in paragraph.findall(".//w:t", namespace)]
        joined = "".join(texts).strip()
        if joined:
            paragraphs.append(joined)
    return normalize_plain_text("\n\n".join(paragraphs))


def extract_text_from_pdf(content: bytes) -> str:
    try:
        from pypdf import PdfReader
    except ImportError as exc:
        raise HTTPException(
            status_code=503,
            detail="La extracción de PDF requiere la dependencia pypdf instalada en la API.",
        ) from exc

    try:
        reader = PdfReader(io.BytesIO(content))
        pages = [page.extract_text() or "" for page in reader.pages]
    except Exception as exc:
        raise HTTPException(status_code=422, detail="No se pudo extraer texto del PDF proporcionado.") from exc

    return normalize_plain_text("\n\n".join(pages))


def extract_plain_text(filename: str, content: bytes) -> tuple[str, str]:
    suffix = Path(filename or "").suffix.lower()
    if suffix == ".txt":
        return normalize_plain_text(decode_text_file(content)), "txt"
    if suffix == ".docx":
        return extract_text_from_docx(content), "docx"
    if suffix == ".pdf":
        return extract_text_from_pdf(content), "pdf"
    raise HTTPException(status_code=422, detail="Solo se aceptan archivos .txt, .docx o .pdf.")


def serialize_extracted_text(file_name: str, extracted_text: str, source_type: str) -> dict[str, Any]:
    return {
        "name": file_name,
        "type": source_type,
        "characters": len(extracted_text),
        "text": extracted_text,
    }


def normalize_tag_list(values: list[str] | None) -> list[str]:
    cleaned = []
    for value in values or []:
        text = clean_text(value)
        if not text:
            continue
        normalized = normalize_capitalized(text)
        if normalized not in cleaned:
            cleaned.append(normalized)
    return cleaned[:MAX_KNOWLEDGE_TAGS]


def markdown_from_html(value: str) -> str:
    text = strip_html(value)
    if not text:
        return ""
    lines = [line.strip() for line in re.split(r"[\r\n]+", text) if line.strip()]
    return "\n\n".join(lines)


def serialize_solution(solution):
    if not solution:
        return None
    data = dict(solution)
    data["_id"] = str(data["_id"])
    for field_name in ("created_at", "updated_at"):
        if data.get(field_name):
            data[field_name] = serialize_value(data[field_name])
    markdown_name = data.get("markdown_file")
    data["markdown_url"] = build_knowledge_markdown_url(markdown_name) if markdown_name else None
    return data


def write_solution_markdown(solution: dict[str, Any]) -> str:
    slug = solution.get("slug") or slugify_filename(solution.get("titulo", "solucion"))
    file_name = f"{slug}.md"
    target = KNOWLEDGE_BASE_DIR / file_name
    tags = ", ".join(solution.get("etiquetas", []))
    keywords = ", ".join(solution.get("palabras_clave", []))
    content = "\n".join(
        [
            "---",
            f'title: "{solution.get("titulo", "")}"',
            f'category: "{solution.get("categoria", "")}"',
            f'status: "{solution.get("estado", "")}"',
            f'tags: "{tags}"',
            f'keywords: "{keywords}"',
            f'updated_at: "{serialize_value(solution.get("updated_at"))}"',
            "---",
            "",
            "# Resumen",
            "",
            solution.get("resumen", ""),
            "",
            "# Problema",
            "",
            markdown_from_html(solution.get("problema_html", "")),
            "",
            "# Solucion",
            "",
            markdown_from_html(solution.get("solucion_html", "")),
            "",
        ]
    ).strip() + "\n"
    target.write_text(content, encoding="utf-8")
    return file_name


def validate_solution_payload(payload: dict[str, Any], partial: bool = False):
    data = {}
    allowed_fields = {
        "titulo",
        "categoria",
        "resumen",
        "problema_html",
        "solucion_html",
        "estado",
        "etiquetas",
        "palabras_clave",
    }

    for key, value in payload.items():
        if key not in allowed_fields:
            continue
        if key in {"etiquetas", "palabras_clave"}:
            if isinstance(value, list):
                data[key] = value
            else:
                data[key] = [item.strip() for item in str(value or "").split(",")]
        else:
            data[key] = clean_text(value)

    required_fields = {"titulo", "categoria", "resumen", "problema_html", "solucion_html"}
    if not partial:
        missing = [field for field in required_fields if not clean_text(data.get(field))]
        if missing:
            readable_map = {
                "titulo": "el título",
                "categoria": "la categoría",
                "resumen": "el resumen",
                "problema_html": "la descripción del problema",
                "solucion_html": "la solución",
            }
            readable = ", ".join(readable_map.get(field, field) for field in missing)
            raise HTTPException(status_code=422, detail=f"Completa estos campos antes de continuar: {readable}.")

    if "titulo" in data:
        title = strip_html(data["titulo"])
        if len(title) < 4:
            raise HTTPException(status_code=422, detail="El título debe tener al menos 4 caracteres.")
        if len(title) > MAX_KNOWLEDGE_TITLE_LENGTH:
            raise HTTPException(status_code=422, detail="El título supera la longitud máxima permitida.")
        data["titulo"] = normalize_capitalized(title)

    if "categoria" in data:
        category = strip_html(data["categoria"])
        if len(category) < 2:
            raise HTTPException(status_code=422, detail="La categoría debe tener al menos 2 caracteres.")
        data["categoria"] = normalize_capitalized(category)

    if "resumen" in data:
        summary = strip_html(data["resumen"])
        if len(summary) < 10:
            raise HTTPException(status_code=422, detail="El resumen debe tener al menos 10 caracteres.")
        if len(summary) > MAX_KNOWLEDGE_SUMMARY_LENGTH:
            raise HTTPException(status_code=422, detail="El resumen supera la longitud máxima permitida.")
        data["resumen"] = normalize_capitalized(summary)

    for html_field, label in (("problema_html", "La descripción del problema"), ("solucion_html", "La solución")):
        if html_field in data:
            if not strip_html(data[html_field]):
                raise HTTPException(status_code=422, detail=f"{label} no puede estar vacía.")
            if len(data[html_field]) > MAX_HTML_LENGTH:
                raise HTTPException(status_code=422, detail=f"{label} supera el máximo permitido.")

    if "estado" in data:
        estado = normalize_capitalized(data["estado"])
        if estado not in {"Borrador", "Publicada"}:
            raise HTTPException(status_code=422, detail="El estado debe ser Borrador o Publicada.")
        data["estado"] = estado

    if "etiquetas" in data:
        data["etiquetas"] = normalize_tag_list(data["etiquetas"])
    if "palabras_clave" in data:
        data["palabras_clave"] = normalize_tag_list(data["palabras_clave"])

    return data


def serialize_attachment(ticket_id: str, attachment: dict):
    data = dict(attachment)
    data["uploaded_at"] = serialize_value(data.get("uploaded_at"))
    data["url"] = build_attachment_url(ticket_id, data["stored_name"])
    return data


def serialize(ticket):
    if not ticket:
        return None

    ticket = enrich_ticket_metrics(dict(ticket))
    ticket_id = str(ticket["_id"])
    ticket["_id"] = ticket_id
    for field_name in (
        "fecha_creacion",
        "fecha_actualizacion",
        "fecha_resolucion",
        "tiempo_inicio_atencion",
        "tiempo_creacion_ticket",
    ):
        if ticket.get(field_name):
            ticket[field_name] = serialize_value(ticket[field_name])

    ticket["historial"] = serialize_value(ticket.get("historial", []))
    ticket["comentarios"] = serialize_value(ticket.get("comentarios", []))
    ticket["adjuntos"] = [
        serialize_attachment(ticket_id, attachment) for attachment in ticket.get("adjuntos", [])
    ]
    return ticket


def get_next_sequence(tipo_solicitud: str):
    counter_collection = require_collection(counters_col, "counters")
    tipo = clean_text(tipo_solicitud).capitalize()
    prefix = "RQ" if tipo == "Requerimiento" else "INC"

    sequence_document = counter_collection.find_one_and_update(
        {"_id": prefix},
        {"$inc": {"seq": 1}},
        upsert=True,
        return_document=ReturnDocument.AFTER,
    )

    if not sequence_document:
        return f"{prefix}-0000001"

    sequence_number = sequence_document.get("seq", 1)
    return f"{prefix}-{sequence_number:07d}"


async def parse_request_payload(request: Request):
    content_type = request.headers.get("content-type", "")
    if "multipart/form-data" in content_type:
        form = await request.form()
        payload = {}
        files = []
        for key, value in form.multi_items():
            if hasattr(value, "filename"):
                if value.filename:
                    files.append(value)
                continue
            payload[key] = value
        return payload, files

    if "application/json" in content_type:
        return await request.json(), []

    if not content_type:
        return {}, []

    raise HTTPException(status_code=415, detail="El formato del envio no es compatible.")


def validate_ticket_payload(payload: dict[str, Any], partial: bool = False):
    data = {}
    text_fields = {
        "solicitante",
        "tipo_solicitud",
        "prioridad",
        "estado",
        "modo",
        "sucursal",
        "categoria",
        "subcategoria",
        "articulo",
        "asunto",
        "descripcion_html",
        "resolucion_html",
        "decision_chatbot",
        "resuelto_por",
        "categoria_sugerida_ia",
        "categoria_final",
        "prioridad_sugerida_ia",
        "prioridad_final",
        "razon_decision",
        "fase_experimento",
        "fuente_respuesta",
        "nivel_escalamiento",
    }
    integer_fields = {"numero_interacciones", "numero_interacciones_previas"}
    float_fields = {"tiempo_respuesta_chatbot", "tiempo_resolucion_total"}
    bool_fields = {"fue_resuelto_en_chat", "fue_escalado", "decision_validada", "usa_contexto_rag", "fcr"}
    datetime_fields = {"tiempo_inicio_atencion", "tiempo_creacion_ticket"}
    aliases = {"resolucion": "resolucion_html"}

    for original_key, value in payload.items():
        key = aliases.get(original_key, original_key)
        if key in text_fields:
            data[key] = clean_text(value)
        elif key in integer_fields:
            if clean_text(value) == "":
                continue
            data[key] = parse_numeric(value, key, integer=True)
        elif key in float_fields:
            if clean_text(value) == "":
                continue
            data[key] = parse_numeric(value, key, integer=False)
        elif key in bool_fields:
            if clean_text(value) == "":
                continue
            parsed_bool = parse_boolish(value)
            if parsed_bool is None:
                raise HTTPException(
                    status_code=422,
                    detail=f"{FIELD_LABELS.get(key, key)} debe ser verdadero o falso.",
                )
            data[key] = parsed_bool
        elif key in datetime_fields:
            if clean_text(value) == "":
                continue
            data[key] = parse_datetimeish(value, key)

    required_fields = {
        "solicitante",
        "tipo_solicitud",
        "prioridad",
        "estado",
        "modo",
        "sucursal",
        "categoria",
        "subcategoria",
        "articulo",
        "asunto",
        "descripcion_html",
    }
    if not partial:
        missing = [field for field in required_fields if not clean_text(data.get(field))]
        if missing:
            readable = ", ".join(FIELD_LABELS.get(field, field) for field in missing)
            raise HTTPException(status_code=422, detail=f"Completa estos campos antes de continuar: {readable}.")

    if "solicitante" in data:
        if len(strip_html(data["solicitante"])) < 2:
            raise HTTPException(status_code=422, detail="El solicitante debe tener al menos 2 caracteres.")
        data["solicitante"] = normalize_title_case(data["solicitante"])

    if "tipo_solicitud" in data:
        data["tipo_solicitud"] = clean_text(data["tipo_solicitud"]).capitalize()
        assert_allowed(data["tipo_solicitud"], ALLOWED_TIPOS, "tipo_solicitud")

    if "prioridad" in data:
        data["prioridad"] = clean_text(data["prioridad"]).capitalize()
        assert_allowed(data["prioridad"], ALLOWED_PRIORIDADES, "prioridad")

    if "prioridad_sugerida_ia" in data:
        data["prioridad_sugerida_ia"] = clean_text(data["prioridad_sugerida_ia"]).capitalize()
        assert_allowed(data["prioridad_sugerida_ia"], ALLOWED_PRIORIDADES, "prioridad_sugerida_ia")

    if "prioridad_final" in data:
        data["prioridad_final"] = clean_text(data["prioridad_final"]).capitalize()
        assert_allowed(data["prioridad_final"], ALLOWED_PRIORIDADES, "prioridad")

    if "estado" in data:
        data["estado"] = clean_text(data["estado"])
        assert_allowed(data["estado"], ALLOWED_ESTADOS, "estado")

    if "modo" in data:
        assert_allowed(data["modo"], ALLOWED_MODOS, "modo")

    if "sucursal" in data:
        normalized = (
            clean_text(data["sucursal"])
            .replace("ó", "o")
            .replace("á", "a")
            .replace("Á", "A")
            .replace("Ó", "O")
        )
        match = next((item for item in ALLOWED_SUCURSALES if item.lower() == normalized.lower()), None)
        if not match:
            allowed = ", ".join(sorted(ALLOWED_SUCURSALES))
            raise HTTPException(status_code=422, detail=f"La sucursal debe ser una de estas opciones: {allowed}.")
        data["sucursal"] = match

    if "decision_chatbot" in data:
        normalized = clean_text(data["decision_chatbot"]).lower()
        assert_allowed(normalized, ALLOWED_CHATBOT_DECISIONS, "decision_chatbot")
        data["decision_chatbot"] = normalized

    if "resuelto_por" in data:
        normalized = clean_text(data["resuelto_por"]).lower()
        assert_allowed(normalized, ALLOWED_RESUELTO_POR, "resuelto_por")
        data["resuelto_por"] = normalized

    if "fase_experimento" in data:
        normalized = clean_text(data["fase_experimento"]).lower()
        assert_allowed(normalized, ALLOWED_EXPERIMENT_PHASES, "fase_experimento")
        data["fase_experimento"] = normalized

    if "fuente_respuesta" in data:
        normalized = clean_text(data["fuente_respuesta"]).lower()
        assert_allowed(normalized, ALLOWED_RAG_SOURCES, "fuente_respuesta")
        data["fuente_respuesta"] = normalized

    if "nivel_escalamiento" in data:
        normalized = clean_text(data["nivel_escalamiento"]).upper()
        assert_allowed(normalized, ALLOWED_ESCALATION_LEVELS, "nivel_escalamiento")
        data["nivel_escalamiento"] = normalized

    if "asunto" in data:
        subject = strip_html(data["asunto"])
        if not subject:
            raise HTTPException(status_code=422, detail="El asunto no puede estar vacío.")
        if len(subject) > MAX_ASUNTO_LENGTH:
            raise HTTPException(status_code=422, detail="El asunto supera la longitud máxima permitida.")
        data["asunto"] = normalize_capitalized(subject)

    if "categoria_sugerida_ia" in data:
        suggested = clean_text(data["categoria_sugerida_ia"])
        if suggested and suggested not in get_catalog_map():
            raise HTTPException(status_code=422, detail="La categoría sugerida por IA no es válida.")

    if "categoria_final" in data:
        final_category = clean_text(data["categoria_final"])
        if final_category and final_category not in get_catalog_map():
            raise HTTPException(status_code=422, detail="La categoría final no es válida.")

    if "descripcion_html" in data:
        if not strip_html(data["descripcion_html"]):
            raise HTTPException(status_code=422, detail="La descripción no puede estar vacía.")
        if len(data["descripcion_html"]) > MAX_HTML_LENGTH:
            raise HTTPException(status_code=422, detail="La descripción supera el máximo permitido.")

    if "resolucion_html" in data and data["resolucion_html"] and len(data["resolucion_html"]) > MAX_HTML_LENGTH:
        raise HTTPException(status_code=422, detail="La resolución supera el máximo permitido.")

    if not partial and data.get("estado") == "Resuelto" and not strip_html(data.get("resolucion_html", "")):
        raise HTTPException(status_code=422, detail="Debes escribir una resolución antes de marcar el ticket como resuelto.")

    catalog_fields = {"categoria", "subcategoria", "articulo"}
    if catalog_fields.issubset(data.keys()):
        validate_catalog_selection(data["categoria"], data["subcategoria"], data["articulo"])
    elif any(field in data for field in catalog_fields) and partial:
        raise HTTPException(status_code=422, detail="Categoría, subcategoría y artículo deben actualizarse juntos.")

    if "decision_chatbot" in data and data["decision_chatbot"] == "resolver":
        data.setdefault("fue_resuelto_en_chat", True)
        data.setdefault("fue_escalado", False)

    if "decision_chatbot" in data and data["decision_chatbot"] == "escalar":
        data.setdefault("fue_resuelto_en_chat", False)
        data.setdefault("fue_escalado", True)

    if "fue_resuelto_en_chat" in data and data["fue_resuelto_en_chat"]:
        data.setdefault("resuelto_por", "chatbot")

    if "categoria" in data:
        data.setdefault("categoria_final", data["categoria"])

    if "prioridad" in data:
        data.setdefault("prioridad_final", data["prioridad"])

    return data


def ensure_ticket(ticket_id: str):
    ticket_collection = require_collection(tickets_col, "tickets")
    if not ObjectId.is_valid(ticket_id):
        raise HTTPException(status_code=400, detail="El identificador del ticket no es válido.")
    ticket = ticket_collection.find_one({"_id": ObjectId(ticket_id)})
    if not ticket:
        raise HTTPException(status_code=404, detail="No se encontro el ticket solicitado.")
    ticket = apply_ticket_lifecycle(ticket_collection, ticket)
    return ticket_collection, ticket


def infer_attachment_content_type(filename: str, provided: Optional[str]) -> str:
    if provided:
        return provided
    guessed, _ = mimetypes.guess_type(filename)
    return guessed or "application/octet-stream"


async def save_attachments(ticket_id: str, files, existing_count: int):
    if existing_count + len(files) > MAX_ATTACHMENTS_PER_TICKET:
        raise HTTPException(status_code=422, detail=f"Solo se permiten {MAX_ATTACHMENTS_PER_TICKET} adjuntos por ticket.")

    ticket_dir = UPLOADS_DIR / ticket_id
    ticket_dir.mkdir(parents=True, exist_ok=True)
    attachments = []
    for file in files:
        content = await file.read()
        if not content:
            continue
        if len(content) > MAX_ATTACHMENT_SIZE:
            raise HTTPException(status_code=422, detail=f"El archivo {file.filename} supera el máximo de {MAX_ATTACHMENT_SIZE // (1024 * 1024)} MB.")

        extension = Path(file.filename or "").suffix
        stored_name = f"{utc_now().strftime('%Y%m%d%H%M%S')}_{secrets.token_hex(4)}{extension}"
        target = ticket_dir / stored_name
        target.write_bytes(content)

        attachments.append(
            {
                "id": secrets.token_hex(8),
                "original_name": file.filename or stored_name,
                "stored_name": stored_name,
                "content_type": infer_attachment_content_type(file.filename or stored_name, file.content_type),
                "size": len(content),
                "uploaded_at": utc_now(),
            }
        )
        await file.close()

    return attachments


def parse_date_filter(value: str | None, field_name: str) -> datetime | None:
    text = clean_text(value)
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"{field_name} debe tener formato YYYY-MM-DD.") from exc
    return ensure_utc_datetime(parsed.replace(hour=0, minute=0, second=0, microsecond=0))


def filter_tickets(
    tickets: list[dict[str, Any]],
    *,
    date_from: str | None = None,
    date_to: str | None = None,
    sucursal: str | None = None,
    tipo_solicitud: str | None = None,
    fase_experimento: str | None = None,
):
    start = parse_date_filter(date_from, "date_from")
    end = parse_date_filter(date_to, "date_to")
    if end:
        end = end + timedelta(days=1)

    filtered = []
    for ticket in tickets:
        created_at = ensure_utc_datetime(ticket.get("fecha_creacion"))
        if start and (created_at is None or created_at < start):
            continue
        if end and (created_at is None or created_at >= end):
            continue
        if sucursal and ticket.get("sucursal") != sucursal:
            continue
        if tipo_solicitud and ticket.get("tipo_solicitud") != tipo_solicitud:
            continue
        if fase_experimento and clean_text(ticket.get("fase_experimento")).lower() != clean_text(fase_experimento).lower():
            continue
        filtered.append(enrich_ticket_metrics(ticket))
    return filtered


def build_metrics(tickets):
    now = utc_now()
    metric_fields = ("solicitante", "modo", "prioridad", "categoria", "estado")
    by_metric = {field: {} for field in metric_fields}
    received_last_30 = []
    resolved_last_30 = []
    status_labels = []
    status_counters = {}

    for offset in range(29, -1, -1):
        day = (now - timedelta(days=offset)).date()
        key = day.isoformat()
        label = day.strftime("%d/%m")
        received_last_30.append({"date": key, "label": label, "count": 0})
        resolved_last_30.append({"date": key, "label": label, "count": 0})

    for offset in range(6, -1, -1):
        day = (now - timedelta(days=offset)).date()
        key = day.isoformat()
        status_labels.append({"date": key, "label": WEEKDAY_LABELS.get(day.weekday(), key)})
        status_counters[key] = {"Resuelto": 0, "Cerrado": 0}

    received_index = {item["date"]: item for item in received_last_30}
    resolved_index = {item["date"]: item for item in resolved_last_30}

    resolved_tickets = []
    fcr_total = 0
    escalated_total = 0
    resolved_by_chatbot_total = 0
    category_compared = 0
    category_hits = 0
    priority_compared = 0
    priority_hits = 0

    for ticket in tickets:
        ticket = enrich_ticket_metrics(ticket)
        for field in metric_fields:
            value = ticket.get(field) or "Sin definir"
            by_metric[field][value] = by_metric[field].get(value, 0) + 1

        created = ticket.get("fecha_creacion")
        if isinstance(created, datetime):
            key = created.date().isoformat()
            if key in received_index:
                received_index[key]["count"] += 1

        resolved_date = ticket.get("fecha_resolucion")
        if isinstance(resolved_date, datetime):
            key = resolved_date.date().isoformat()
            if key in resolved_index:
                resolved_index[key]["count"] += 1

        for entry in ticket.get("historial", []):
            if entry.get("event_type") != "status_change":
                continue
            new_status = entry.get("new_value")
            created_at = entry.get("created_at")
            if not isinstance(created_at, datetime):
                continue
            day_key = created_at.date().isoformat()
            if day_key in status_counters and new_status in {"Resuelto", "Cerrado"}:
                status_counters[day_key][new_status] += 1

        if ticket.get("fue_escalado"):
            escalated_total += 1

        if ticket.get("estado") in {"Resuelto", "Cerrado"}:
            resolved_tickets.append(ticket)
            if ticket.get("resuelto_por") == "chatbot":
                resolved_by_chatbot_total += 1
            if ticket.get("fcr"):
                fcr_total += 1

        if clean_text(ticket.get("categoria_sugerida_ia")) and clean_text(ticket.get("categoria_final")):
            category_compared += 1
            if ticket.get("categoria_sugerida_ia") == ticket.get("categoria_final"):
                category_hits += 1

        if clean_text(ticket.get("prioridad_sugerida_ia")) and clean_text(ticket.get("prioridad_final")):
            priority_compared += 1
            if ticket.get("prioridad_sugerida_ia") == ticket.get("prioridad_final"):
                priority_hits += 1

    average_resolution_seconds = None
    resolution_samples = [ticket.get("tiempo_resolucion_total") for ticket in resolved_tickets if ticket.get("tiempo_resolucion_total") is not None]
    if resolution_samples:
        average_resolution_seconds = round(sum(resolution_samples) / len(resolution_samples), 2)

    classification_samples = max(category_compared, priority_compared)
    combined_hits = category_hits + priority_hits
    combined_total = category_compared + priority_compared

    def summarize_subset(subset: list[dict[str, Any]]):
        resolved_subset = [item for item in subset if item.get("estado") in {"Resuelto", "Cerrado"}]
        resolution_values = [item.get("tiempo_resolucion_total") for item in resolved_subset if item.get("tiempo_resolucion_total") is not None]
        classification_pairs = [
            item for item in subset
            if clean_text(item.get("categoria_sugerida_ia")) and clean_text(item.get("categoria_final"))
        ]
        classification_hits_subset = sum(
            1 for item in classification_pairs if item.get("categoria_sugerida_ia") == item.get("categoria_final")
        )
        return {
            "total_tickets": len(subset),
            "resolved_tickets": len(resolved_subset),
            "average_resolution_seconds": round(sum(resolution_values) / len(resolution_values), 2) if resolution_values else None,
            "fcr_rate": round((sum(1 for item in resolved_subset if item.get("fcr")) / len(resolved_subset)) * 100, 2) if resolved_subset else None,
            "escalation_rate": round((sum(1 for item in subset if item.get("fue_escalado")) / len(subset)) * 100, 2) if subset else None,
            "chatbot_resolution_rate": round((sum(1 for item in resolved_subset if item.get("resuelto_por") == "chatbot") / len(resolved_subset)) * 100, 2) if resolved_subset else None,
            "classification_accuracy_rate": round((classification_hits_subset / len(classification_pairs)) * 100, 2) if classification_pairs else None,
        }

    phase_summary = {}
    for phase in ("pretest", "posttest"):
        subset = [ticket for ticket in tickets if clean_text(ticket.get("fase_experimento")).lower() == phase]
        phase_summary[phase] = summarize_subset(subset)

    return {
        "by_metric": by_metric,
        "received_last_30": received_last_30,
        "resolved_last_30": resolved_last_30,
        "status_last_7": [
            {
                "date": item["date"],
                "label": item["label"],
                "resueltos": status_counters[item["date"]]["Resuelto"],
                "cerrados": status_counters[item["date"]]["Cerrado"],
            }
            for item in status_labels
        ],
        "summary": {
            "total_tickets": len(tickets),
            "resolved_tickets": len(resolved_tickets),
            "average_resolution_seconds": average_resolution_seconds,
            "fcr_rate": round((fcr_total / len(resolved_tickets)) * 100, 2) if resolved_tickets else None,
            "escalation_rate": round((escalated_total / len(tickets)) * 100, 2) if tickets else None,
            "chatbot_resolution_rate": round((resolved_by_chatbot_total / len(resolved_tickets)) * 100, 2) if resolved_tickets else None,
            "classification_accuracy_rate": round((combined_hits / combined_total) * 100, 2) if combined_total else None,
            "category_accuracy_rate": round((category_hits / category_compared) * 100, 2) if category_compared else None,
            "priority_accuracy_rate": round((priority_hits / priority_compared) * 100, 2) if priority_compared else None,
            "classification_sample_size": classification_samples,
        },
        "phase_summary": phase_summary,
    }


def serialize_chat_interaction(interaction: dict[str, Any]):
    if not interaction:
        return None
    data = dict(interaction)
    data["_id"] = str(data["_id"])
    for field_name in ("tiempo_inicio_atencion", "created_at"):
        if data.get(field_name):
            data[field_name] = serialize_value(data[field_name])
    return serialize_value(data)


def validate_chat_interaction_payload(payload: dict[str, Any]):
    data = {}
    string_fields = {
        "session_id",
        "usuario",
        "mensaje_usuario",
        "respuesta_chatbot",
        "decision_chatbot",
        "razon_decision",
        "fase_experimento",
        "fuente_respuesta",
        "categoria_sugerida_ia",
        "prioridad_sugerida_ia",
        "ticket_id",
    }
    bool_fields = {"fue_resuelto_en_chat", "fue_escalado", "decision_validada", "usa_contexto_rag"}
    integer_fields = {"numero_interacciones"}
    float_fields = {"tiempo_respuesta_chatbot"}

    for key, value in payload.items():
        if key in string_fields:
            data[key] = clean_text(value)
        elif key in bool_fields:
            parsed = parse_boolish(value)
            if parsed is None:
                raise HTTPException(status_code=422, detail=f"{key} debe ser verdadero o falso.")
            data[key] = parsed
        elif key in integer_fields:
            data[key] = parse_numeric(value, key, integer=True)
        elif key in float_fields:
            data[key] = parse_numeric(value, key)
        elif key == "tiempo_inicio_atencion":
            data[key] = parse_datetimeish(value, key)

    if not clean_text(data.get("session_id")):
        raise HTTPException(status_code=422, detail="session_id es obligatorio para registrar la interacción.")

    if "decision_chatbot" in data:
        normalized = data["decision_chatbot"].lower()
        assert_allowed(normalized, ALLOWED_CHATBOT_DECISIONS, "decision_chatbot")
        data["decision_chatbot"] = normalized

    if "fase_experimento" in data:
        normalized = data["fase_experimento"].lower()
        assert_allowed(normalized, ALLOWED_EXPERIMENT_PHASES, "fase_experimento")
        data["fase_experimento"] = normalized

    if "fuente_respuesta" in data:
        normalized = data["fuente_respuesta"].lower()
        assert_allowed(normalized, ALLOWED_RAG_SOURCES, "fuente_respuesta")
        data["fuente_respuesta"] = normalized

    if "categoria_sugerida_ia" in data and data["categoria_sugerida_ia"]:
        catalog = get_catalog_map()
        if data["categoria_sugerida_ia"] not in catalog:
            raise HTTPException(status_code=422, detail="La categoría sugerida por IA no es válida.")

    if "prioridad_sugerida_ia" in data and data["prioridad_sugerida_ia"]:
        normalized = data["prioridad_sugerida_ia"].capitalize()
        assert_allowed(normalized, ALLOWED_PRIORIDADES, "prioridad_sugerida_ia")
        data["prioridad_sugerida_ia"] = normalized

    if data.get("decision_chatbot") == "resolver":
        data.setdefault("fue_resuelto_en_chat", True)
        data.setdefault("fue_escalado", False)
    elif data.get("decision_chatbot") == "escalar":
        data.setdefault("fue_resuelto_en_chat", False)
        data.setdefault("fue_escalado", True)

    data.setdefault("tiempo_inicio_atencion", utc_now())
    data.setdefault("numero_interacciones", 1)
    data.setdefault("usa_contexto_rag", False)
    data.setdefault("fuente_respuesta", "generativa")
    return data


@app.get("/health")
async def health_check():
    return {
        "status": "ok",
        "timestamp": utc_now(),
        "mongo_connected": tickets_col is not None and counters_col is not None,
    }


@app.get("/catalog/categories")
async def obtener_catalogo():
    return {"source": "servicedesk/categorias.json", "categories": get_catalog_map()}


@app.get("/catalog/entries")
async def obtener_catalogo_plano():
    entries = flatten_catalog(get_catalog_map())
    return {"count": len(entries), "entries": entries}


@app.get("/catalog/search")
async def buscar_en_catalogo(q: str = Query(..., min_length=2), limit: int = Query(10, ge=1, le=25)):
    matches = search_catalog_entries(q, get_catalog_map(), limit=limit)
    return {"query": q, "count": len(matches), "matches": matches}


@app.get("/repository/files")
async def listar_archivos_repositorio(q: str = Query("", max_length=100)):
    term = clean_text(q).lower()
    files = []
    for path in sorted(REPOSITORY_DIR.iterdir(), key=lambda item: item.stat().st_mtime, reverse=True):
        if not path.is_file():
            continue
        if term and term not in path.name.lower():
            continue
        files.append(serialize_repository_file(path))
    return {"count": len(files), "files": files}


@app.post("/extract/text")
async def extraer_texto_plano(request: Request):
    payload, files = await parse_request_payload(request)
    del payload
    if not files:
        raise HTTPException(status_code=422, detail="Debes adjuntar al menos un archivo.")

    results = []
    for file in files:
        content = await file.read()
        if not content:
            await file.close()
            continue
        if len(content) > MAX_REPOSITORY_FILE_SIZE:
            raise HTTPException(
                status_code=422,
                detail=f"El archivo {file.filename} supera el máximo de {MAX_REPOSITORY_FILE_SIZE // (1024 * 1024)} MB.",
            )
        extracted_text, source_type = extract_plain_text(file.filename or "", content)
        results.append(serialize_extracted_text(file.filename or "archivo", extracted_text, source_type))
        await file.close()

    if not results:
        raise HTTPException(status_code=422, detail="No se encontraron archivos válidos para procesar.")

    return {
        "count": len(results),
        "files": results,
    }


@app.post("/extract/text/by-name")
async def extraer_texto_plano_por_nombre(payload: RepositoryExtractionRequest):
    safe_name = sanitize_repository_filename(payload.file_name)
    target = REPOSITORY_DIR / safe_name
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="No se encontró el archivo solicitado.")

    content = target.read_bytes()
    extracted_text, source_type = extract_plain_text(target.name, content)
    result = serialize_extracted_text(target.name, extracted_text, source_type)
    return {
        "count": 1,
        "files": [result],
    }


@app.post("/repository/files", status_code=status.HTTP_201_CREATED)
async def subir_archivos_repositorio(request: Request):
    payload, files = await parse_request_payload(request)
    del payload
    if not files:
        raise HTTPException(status_code=422, detail="Debes adjuntar al menos un archivo.")

    saved_files = []
    for file in files:
        content = await file.read()
        if not content:
            await file.close()
            continue
        if len(content) > MAX_REPOSITORY_FILE_SIZE:
            raise HTTPException(
                status_code=422,
                detail=f"El archivo {file.filename} supera el máximo de {MAX_REPOSITORY_FILE_SIZE // (1024 * 1024)} MB.",
            )

        original_name = sanitize_repository_filename(file.filename or "")
        stored_name = original_name
        target = REPOSITORY_DIR / stored_name
        if target.exists():
            stored_name = f"{target.stem}_{utc_now().strftime('%Y%m%d%H%M%S')}{target.suffix}"
            target = REPOSITORY_DIR / stored_name

        target.write_bytes(content)
        saved_files.append(serialize_repository_file(target))
        await file.close()

    if not saved_files:
        raise HTTPException(status_code=422, detail="No se encontraron archivos válidos para subir.")

    return {"count": len(saved_files), "files": saved_files}


@app.delete("/repository/files/{file_name:path}")
async def eliminar_archivo_repositorio(file_name: str):
    safe_name = sanitize_repository_filename(file_name)
    target = REPOSITORY_DIR / safe_name
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="No se encontró el archivo solicitado.")
    target.unlink(missing_ok=True)
    return {"msg": "Archivo eliminado con éxito"}


def ensure_solution(solution_id: str):
    solution_collection = require_collection(solutions_col, "solutions")
    if not ObjectId.is_valid(solution_id):
        raise HTTPException(status_code=400, detail="El identificador de la solución no es válido.")
    solution = solution_collection.find_one({"_id": ObjectId(solution_id)})
    if not solution:
        raise HTTPException(status_code=404, detail="No se encontró la solución solicitada.")
    return solution_collection, solution


def serialize_solution(solution):
    if not solution:
        return None
    data = dict(solution)
    data["_id"] = str(data["_id"])
    for field_name in ("created_at", "updated_at"):
        if data.get(field_name):
            data[field_name] = serialize_value(data[field_name])
    return data


def validate_solution_payload(payload: dict[str, Any], partial: bool = False):
    data = {}
    for field_name in ("titulo", "carpeta", "descripcion_html"):
        if field_name in payload:
            data[field_name] = clean_text(payload.get(field_name))

    required_fields = {"titulo", "descripcion_html"}
    if not partial:
        missing = [field for field in required_fields if not clean_text(data.get(field))]
        if missing:
            readable_map = {
                "titulo": "el título",
                "descripcion_html": "la descripción",
            }
            readable = ", ".join(readable_map.get(field, field) for field in missing)
            raise HTTPException(status_code=422, detail=f"Completa estos campos antes de continuar: {readable}.")

    if "titulo" in data:
        title = strip_html(data["titulo"])
        if len(title) < 4:
            raise HTTPException(status_code=422, detail="El título debe tener al menos 4 caracteres.")
        if len(title) > MAX_KNOWLEDGE_TITLE_LENGTH:
            raise HTTPException(status_code=422, detail="El título supera la longitud máxima permitida.")
        data["titulo"] = normalize_capitalized(title)

    if "carpeta" in data:
        folder = strip_html(data["carpeta"])
        if folder and len(folder) < 2:
            raise HTTPException(status_code=422, detail="La carpeta debe tener al menos 2 caracteres.")
        data["carpeta"] = normalize_capitalized(folder) if folder else ""

    if "descripcion_html" in data:
        if not strip_html(data["descripcion_html"]):
            raise HTTPException(status_code=422, detail="La descripción no puede estar vacía.")
        if len(data["descripcion_html"]) > MAX_HTML_LENGTH:
            raise HTTPException(status_code=422, detail="La descripción supera el máximo permitido.")

    return data


@app.get("/solutions")
async def listar_soluciones(q: str = Query("", max_length=120), carpeta: str = Query("", max_length=120)):
    solution_collection = require_collection(solutions_col, "solutions")
    term = clean_text(q).lower()
    folder_filter = normalize_capitalized(carpeta) if clean_text(carpeta) else ""
    solutions = []
    for solution in solution_collection.find().sort("updated_at", -1):
        if term:
            haystack = " ".join(
                [
                    str(solution.get("titulo", "")),
                    str(solution.get("carpeta", "")),
                    strip_html(str(solution.get("descripcion_html", ""))),
                ]
            ).lower()
            if term not in haystack:
                continue
        if folder_filter and solution.get("carpeta") != folder_filter:
            continue
        solutions.append(serialize_solution(solution))
    folders = sorted({solution.get("carpeta", "General") for solution in solution_collection.find() if solution.get("carpeta")})
    return {"count": len(solutions), "items": solutions, "folders": folders}


@app.get("/solutions/{solution_id}")
async def obtener_solucion(solution_id: str):
    _, solution = ensure_solution(solution_id)
    return serialize_solution(solution)


@app.post("/solutions", status_code=status.HTTP_201_CREATED)
async def crear_solucion(payload: KnowledgeBaseSchema):
    solution_collection = require_collection(solutions_col, "solutions")
    validated = validate_solution_payload(payload.model_dump(), partial=False)
    now = utc_now()
    new_solution = {
        **validated,
        "created_at": now,
        "updated_at": now,
    }

    result = solution_collection.insert_one(new_solution)
    created = solution_collection.find_one({"_id": result.inserted_id})
    return serialize_solution(created)


@app.put("/solutions/{solution_id}")
async def actualizar_solucion(solution_id: str, payload: KnowledgeBaseSchema):
    solution_collection, _ = ensure_solution(solution_id)
    validated = validate_solution_payload(payload.model_dump(), partial=False)
    validated["updated_at"] = utc_now()
    solution_collection.update_one({"_id": ObjectId(solution_id)}, {"$set": validated})
    updated = solution_collection.find_one({"_id": ObjectId(solution_id)})
    return serialize_solution(updated)


@app.delete("/solutions/{solution_id}")
async def eliminar_solucion(solution_id: str):
    solution_collection, _ = ensure_solution(solution_id)
    result = solution_collection.delete_one({"_id": ObjectId(solution_id)})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="No se encontró la solución solicitada.")
    return {"msg": "Solución eliminada con éxito"}


@app.get("/chat/interactions")
async def listar_interacciones_chat(
    date_from: str = Query("", max_length=20),
    date_to: str = Query("", max_length=20),
    fase_experimento: str = Query("", max_length=20),
):
    interaction_collection = require_collection(chat_interactions_col, "chat_interactions")
    start = parse_date_filter(date_from, "date_from")
    end = parse_date_filter(date_to, "date_to")
    if end:
        end = end + timedelta(days=1)

    items = []
    for interaction in interaction_collection.find().sort("created_at", -1):
        created_at = ensure_utc_datetime(interaction.get("created_at"))
        if start and (created_at is None or created_at < start):
            continue
        if end and (created_at is None or created_at >= end):
            continue
        if fase_experimento and clean_text(interaction.get("fase_experimento")).lower() != clean_text(fase_experimento).lower():
            continue
        items.append(serialize_chat_interaction(interaction))
    return {"count": len(items), "items": items}


@app.post("/chat/interactions", status_code=status.HTTP_201_CREATED)
async def registrar_interaccion_chat(payload: dict[str, Any]):
    interaction_collection = require_collection(chat_interactions_col, "chat_interactions")
    validated = validate_chat_interaction_payload(payload)
    document = {
        **validated,
        "created_at": utc_now(),
    }
    result = interaction_collection.insert_one(document)
    created = interaction_collection.find_one({"_id": result.inserted_id})
    return serialize_chat_interaction(created)


@app.get("/tickets")
async def listar(
    date_from: str = Query("", max_length=20),
    date_to: str = Query("", max_length=20),
    sucursal: str = Query("", max_length=40),
    tipo_solicitud: str = Query("", max_length=40),
    fase_experimento: str = Query("", max_length=20),
):
    ticket_collection = require_collection(tickets_col, "tickets")
    cursor = ticket_collection.find().sort("fecha_creacion", -1)
    tickets = [apply_ticket_lifecycle(ticket_collection, ticket) for ticket in cursor]
    filtered = filter_tickets(
        tickets,
        date_from=date_from,
        date_to=date_to,
        sucursal=sucursal,
        tipo_solicitud=tipo_solicitud,
        fase_experimento=fase_experimento,
    )
    return [serialize(ticket) for ticket in filtered]


@app.get("/tickets/metrics")
async def obtener_metricas(
    date_from: str = Query("", max_length=20),
    date_to: str = Query("", max_length=20),
    sucursal: str = Query("", max_length=40),
    tipo_solicitud: str = Query("", max_length=40),
    fase_experimento: str = Query("", max_length=20),
):
    ticket_collection = require_collection(tickets_col, "tickets")
    tickets = [apply_ticket_lifecycle(ticket_collection, ticket) for ticket in ticket_collection.find()]
    filtered = filter_tickets(
        tickets,
        date_from=date_from,
        date_to=date_to,
        sucursal=sucursal,
        tipo_solicitud=tipo_solicitud,
        fase_experimento=fase_experimento,
    )
    metrics = build_metrics(filtered)
    metrics["filters"] = {
        "date_from": date_from or None,
        "date_to": date_to or None,
        "sucursal": sucursal or None,
        "tipo_solicitud": tipo_solicitud or None,
        "fase_experimento": fase_experimento or None,
    }
    return metrics


@app.get("/tickets/export")
async def exportar_tickets(
    format: str = Query("csv", pattern="^(csv)$"),
    date_from: str = Query("", max_length=20),
    date_to: str = Query("", max_length=20),
    sucursal: str = Query("", max_length=40),
    tipo_solicitud: str = Query("", max_length=40),
    fase_experimento: str = Query("", max_length=20),
):
    del format
    ticket_collection = require_collection(tickets_col, "tickets")
    tickets = [apply_ticket_lifecycle(ticket_collection, ticket) for ticket in ticket_collection.find()]
    filtered = filter_tickets(
        tickets,
        date_from=date_from,
        date_to=date_to,
        sucursal=sucursal,
        tipo_solicitud=tipo_solicitud,
        fase_experimento=fase_experimento,
    )

    rows = []
    for ticket in filtered:
        item = serialize(ticket)
        rows.append(
            {
                "ID_ITIL": item.get("ID-ITIL"),
                "solicitante": item.get("solicitante"),
                "tipo_solicitud": item.get("tipo_solicitud"),
                "sucursal": item.get("sucursal"),
                "estado": item.get("estado"),
                "prioridad": item.get("prioridad"),
                "prioridad_sugerida_ia": item.get("prioridad_sugerida_ia"),
                "prioridad_final": item.get("prioridad_final"),
                "categoria": item.get("categoria"),
                "categoria_sugerida_ia": item.get("categoria_sugerida_ia"),
                "categoria_final": item.get("categoria_final"),
                "decision_chatbot": item.get("decision_chatbot"),
                "razon_decision": item.get("razon_decision"),
                "decision_validada": item.get("decision_validada"),
                "fue_resuelto_en_chat": item.get("fue_resuelto_en_chat"),
                "fue_escalado": item.get("fue_escalado"),
                "resuelto_por": item.get("resuelto_por"),
                "fcr": item.get("fcr"),
                "numero_interacciones": item.get("numero_interacciones"),
                "numero_interacciones_previas": item.get("numero_interacciones_previas"),
                "tiempo_inicio_atencion": item.get("tiempo_inicio_atencion"),
                "tiempo_respuesta_chatbot": item.get("tiempo_respuesta_chatbot"),
                "tiempo_creacion_ticket": item.get("tiempo_creacion_ticket"),
                "tiempo_resolucion_total": item.get("tiempo_resolucion_total"),
                "fase_experimento": item.get("fase_experimento"),
                "usa_contexto_rag": item.get("usa_contexto_rag"),
                "fuente_respuesta": item.get("fuente_respuesta"),
                "fecha_creacion": item.get("fecha_creacion"),
                "fecha_actualizacion": item.get("fecha_actualizacion"),
                "fecha_resolucion": item.get("fecha_resolucion"),
                "asunto": item.get("asunto"),
            }
        )

    buffer = io.StringIO()
    fieldnames = list(rows[0].keys()) if rows else [
        "ID_ITIL",
        "solicitante",
        "tipo_solicitud",
        "sucursal",
        "estado",
        "prioridad",
        "prioridad_sugerida_ia",
        "prioridad_final",
        "categoria",
        "categoria_sugerida_ia",
        "categoria_final",
        "decision_chatbot",
        "razon_decision",
        "decision_validada",
        "fue_resuelto_en_chat",
        "fue_escalado",
        "resuelto_por",
        "fcr",
        "numero_interacciones",
        "numero_interacciones_previas",
        "tiempo_inicio_atencion",
        "tiempo_respuesta_chatbot",
        "tiempo_creacion_ticket",
        "tiempo_resolucion_total",
        "fase_experimento",
        "usa_contexto_rag",
        "fuente_respuesta",
        "fecha_creacion",
        "fecha_actualizacion",
        "fecha_resolucion",
        "asunto",
    ]
    writer = csv.DictWriter(buffer, fieldnames=fieldnames)
    writer.writeheader()
    writer.writerows(rows)
    file_name = f"tickets_tesis_{utc_now().strftime('%Y%m%d_%H%M%S')}.csv"
    headers = {"Content-Disposition": f'attachment; filename="{file_name}"'}
    return Response(content=buffer.getvalue(), media_type="text/csv; charset=utf-8", headers=headers)



@app.get("/tickets/{id}")
async def obtener_ticket(id: str):
    _, ticket = ensure_ticket(id)
    return serialize(ticket)


@app.post("/tickets", status_code=status.HTTP_201_CREATED)
async def crear_ticket(request: Request):
    ticket_collection = require_collection(tickets_col, "tickets")
    payload, files = await parse_request_payload(request)
    validated = validate_ticket_payload(payload, partial=False)
    for field_name in SYSTEM_MANAGED_CREATE_FIELDS:
        validated.pop(field_name, None)
    if strip_html(validated.get("resolucion_html", "")):
        validated["estado"] = "Resuelto"

    now = utc_now()
    new_ticket = {
        **validated,
        "fecha_creacion": now,
        "fecha_actualizacion": now,
        "fecha_resolucion": now if validated["estado"] in {"Resuelto", "Cerrado"} else None,
        "tiempo_inicio_atencion": validated.get("tiempo_inicio_atencion", now),
        "tiempo_creacion_ticket": now,
        "numero_interacciones": int(validated.get("numero_interacciones") or 0),
        "numero_interacciones_previas": int(
            validated.get("numero_interacciones_previas") or validated.get("numero_interacciones") or 0
        ),
        "decision_chatbot": validated.get("decision_chatbot"),
        "fue_resuelto_en_chat": bool(validated.get("fue_resuelto_en_chat", False)),
        "fue_escalado": bool(validated.get("fue_escalado", validated.get("decision_chatbot") == "escalar")),
        "resuelto_por": validated.get("resuelto_por"),
        "categoria_sugerida_ia": validated.get("categoria_sugerida_ia") or validated.get("categoria"),
        "categoria_final": validated.get("categoria_final") or validated.get("categoria"),
        "prioridad_sugerida_ia": validated.get("prioridad_sugerida_ia") or validated.get("prioridad"),
        "prioridad_final": validated.get("prioridad_final") or validated.get("prioridad"),
        "razon_decision": validated.get("razon_decision"),
        "decision_validada": validated.get("decision_validada"),
        "fase_experimento": validated.get("fase_experimento") or "posttest",
        "usa_contexto_rag": bool(validated.get("usa_contexto_rag", False)),
        "fuente_respuesta": validated.get("fuente_respuesta") or "generativa",
        "nivel_escalamiento": validated.get("nivel_escalamiento") or "N1",
        "ID-ITIL": get_next_sequence(validated["tipo_solicitud"]),
        "adjuntos": [],
        "comentarios": [],
        "historial": [
            history_entry("created", "Ticket creado", actor=validated["solicitante"], estado=validated["estado"])
        ],
    }
    new_ticket["resuelto_por"] = infer_resolved_by(new_ticket)
    new_ticket["tiempo_resolucion_total"] = calculate_resolution_seconds(new_ticket)
    new_ticket["fcr"] = calculate_fcr(new_ticket)

    result = ticket_collection.insert_one(new_ticket)
    ticket_id = str(result.inserted_id)

    attachments = await save_attachments(ticket_id, files, 0)
    if attachments:
        ticket_collection.update_one(
            {"_id": result.inserted_id},
            {
                "$push": {
                    "adjuntos": {"$each": attachments},
                    "historial": {
                        "$each": [
                            history_entry("attachment", f"Se adjuntaron {len(attachments)} archivo(s)", actor=validated["solicitante"])
                        ]
                    },
                },
                "$set": {"fecha_actualizacion": utc_now()},
            },
        )

    created_ticket = ticket_collection.find_one({"_id": result.inserted_id})
    return serialize(created_ticket)


@app.put("/tickets/{id}")
async def actualizar(id: str, request: Request):
    ticket_collection, existing = ensure_ticket(id)
    payload, files = await parse_request_payload(request)
    validated = validate_ticket_payload(payload, partial=True)
    for field_name in IMMUTABLE_UPDATE_FIELDS:
        validated.pop(field_name, None)
    incoming_resolution = validated.get("resolucion_html")
    resolution_changed = incoming_resolution is not None and incoming_resolution != existing.get("resolucion_html", "")

    if existing.get("estado") == "Cerrado":
        changed_fields = {
            field_name
            for field_name, new_value in validated.items()
            if field_name != "estado" and existing.get(field_name) != new_value
        }
        if files:
            raise HTTPException(status_code=422, detail="El ticket está cerrado. Primero cámbialo a Resuelto para adjuntar archivos.")
        if changed_fields:
            raise HTTPException(status_code=422, detail="El ticket está cerrado. Solo puedes cambiar su estado a Resuelto.")
        if "estado" in validated and validated["estado"] != REOPENABLE_STATUS:
            raise HTTPException(status_code=422, detail="Un ticket cerrado solo puede volver a Resuelto.")

    if existing.get("estado") != "Cerrado" and resolution_changed and strip_html(validated.get("resolucion_html", "")):
        validated["estado"] = "Resuelto"

    final_estado = validated.get("estado", existing.get("estado"))
    final_resolucion = validated.get("resolucion_html", existing.get("resolucion_html", ""))
    if final_estado == "Resuelto" and not strip_html(final_resolucion):
        raise HTTPException(status_code=422, detail="Debes escribir una resolución antes de marcar el ticket como resuelto.")

    if not validated and not files:
        return serialize(existing)

    update_data = dict(validated)
    history_events = []
    actor = update_data.get("solicitante") or existing.get("solicitante", "Sistema")

    if "tipo_solicitud" in update_data and update_data["tipo_solicitud"] != existing.get("tipo_solicitud"):
        update_data["ID-ITIL"] = get_next_sequence(update_data["tipo_solicitud"])
        history_events.append(
            history_entry(
                "field_change",
                "Tipo de solicitud actualizado",
                actor=actor,
                field="tipo_solicitud",
                old_value=existing.get("tipo_solicitud"),
                new_value=update_data["tipo_solicitud"],
            )
        )

    for field_name, new_value in update_data.items():
        old_value = existing.get(field_name)
        if old_value == new_value:
            continue
        if field_name == "estado":
            history_events.append(
                history_entry(
                    "status_change",
                    f"Estado actualizado a {new_value}",
                    actor=actor,
                    old_value=old_value,
                    new_value=new_value,
                )
            )
        elif field_name not in {"descripcion_html", "resolucion_html", "tipo_solicitud"}:
            history_events.append(
                history_entry(
                    "field_change",
                    f"{field_name} actualizado",
                    actor=actor,
                    field=field_name,
                    old_value=old_value,
                    new_value=new_value,
                )
            )

    if "estado" in update_data:
        if update_data["estado"] == "Resuelto":
            if existing.get("estado") != "Resuelto" or not existing.get("fecha_resolucion"):
                update_data["fecha_resolucion"] = utc_now()
        elif update_data["estado"] == "Cerrado":
            if not existing.get("fecha_resolucion"):
                update_data["fecha_resolucion"] = utc_now()
        else:
            update_data["fecha_resolucion"] = None

    if {"categoria", "categoria_final"} & update_data.keys():
        update_data["categoria_final"] = update_data.get("categoria_final") or update_data.get("categoria") or existing.get("categoria")

    if {"prioridad", "prioridad_final"} & update_data.keys():
        update_data["prioridad_final"] = update_data.get("prioridad_final") or update_data.get("prioridad") or existing.get("prioridad")

    attachments = await save_attachments(id, files, len(existing.get("adjuntos", [])))
    if attachments:
        history_events.append(
            history_entry("attachment", f"Se adjuntaron {len(attachments)} archivo(s)", actor=actor)
        )

    update_data["fecha_actualizacion"] = utc_now()

    merged_ticket = {**existing, **update_data}
    update_data["resuelto_por"] = infer_resolved_by(merged_ticket)
    update_data["tiempo_resolucion_total"] = calculate_resolution_seconds({**merged_ticket, **update_data})
    update_data["fcr"] = calculate_fcr({**merged_ticket, "historial": existing.get("historial", []) + history_events, **update_data})

    update_operation = {"$set": update_data}
    if attachments or history_events:
        update_operation["$push"] = {}
        if attachments:
            update_operation["$push"]["adjuntos"] = {"$each": attachments}
        if history_events:
            update_operation["$push"]["historial"] = {"$each": history_events}

    ticket_collection.update_one({"_id": ObjectId(id)}, update_operation)
    updated_ticket = ticket_collection.find_one({"_id": ObjectId(id)})
    return serialize(updated_ticket)


@app.post("/tickets/{id}/comments")
async def agregar_comentario(id: str, comment: TicketCommentSchema):
    ticket_collection, ticket = ensure_ticket(id)
    if ticket.get("estado") == "Cerrado":
        raise HTTPException(status_code=422, detail="El ticket está cerrado. Cámbialo a Resuelto antes de agregar comentarios.")
    autor = normalize_title_case(comment.autor)
    comentario_html = comment.comentario_html.strip()
    if not strip_html(comentario_html):
        raise HTTPException(status_code=422, detail="El comentario no puede estar vacío.")

    comment_entry = {
        "id": secrets.token_hex(8),
        "autor": autor,
        "comentario_html": comentario_html,
        "created_at": utc_now(),
    }
    ticket_collection.update_one(
        {"_id": ObjectId(id)},
        {
            "$push": {
                "comentarios": comment_entry,
                "historial": {
                    "$each": [history_entry("comment", "Nuevo comentario registrado", actor=autor)]
                },
            },
            "$set": {"fecha_actualizacion": utc_now()},
        },
    )
    updated_ticket = ticket_collection.find_one({"_id": ObjectId(id)})
    return serialize(updated_ticket)


@app.delete("/tickets/{id}/comments/{comment_id}")
async def eliminar_comentario(id: str, comment_id: str):
    ticket_collection, ticket = ensure_ticket(id)
    if ticket.get("estado") == "Cerrado":
        raise HTTPException(status_code=422, detail="El ticket está cerrado. Cámbialo a Resuelto antes de eliminar comentarios.")
    comments = list(ticket.get("comentarios", []))
    comment_to_remove = next((item for item in comments if item.get("id") == comment_id), None)
    if not comment_to_remove:
        raise HTTPException(status_code=404, detail="No se encontró el comentario solicitado.")

    remaining_comments = [item for item in comments if item.get("id") != comment_id]
    autor = comment_to_remove.get("autor") or ticket.get("solicitante", "Sistema")
    history_events = list(ticket.get("historial", []))
    history_events.append(
        history_entry(
            "comment_deleted",
            "Comentario eliminado",
            actor=autor,
            comment_id=comment_id,
        )
    )

    ticket_collection.update_one(
        {"_id": ObjectId(id)},
        {
            "$set": {
                "comentarios": remaining_comments,
                "historial": history_events,
                "fecha_actualizacion": utc_now(),
            }
        },
    )
    updated_ticket = ticket_collection.find_one({"_id": ObjectId(id)})
    return serialize(updated_ticket)


@app.delete("/tickets/{id}")
async def eliminar(id: str):
    ticket_collection, existing = ensure_ticket(id)
    ticket_path = UPLOADS_DIR / id
    if ticket_path.exists():
        for child in ticket_path.iterdir():
            child.unlink(missing_ok=True)
        ticket_path.rmdir()

    result = ticket_collection.delete_one({"_id": ObjectId(id)})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="No se encontro el ticket solicitado.")

    logger.info(f"Ticket eliminado: {existing.get('ID-ITIL')}")
    return {"msg": "Ticket eliminado con éxito"}
