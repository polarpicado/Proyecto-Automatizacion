from pathlib import Path
import sys
from datetime import timedelta
from tempfile import TemporaryDirectory
import unittest
import io
import zipfile

from bson import ObjectId
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main


class FakeCursor:
    def __init__(self, documents):
        self.documents = list(documents)

    def __iter__(self):
        return iter(self.documents)

    def sort(self, field, direction):
        reverse = direction == -1
        return sorted(self.documents, key=lambda item: item.get(field), reverse=reverse)


class FakeTicketsCollection:
    def __init__(self):
        self.documents = {}

    def insert_one(self, document):
        new_document = dict(document)
        new_document["_id"] = ObjectId()
        self.documents[str(new_document["_id"])] = new_document

        class Result:
            inserted_id = new_document["_id"]

        return Result()

    def find_one(self, query):
        for document in self.documents.values():
            if all(document.get(key) == value for key, value in query.items()):
                return document
        return None

    def find(self):
        return FakeCursor(self.documents.values())

    def update_one(self, query, update):
        document = self.documents.get(str(query["_id"]))
        if not document:
            return
        if "$set" in update:
            document.update(update["$set"])
        if "$push" in update:
            for key, value in update["$push"].items():
                document.setdefault(key, [])
                if isinstance(value, dict) and "$each" in value:
                    document[key].extend(value["$each"])
                else:
                    document[key].append(value)

    def delete_one(self, query):
        deleted = self.documents.pop(str(query["_id"]), None)

        class Result:
            deleted_count = 1 if deleted else 0

        return Result()


class FakeCountersCollection:
    def __init__(self):
        self.counters = {}

    def find_one_and_update(self, query, update, upsert=False, return_document=None):
        key = query["_id"]
        current = self.counters.get(key, {"_id": key, "seq": 0})
        current["seq"] += update["$inc"]["seq"]
        self.counters[key] = current
        return current


