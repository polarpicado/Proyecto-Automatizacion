# Notas RAG

## Objetivo
Construir el flujo de RAG del proyecto por etapas, sin mezclar todavía la parte de evaluación con el chatbot principal.

## Paso A Paso Recomendado

### 1. Sincronización de archivos
- Usar el workflow [Sincronización.json](/G:/OneDrive/OneDrive%20-%20Crosland/perfil%20de%20windows/Documents/mi-proyecto/workflows/Sincronización.json) como base.
- Listar archivos desde `http://fastapi:8000/repository/files`.
- Filtrar extensiones compatibles.
- Descargar archivos.
- Convertirlos a texto.
- Dividirlos en chunks.

### 2. Embeddings
- Elegir el proveedor de embeddings.
- Generar un embedding por cada chunk.
- Mantener metadatos por chunk:
  - `source_id`
  - `file_name`
  - `original_name`
  - `extension`
  - `modified_at`
  - `chunk_index`
  - `chunk_total`
  - `download_url`

### 3. Base vectorial
- Guardar los embeddings en Qdrant.
- Usar un `id` estable por chunk para poder reindexar sin duplicar.
- Recomendación:
  - `id = source_id + chunk_index + modified_at`

### 4. Flujo de consulta RAG
- Recibir la pregunta del usuario.
- Generar embedding de la pregunta.
- Buscar en Qdrant los chunks más relevantes.
- Pasar ese contexto al LLM.
- Responder usando solo el contexto recuperado cuando aplique.

### 5. Integración con el chatbot
- Hacer esto en otro momento, no en el workflow de sincronización.
- El chatbot debe:
  - recuperar contexto del RAG
  - responder si puede
  - escalar a ticket si no puede resolver con seguridad

### 6. Evaluación tipo RAGAS
- Hacerlo en un workflow aparte.
- Crear dataset con:
  - pregunta
  - respuesta esperada o ground truth
  - respuesta real del sistema
  - contexto recuperado
- Métricas recomendadas:
  - `answer_correctness`
  - `faithfulness`
  - `answer_relevance`
  - `context_precision` o `context_recall`

### 7. Métricas propias del proyecto
- Además de RAGAS clásico, evaluar:
  - si eligió bien `categoria / subcategoria / articulo`
  - si resolvió correctamente en chat
  - si escaló correctamente a ticket

## Orden Recomendado De Trabajo
1. Terminar sincronización.
2. Añadir embeddings.
3. Hacer upsert en Qdrant.
4. Construir flujo de consulta RAG.
5. Probar preguntas reales.
6. Crear workflow de evaluación.
7. Integrarlo al chatbot.

## Nota Importante
- No usar `http://localhost:8082/` como fuente principal de indexación si se puede evitar.
- Es mejor usar:
  - `GET http://fastapi:8000/repository/files`
  - y luego descargar cada archivo desde la URL real que devuelve la API.
- La web en `8082` sirve bien como interfaz humana, pero para automatización y RAG conviene más la API.
