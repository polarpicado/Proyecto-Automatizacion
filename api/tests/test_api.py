from pathlib import Path
import sys
from datetime import timedelta
import unittest

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
        if "_id" in query:
            return self.documents.get(str(query["_id"]))
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
        second = dict(self.valid_payload)
        second["estado"] = "Resuelto"
        second["resolucion_html"] = "<p>Listo</p>"
        self.client.post("/tickets", json=first)
        self.client.post("/tickets", json=second)

        response = self.client.get("/tickets/metrics")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertGreaterEqual(sum(item["count"] for item in data["received_last_30"]), 2)
        self.assertIn("Alta", data["by_metric"]["prioridad"])

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


if __name__ == "__main__":
    unittest.main()
