import html
import logging
import mimetypes
import os
import re
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

from bson import ObjectId
from fastapi import FastAPI, HTTPException, Query, Request, status
from fastapi.middleware.cors import CORSMiddleware
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
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=UPLOADS_DIR), name="uploads")

ALLOWED_TIPOS = {"Requerimiento", "Incidente"}
ALLOWED_PRIORIDADES = {"Alta", "Normal", "Baja"}
ALLOWED_ESTADOS = {"Abierto", "Asignado", "En espera", "En progreso", "Resuelto", "Cerrado"}
ALLOWED_MODOS = {"Chat", "Email", "Mobile App", "Phone Call", "Web Form"}
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
}

client = None
db = None
tickets_col = None
counters_col = None


def connect_to_mongo():
    global client, db, tickets_col, counters_col

    mongo_uri = os.getenv("MONGO_URI", "mongodb://admin:admin123@mongo:27017/")
    try:
        client = MongoClient(mongo_uri, serverSelectionTimeoutMS=5000)
        client.server_info()
        db = client["servicedesk"]
        tickets_col = db["tickets"]
        counters_col = db["counters"]
        logger.info("Conexión a MongoDB establecida exitosamente.")
    except Exception as exc:
        client = None
        db = None
        tickets_col = None
        counters_col = None
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


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def ensure_utc_datetime(value: datetime | None) -> datetime | None:
    if not isinstance(value, datetime):
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def require_collection(collection, resource_name: str):
    global tickets_col, counters_col
    if collection is None:
        connect_to_mongo()
        if resource_name == "tickets":
            collection = tickets_col
        elif resource_name == "counters":
            collection = counters_col
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


def apply_ticket_lifecycle(ticket_collection, ticket):
    if not ticket:
        return ticket

    resolved_at = ensure_utc_datetime(ticket.get("fecha_resolucion"))
    if ticket.get("estado") != "Resuelto" or resolved_at is None:
        return ticket

    if utc_now() - resolved_at < AUTO_CLOSE_AFTER:
        return ticket

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
    return ticket_collection.find_one({"_id": ticket["_id"]}) or ticket


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


def serialize_attachment(ticket_id: str, attachment: dict):
    data = dict(attachment)
    data["uploaded_at"] = serialize_value(data.get("uploaded_at"))
    data["url"] = build_attachment_url(ticket_id, data["stored_name"])
    return data


def serialize(ticket):
    if not ticket:
        return None

    ticket = dict(ticket)
    ticket_id = str(ticket["_id"])
    ticket["_id"] = ticket_id
    for field_name in ("fecha_creacion", "fecha_actualizacion", "fecha_resolucion"):
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
    }
    aliases = {"resolucion": "resolucion_html"}

    for original_key, value in payload.items():
        key = aliases.get(original_key, original_key)
        if key in text_fields:
            data[key] = clean_text(value)

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

    if "asunto" in data:
        subject = strip_html(data["asunto"])
        if not subject:
            raise HTTPException(status_code=422, detail="El asunto no puede estar vacío.")
        if len(subject) > MAX_ASUNTO_LENGTH:
            raise HTTPException(status_code=422, detail="El asunto supera la longitud máxima permitida.")
        data["asunto"] = normalize_capitalized(subject)

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

    for ticket in tickets:
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
    }


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


@app.get("/tickets")
async def listar():
    ticket_collection = require_collection(tickets_col, "tickets")
    cursor = ticket_collection.find().sort("fecha_creacion", -1)
    return [serialize(apply_ticket_lifecycle(ticket_collection, ticket)) for ticket in cursor]


@app.get("/tickets/metrics")
async def obtener_metricas():
    ticket_collection = require_collection(tickets_col, "tickets")
    tickets = [apply_ticket_lifecycle(ticket_collection, ticket) for ticket in ticket_collection.find()]
    return build_metrics(tickets)


@app.get("/tickets/{id}")
async def obtener_ticket(id: str):
    _, ticket = ensure_ticket(id)
    return serialize(ticket)


@app.post("/tickets", status_code=status.HTTP_201_CREATED)
async def crear_ticket(request: Request):
    ticket_collection = require_collection(tickets_col, "tickets")
    payload, files = await parse_request_payload(request)
    validated = validate_ticket_payload(payload, partial=False)
    if strip_html(validated.get("resolucion_html", "")):
        validated["estado"] = "Resuelto"

    now = utc_now()
    new_ticket = {
        **validated,
        "fecha_creacion": now,
        "fecha_actualizacion": now,
        "fecha_resolucion": now if validated["estado"] in {"Resuelto", "Cerrado"} else None,
        "ID-ITIL": get_next_sequence(validated["tipo_solicitud"]),
        "adjuntos": [],
        "comentarios": [],
        "historial": [
            history_entry("created", "Ticket creado", actor=validated["solicitante"], estado=validated["estado"])
        ],
    }

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

    attachments = await save_attachments(id, files, len(existing.get("adjuntos", [])))
    if attachments:
        history_events.append(
            history_entry("attachment", f"Se adjuntaron {len(attachments)} archivo(s)", actor=actor)
        )

    update_data["fecha_actualizacion"] = utc_now()

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
