import os
import logging
from fastapi import FastAPI, HTTPException, status, Request
from pymongo import MongoClient, ReturnDocument
from bson import ObjectId
from datetime import datetime, timezone
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Optional, List

# Configuración de Logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[logging.StreamHandler()]
)
logger = logging.getLogger("ServiceDeskAPI")

app = FastAPI(
    title="ServiceDesk Pro API",
    description="API para la gestión de tickets integrada con Agente de IA",
    version="1.1.0"
)

# Conexión a Mongo
MONGO_URI = os.getenv("MONGO_URI", "mongodb://admin:admin123@mongo:27017/")
try:
    client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
    client.server_info() # Validar conexión
    db = client["servicedesk"]
    tickets_col = db["tickets"]
    counters_col = db["counters"]
    logger.info("Conexión a MongoDB establecida exitosamente.")
except Exception as e:
    logger.error(f"Error crítico al conectar a MongoDB: {e}")

# Middlewares
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def get_next_sequence(tipo_solicitud: str):
    # Normalizar el tipo para evitar errores de comparación
    tipo = str(tipo_solicitud or "").strip().capitalize()
    prefix = "RQ" if tipo == "Requerimiento" else "INC"
    
    sequence_document = counters_col.find_one_and_update(
        {"_id": prefix},
        {"$inc": {"seq": 1}},
        upsert=True,
        return_document=ReturnDocument.AFTER
    )
    
    if not sequence_document:
        # Fallback de seguridad si algo falla con el upsert
        return f"{prefix}-0000001"
        
    sequence_number = sequence_document.get("seq", 1)
    return f"{prefix}-{sequence_number:07d}"

# Esquemas de validación
class TicketSchema(BaseModel):
    solicitante: str
    tipo_solicitud: str
    prioridad: str
    estado: str = "Abierto"
    modo: str = "Chat"
    sucursal: str = "Surquillo"
    categoria: str
    subcategoria: str
    articulo: str
    asunto: str = Field(..., max_length=250)
    descripcion_html: str
    id_itil: Optional[str] = Field(None, alias="ID-ITIL")
    resolucion: Optional[str] = None
    fecha_creacion: Optional[datetime] = None

    model_config = {
        "populate_by_name": True
    }

class TicketUpdateSchema(BaseModel):
    solicitante: Optional[str] = None
    tipo_solicitud: Optional[str] = None
    prioridad: Optional[str] = None
    estado: Optional[str] = None
    modo: Optional[str] = None
    sucursal: Optional[str] = None
    categoria: Optional[str] = None
    subcategoria: Optional[str] = None
    articulo: Optional[str] = None
    asunto: Optional[str] = Field(None, max_length=250)
    descripcion_html: Optional[str] = None
    resolucion: Optional[str] = None

@app.get("/health")
async def health_check():
    return {"status": "ok", "timestamp": datetime.now(timezone.utc)}

def serialize(ticket):
    ticket["_id"] = str(ticket["_id"])
    # Convertir datetime a string para JSON
    if "fecha_creacion" in ticket and ticket["fecha_creacion"]:
        ticket["fecha_creacion"] = ticket["fecha_creacion"].isoformat()
    return ticket

@app.post("/tickets", status_code=status.HTTP_201_CREATED)
async def crear_ticket(ticket: TicketSchema):
    ticket_dict = ticket.dict(by_alias=True)
    
    # Capitalización para una mejor estética
    ticket_dict["solicitante"] = ticket_dict["solicitante"].title()
    ticket_dict["asunto"] = ticket_dict["asunto"].capitalize()
    
    logger.info(f"📥 SOLICITUD RECIBIDA (Crear): {ticket_dict}")
    
    ticket_dict["fecha_creacion"] = datetime.now(timezone.utc)
    nuevo_codigo = get_next_sequence(ticket.tipo_solicitud)
    ticket_dict["ID-ITIL"] = nuevo_codigo

    try:
        result = tickets_col.insert_one(ticket_dict)
        created_ticket = tickets_col.find_one({"_id": result.inserted_id})
        logger.info(f"Ticket creado exitosamente con ID: {nuevo_codigo}")
        return serialize(created_ticket)
    except Exception as e:
        logger.error(f"Error al insertar ticket: {e}")
        raise HTTPException(status_code=500, detail="Error interno al guardar el ticket")

@app.get("/tickets")
async def listar():
    # Retornamos los últimos tickets creados primero
    cursor = tickets_col.find().sort("fecha_creacion", -1)
    return [serialize(t) for t in cursor]

@app.put("/tickets/{id}")
async def actualizar(id: str, data: TicketUpdateSchema):
    if not ObjectId.is_valid(id):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="ID de MongoDB no válido")
    
    update_data = {k: v for k, v in data.dict(exclude_unset=True).items() if v is not None}
    
    # Capitalización en actualizaciones
    if "solicitante" in update_data:
        update_data["solicitante"] = update_data["solicitante"].title()
    if "asunto" in update_data:
        update_data["asunto"] = update_data["asunto"].capitalize()

    logger.info(f"📥 SOLICITUD RECIBIDA (Actualizar ID {id}): {update_data}")
    
    if not update_data:
        return serialize(tickets_col.find_one({"_id": ObjectId(id)}))

    logger.info(f"Actualizando ticket {id}. Campos: {list(update_data.keys())}")

    existing = tickets_col.find_one({"_id": ObjectId(id)})
    if not existing:
        raise HTTPException(status_code=404, detail="Ticket no encontrado")

    # Si cambia el tipo_solicitud, regenerar el ID-ITIL
    old_tipo = existing.get("tipo_solicitud")
    new_tipo = update_data.get("tipo_solicitud")
    
    if new_tipo and new_tipo != old_tipo:
        update_data["ID-ITIL"] = get_next_sequence(new_tipo)
        logger.info(f"Tipo cambiado de {old_tipo} a {new_tipo}. Nuevo ID-ITIL generado.")

    tickets_col.update_one({"_id": ObjectId(id)}, {"$set": update_data})
    updated_ticket = tickets_col.find_one({"_id": ObjectId(id)})
    return serialize(updated_ticket)

@app.delete("/tickets/{id}")
async def eliminar(id: str):
    if not ObjectId.is_valid(id):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="ID no válido")
    result = tickets_col.delete_one({"_id": ObjectId(id)})
    return {"msg": "Ticket eliminado con éxito"}