# Proyecto Automatizacion

Solucion local para registrar tickets de ServiceDesk con:

- `web/`: chat web que conversa con n8n.
- `servicedesk/`: portal de tickets para crear, listar y editar solicitudes.
- `api/`: API FastAPI que guarda tickets en MongoDB.
- `workflows/`: export del flujo de n8n.
- `data/`: volumenes locales de ejecucion para MongoDB y n8n.

## Arquitectura

- `web` envia mensajes al webhook de n8n.
- `n8n` procesa el mensaje y puede invocar la API.
- `api` genera el ticket y lo guarda en MongoDB.
- `servicedesk` consume la API para administrar tickets.
- `categorias.json` es la fuente original del catalogo usado en el formulario.

## Estado del repo

El repositorio ahora ignora archivos de ejecucion como `data/`, caches de Python y `.env`.

Si ya tienes esos archivos versionados, puedes sacarlos del indice sin borrarlos del disco con:

```powershell
git rm -r --cached data api/__pycache__
```

Eso limpia el repositorio sin tocar tu informacion local.

## API

### Tickets

- `GET /health`
- `GET /tickets`
- `POST /tickets`
- `PUT /tickets/{id}`
- `DELETE /tickets/{id}`

### Catalogo de categorias

Sin modificar `servicedesk/categorias.json`, la API expone el catalogo para otros consumidores:

- `GET /catalog/categories`: devuelve el arbol completo.
- `GET /catalog/entries`: devuelve el catalogo plano.
- `GET /catalog/search?q=mouse&limit=5`: devuelve coincidencias rankeadas.

Esto es util para n8n porque evita meter todo el JSON en el prompt del agente cada vez.

## Recomendacion para n8n

La mejor opcion para que el chatbot coloque bien categoria, subcategoria y articulo es esta:

1. El agente resume el problema del usuario en una frase corta.
2. Llama a un `HTTP Request Tool` contra `GET http://fastapi:8000/catalog/search?q=...`.
3. Usa la mejor coincidencia devuelta para poblar `categoria`, `subcategoria` y `articulo`.
4. Si las coincidencias son ambiguas o el score es bajo, hace una sola pregunta de aclaracion.
5. Luego llama a `crear_ticket`.

### Por que recomiendo eso

- Mantienes `categorias.json` como fuente original.
- Evitas prompts enormes e inestables.
- El catalogo queda reusable para el portal, la API y n8n.
- Si el catalogo cambia, n8n consume la version actual sin editar el workflow entero.

### Flujo sugerido en n8n

- `Webhook`
- `AI Agent`
- `HTTP Request Tool` para buscar categoria
- `HTTP Request Tool` para crear ticket
- `Respond to Webhook`

### Prompt sugerido para el agente

```text
Antes de crear el ticket, busca la mejor categoria usando la herramienta de catalogo.
Debes devolver y usar exactamente los valores categoria, subcategoria y articulo entregados por el catalogo.
Si no encuentras una coincidencia clara, haz una unica pregunta corta de aclaracion.
No inventes categorias.
```

## Funciones nuevas

- Validaciones fuertes para campos criticos del ticket y combinacion valida de categoria/subcategoria/articulo.
- Adjuntos reales persistidos por ticket en `api/uploads/`.
- Historial y comentarios por ticket.
- Dashboard con metricas reales desde la API.
- Resolucion con editor enriquecido, igual que la descripcion.

## Bugs corregidos

- La API ahora responde `503` si Mongo no esta disponible, en vez de fallar con variables no definidas.
- `DELETE /tickets/{id}` ahora devuelve `404` si el ticket no existe.
- El frontend ya no reemplaza la prioridad por `Cerrado` al guardar una resolucion.
- El portal centraliza la URL base de la API en una sola constante.
- Se corrigio la generacion del gradiente de las graficas.

## Tests

Se agregaron tests basicos para la API y el catalogo.

Ejecucion sugerida:

```powershell
cd api
python -m unittest discover -s tests -v
```

## Notas

- No se modifico la codificacion fuente de `servicedesk/categorias.json`.
- Las credenciales actuales se dejaron tal como pediste.
- Las rutas `localhost` siguen bien para terminar localmente; mas adelante se pueden parametrizar para un entorno real.

