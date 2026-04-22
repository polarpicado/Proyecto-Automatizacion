# Notas RAG (estado actual)

## Objetivo

Sincronizar conocimiento de 3 fuentes hacia Qdrant en una coleccion unica para consulta RAG:

- archivos del repositorio
- soluciones del equipo
- tickets de soporte

## Fuentes API recomendadas

- Archivos: `GET /repository/files`
- Soluciones: `GET /solutions`
- Tickets: `GET /tickets`
- Extraccion de texto por archivo: `POST /extract/text/by-name`

## Identidad y versionado sugerido

- `entity_type`: `repo_file | solution | ticket`
- `entity_id`:
  - archivo: `repo:<url>` (o id persistente cuando se exponga)
  - solucion: `sol:<_id>`
  - ticket: `ticket:<_id>`
- `source_id`: igual a `entity_id`
- `version_key`: `updated_at`/`fecha_actualizacion` + hash de contenido normalizado si aplica

## Estrategia de sincronizacion

1. Leer fuente completa.
2. Comparar contra `sync_snapshot` en Mongo.
3. Detectar `new`, `updated`, `deleted`.
4. Para `new/updated`:
   - limpiar contenido
   - chunking
   - embedding
   - borrar chunks previos por `source_id`
   - upsert de nuevos chunks en `rag_repo`
5. Para `deleted`:
   - borrar en Qdrant por `source_id`
6. Actualizar snapshot.

## Metadatos minimos por chunk

- `source_id`
- `entity_type`
- `title`
- `updated_at`
- `version_key`
- `document_origin`
- `status` (solo tickets)
- `chunk_index`
- `chunk_total`

## Decisiones operativas

- Mantener una sola coleccion: `rag_repo`.
- Borrar y reindexar por `source_id` para evitar duplicados.
- Tickets cerrados pueden seguir indexados con `status=Cerrado` para historial, salvo regla de negocio contraria.
- Si una entidad desaparece de la fuente, se elimina del indice.

## Nota sobre workflow base

`workflows/Sincronizacion.json` sirve como referencia de patron, pero no debe asumirse como flujo final vigente en produccion sin revision.

## Pendientes recomendados

- Exponer `file_id` persistente en `/repository/files` para renames limpios.
- Definir hash de contenido en backend para detectar cambios reales.
- Implementar monitoreo de drift entre snapshot y Qdrant.