class ApiTestCase(unittest.TestCase):
    def setUp(self):
        main.tickets_col = FakeTicketsCollection()
        main.counters_col = FakeCountersCollection()
        main.solutions_col = FakeTicketsCollection()
        main.chat_interactions_col = FakeTicketsCollection()
        self.temp_repository = TemporaryDirectory()
        main.REPOSITORY_DIR = Path(self.temp_repository.name)
        main.REPOSITORY_DIR.mkdir(parents=True, exist_ok=True)
        self.client = TestClient(main.app)
        self.valid_payload = {
            "solicitante": "usuario prueba",
            "tipo_solicitud": "Incidente",
            "prioridad": "Alta",
            "estado": "Abierto",
            "modo": "Chat",
            "sucursal": "Surquillo",
            "categoria": "TI - SOPORTE HARDWARE",
            "subcategoria": "PERIFERICOS",
            "articulo": "CAMBIO DE MOUSE",
            "asunto": "mouse falla",
            "descripcion_html": "<p>detalle</p>",
            "resolucion_html": ""
        }

    def tearDown(self):
        self.temp_repository.cleanup()

    def test_health_endpoint_is_available(self):
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertIn("mongo_connected", response.json())

    def test_create_ticket_assigns_itil_code(self):
        response = self.client.post("/tickets", json=self.valid_payload)
        self.assertEqual(response.status_code, 201)
        data = response.json()
        self.assertTrue(data["ID-ITIL"].startswith("INC-"))
        self.assertEqual(data["solicitante"], "Usuario Prueba")
        self.assertEqual(len(data["historial"]), 1)

    def test_invalid_priority_is_rejected(self):
        payload = dict(self.valid_payload)
        payload["prioridad"] = "Urgente"
        response = self.client.post("/tickets", json=payload)
        self.assertEqual(response.status_code, 422)

    def test_update_tipo_regenerates_itil_code(self):
        created = self.client.post("/tickets", json=self.valid_payload).json()
        response = self.client.put(
            f"/tickets/{created['_id']}",
            json={"tipo_solicitud": "Requerimiento"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["ID-ITIL"].startswith("RQ-"))

    def test_resolved_status_requires_resolution(self):
        payload = dict(self.valid_payload)
        payload["estado"] = "Resuelto"
        response = self.client.post("/tickets", json=payload)
        self.assertEqual(response.status_code, 422)

    def test_resolution_update_forces_ticket_to_resolved(self):
        created = self.client.post("/tickets", json=self.valid_payload).json()
        response = self.client.put(
            f"/tickets/{created['_id']}",
            json={"resolucion_html": "<p>Listo</p>"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["estado"], "Resuelto")

    def test_closed_ticket_only_allows_returning_to_resolved(self):
        payload = dict(self.valid_payload)
        payload["estado"] = "Resuelto"
        payload["resolucion_html"] = "<p>Listo</p>"
        created = self.client.post("/tickets", json=payload).json()
        main.tickets_col.documents[created["_id"]]["estado"] = "Cerrado"

        blocked = self.client.put(
            f"/tickets/{created['_id']}",
            json={"asunto": "Cambio bloqueado"},
        )
        self.assertEqual(blocked.status_code, 422)

        reopened = self.client.put(
            f"/tickets/{created['_id']}",
            json={"estado": "Resuelto"},
        )
        self.assertEqual(reopened.status_code, 200)
        self.assertEqual(reopened.json()["estado"], "Resuelto")

    def test_resolved_ticket_auto_closes_after_one_week(self):
        payload = dict(self.valid_payload)
        payload["estado"] = "Resuelto"
        payload["resolucion_html"] = "<p>Listo</p>"
        created = self.client.post("/tickets", json=payload).json()
        document = main.tickets_col.documents[created["_id"]]
        document["fecha_resolucion"] = main.utc_now() - timedelta(days=8)

        response = self.client.get(f"/tickets/{created['_id']}")

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["estado"], "Cerrado")
        self.assertTrue(any(entry.get("new_value") == "Cerrado" for entry in data["historial"]))

    def test_add_comment_appends_tracking(self):
        created = self.client.post("/tickets", json=self.valid_payload).json()
        response = self.client.post(
            f"/tickets/{created['_id']}/comments",
            json={"autor": "tecnico", "comentario_html": "<p>Comentario tecnico</p>"},
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(len(data["comentarios"]), 1)
        self.assertEqual(data["comentarios"][0]["autor"], "Tecnico")

    def test_delete_comment_removes_it_from_ticket(self):
        created = self.client.post("/tickets", json=self.valid_payload).json()
        commented = self.client.post(
            f"/tickets/{created['_id']}/comments",
            json={"autor": "tecnico", "comentario_html": "<p>Comentario tecnico</p>"},
        ).json()

        comment_id = commented["comentarios"][0]["id"]
        response = self.client.delete(f"/tickets/{created['_id']}/comments/{comment_id}")

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["comentarios"], [])
        self.assertTrue(any(entry["event_type"] == "comment_deleted" for entry in data["historial"]))

    def test_metrics_endpoint_returns_real_buckets(self):
        first = dict(self.valid_payload)
        first["fase_experimento"] = "pretest"
        second = dict(self.valid_payload)
        second["estado"] = "Resuelto"
        second["resolucion_html"] = "<p>Listo</p>"
        second["decision_chatbot"] = "resolver"
        second["fue_resuelto_en_chat"] = True
        second["fase_experimento"] = "posttest"
        self.client.post("/tickets", json=first)
        self.client.post("/tickets", json=second)

        response = self.client.get("/tickets/metrics")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertGreaterEqual(sum(item["count"] for item in data["received_last_30"]), 2)
        self.assertIn("Alta", data["by_metric"]["prioridad"])
        self.assertIn("summary", data)
        self.assertIn("phase_summary", data)

    def test_ticket_export_returns_csv(self):
        self.client.post("/tickets", json=self.valid_payload)

        response = self.client.get("/tickets/export")

        self.assertEqual(response.status_code, 200)
        self.assertIn("text/csv", response.headers["content-type"])
        self.assertIn("ID_ITIL", response.text)

    def test_chat_interaction_can_be_logged(self):
        payload = {
            "session_id": "sess-prueba",
            "usuario": "web-user",
            "mensaje_usuario": "Mi mouse falla",
            "respuesta_chatbot": "Voy a ayudarte",
            "tiempo_inicio_atencion": main.utc_now().isoformat(),
            "tiempo_respuesta_chatbot": 2.5,
            "numero_interacciones": 1,
            "decision_chatbot": "resolver",
            "fase_experimento": "posttest",
            "usa_contexto_rag": False,
            "fuente_respuesta": "generativa",
        }

        created = self.client.post("/chat/interactions", json=payload)

        self.assertEqual(created.status_code, 201)
        data = created.json()
        self.assertEqual(data["decision_chatbot"], "resolver")
        self.assertTrue(data["fue_resuelto_en_chat"])

    def test_ticket_sets_traceability_fields(self):
        payload = dict(self.valid_payload)
        payload["categoria_sugerida_ia"] = "TI - SOPORTE HARDWARE"
        payload["prioridad_sugerida_ia"] = "Alta"
        payload["fase_experimento"] = "posttest"

        response = self.client.post("/tickets", json=payload)

        self.assertEqual(response.status_code, 201)
        data = response.json()
        self.assertEqual(data["categoria_final"], payload["categoria"])
        self.assertEqual(data["prioridad_final"], payload["prioridad"])
        self.assertEqual(data["fase_experimento"], "posttest")

    def test_create_ticket_ignores_system_managed_fields(self):
        payload = dict(self.valid_payload)
        payload["ID-ITIL"] = "INC-9999999"
        payload["fcr"] = True
        payload["tiempo_creacion_ticket"] = "2020-01-01T00:00:00Z"
        payload["tiempo_resolucion_total"] = 99999

        response = self.client.post("/tickets", json=payload)

        self.assertEqual(response.status_code, 201)
        data = response.json()
        self.assertNotEqual(data["ID-ITIL"], "INC-9999999")
        self.assertFalse(data["fcr"])
        self.assertNotEqual(data["tiempo_creacion_ticket"], "2020-01-01T00:00:00Z")
        self.assertIn("T", data["tiempo_creacion_ticket"])

    def test_update_ticket_ignores_immutable_tracking_fields(self):
        created = self.client.post("/tickets", json=self.valid_payload).json()

        response = self.client.put(
            f"/tickets/{created['_id']}",
            json={
                "solicitante": "Intruso",
                "decision_chatbot": "escalar",
                "numero_interacciones": 44,
                "fcr": True,
                "tiempo_resolucion_total": 1234,
                "asunto": "Cambio permitido",
            },
        )

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["solicitante"], created["solicitante"])
        self.assertIsNone(data.get("decision_chatbot"))
        self.assertEqual(data["numero_interacciones"], 0)
        self.assertFalse(data["fcr"])
        self.assertEqual(data["asunto"], "Cambio permitido")

    def test_delete_missing_ticket_returns_404(self):
        response = self.client.delete(f"/tickets/{ObjectId()}")
        self.assertEqual(response.status_code, 404)

    def test_catalog_search_returns_matches(self):
        response = self.client.get("/catalog/search", params={"q": "mouse", "limit": 3})
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertGreaterEqual(data["count"], 1)
        self.assertTrue(any("MOUSE" in item["articulo"] for item in data["matches"]))

    def test_catalog_endpoint_returns_503_when_catalog_is_unavailable(self):
        original_load_catalog = main.load_catalog

        def failing_load_catalog():
            raise RuntimeError("catalogo no disponible")

        main.load_catalog = failing_load_catalog
        try:
            response = self.client.get("/catalog/categories")
        finally:
            main.load_catalog = original_load_catalog

        self.assertEqual(response.status_code, 503)
        self.assertEqual(
            response.json()["detail"],
            "No se pudo cargar el catalogo de categorias en este momento.",
        )

    def test_repository_file_upload_and_delete(self):
        upload = self.client.post(
            "/repository/files",
            files=[("files", ("manual.txt", b"contenido base", "text/plain"))],
        )
        self.assertEqual(upload.status_code, 201)
        uploaded_file = upload.json()["files"][0]

        listed = self.client.get("/repository/files")
        self.assertEqual(listed.status_code, 200)
        self.assertEqual(listed.json()["count"], 1)

        deleted = self.client.delete(f"/repository/files/{uploaded_file['name']}")
        self.assertEqual(deleted.status_code, 200)
        self.assertEqual(deleted.json()["msg"], "Archivo eliminado con éxito")


    def test_extract_text_endpoint_supports_txt(self):
        response = self.client.post(
            "/extract/text",
            files=[("files", ("nota.txt", b"Linea 1\n\nLinea   2", "text/plain"))],
        )

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["count"], 1)
        self.assertEqual(data["files"][0]["type"], "txt")
        self.assertEqual(data["files"][0]["text"], "Linea 1\n\nLinea 2")

    def test_extract_text_endpoint_supports_docx(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr(
                "word/document.xml",
                (
                    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                    "<w:body>"
                    "<w:p><w:r><w:t>Hola</w:t></w:r></w:p>"
                    "<w:p><w:r><w:t>Mundo DOCX</w:t></w:r></w:p>"
                    "</w:body>"
                    "</w:document>"
                ),
            )

        response = self.client.post(
            "/extract/text",
            files=[
                (
                    "files",
                    (
                        "demo.docx",
                        buffer.getvalue(),
                        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    ),
                )
            ],
        )

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["files"][0]["type"], "docx")
        self.assertIn("Hola", data["files"][0]["text"])
        self.assertIn("Mundo DOCX", data["files"][0]["text"])

    def test_extract_text_by_name_uses_repository_file(self):
        target = main.REPOSITORY_DIR / "manual_repo.txt"
        target.write_text("Texto base\n\npara extraer", encoding="utf-8")

        response = self.client.post("/extract/text/by-name", json={"file_name": "manual_repo.txt"})

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["count"], 1)
        self.assertEqual(data["files"][0]["name"], "manual_repo.txt")
        self.assertEqual(data["files"][0]["type"], "txt")
        self.assertEqual(data["files"][0]["text"], "Texto base\n\npara extraer")

    def test_extract_text_by_name_returns_404_when_missing(self):
        response = self.client.post("/extract/text/by-name", json={"file_name": "no_existe.pdf"})
        self.assertEqual(response.status_code, 404)

    def test_solution_crud_generates_markdown(self):
        payload = {
            "titulo": "Reiniciar impresora de almacen",
            "carpeta": "Impresoras",
            "descripcion_html": "<p>Apagar, esperar y volver a encender el equipo cuando la cola deja de responder.</p>",
        }
        created = self.client.post("/solutions", json=payload)
        self.assertEqual(created.status_code, 201)
        created_data = created.json()
        self.assertEqual(created_data["carpeta"], "Impresoras")

        listed = self.client.get("/solutions")
        self.assertEqual(listed.status_code, 200)
        self.assertEqual(listed.json()["count"], 1)
        self.assertIn("Impresoras", listed.json()["folders"])

        deleted = self.client.delete(f"/solutions/{created_data['_id']}")
        self.assertEqual(deleted.status_code, 200)
        self.assertEqual(deleted.json()["msg"], "Solución eliminada con éxito")

    def test_solution_allows_root_page_without_folder(self):
        payload = {
            "titulo": "Inicio",
            "carpeta": "",
            "descripcion_html": "<p>Bienvenido a la base de conocimientos.</p>",
        }

        created = self.client.post("/solutions", json=payload)

        self.assertEqual(created.status_code, 201)
        data = created.json()
        self.assertEqual(data["carpeta"], "")
        self.assertEqual(data["titulo"], "Inicio")


if __name__ == "__main__":
    unittest.main()
