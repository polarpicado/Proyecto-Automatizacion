# Proyecto Automatizacion ServiceDesk + IA

Sistema local para mesa de ayuda con chatbot, gestion de tickets, base de conocimiento, repositorio de archivos y flujos en n8n.

## Componentes

- `web/`: chat web.
- `servicedesk/`: portal de tickets, dashboard y soluciones.
- `repository/`: interfaz para cargar/listar archivos del repositorio.
- `api/`: backend FastAPI con MongoDB.
- `workflows/`: flujos de n8n exportados.
- `gateway/`: reverse proxy para exponer todo por una sola URL.
- `data/`: volumenes persistentes de Docker (Mongo y n8n).

## Arquitectura real

- `web` envia mensajes a n8n (webhook chatbot).
- `n8n` ejecuta el agente IA y, cuando corresponde, crea ticket en API.
- `servicedesk` consume API para tickets, metricas, soluciones y catalogo.
- `repository` consume API para administrar archivos de `api/repository_storage`.
- `api` persiste en MongoDB y expone endpoints para tickets, soluciones, repositorio, extraccion de texto y portfolio.
- `qdrant` queda disponible para sincronizacion RAG.

## Puertos locales

- `web`: `http://localhost:8080`
- `servicedesk`: `http://localhost:8081`
- `repository`: `http://localhost:8082`
- `api`: `http://localhost:8001`
- `n8n`: `http://localhost:5678`
- `qdrant`: `http://localhost:6333`
- `gateway`: `http://localhost:8090`

## Endpoints API principales

### Salud

- `GET /health`

### Catalogo

- `GET /catalog/categories`
- `GET /catalog/entries`
- `GET /catalog/search?q=...&limit=...`

### Repositorio y extraccion de texto

- `GET /repository/files`
- `POST /repository/files`
- `DELETE /repository/files/{file_name}`
- `POST /extract/text`
- `POST /extract/text/by-name`

### Soluciones

- `GET /solutions`
- `GET /solutions/{solution_id}`
- `POST /solutions`
- `PUT /solutions/{solution_id}`
- `DELETE /solutions/{solution_id}`

### Tickets y metrica tesis

- `GET /tickets`
- `GET /tickets/{id}`
- `POST /tickets`
- `PUT /tickets/{id}`
- `DELETE /tickets/{id}`
- `POST /tickets/{id}/comments`
- `DELETE /tickets/{id}/comments/{comment_id}`
- `GET /tickets/metrics`
- `GET /tickets/export`
- `GET /chat/interactions`
- `POST /chat/interactions`

### Portfolio

- `POST /portfolio/chat`
- `POST /portfolio/formulario-web`

## Metricas y trazabilidad implementadas

En tickets se soportan campos para medicion de tesis, incluyendo:

- `decision_chatbot`, `fue_escalado`, `fue_resuelto_en_chat`, `razon_decision`, `nivel_escalamiento`
- `resuelto_por`, `fcr`, `fase_experimento`
- `categoria_sugerida_ia`, `categoria_final`, `prioridad_sugerida_ia`, `prioridad_final`
- `tiempo_inicio_atencion`, `tiempo_respuesta_chatbot`, `tiempo_creacion_ticket`, `tiempo_resolucion_total`
- `usa_contexto_rag`, `fuente_respuesta`

## Arranque rapido

```powershell
docker compose up -d
```

Accesos:

- `http://localhost:8001/docs`
- `http://localhost:8080`
- `http://localhost:8081`
- `http://localhost:8082`

## Script de demo

Para arranque completo con ngrok:

```powershell
.\start-demo.ps1
```

## Testing

```powershell
cd api
python -m unittest discover -s tests -v
```

## Referencias internas

- Guia de reinicio demo: [GUIA_REINICIO_DEMO.md](./GUIA_REINICIO_DEMO.md)
- Notas RAG: [NOTAS_RAG.md](./NOTAS_RAG.md)
- Resultado de validacion tecnica: [VALIDACION_TOTAL.md](./VALIDACION_TOTAL.md)

