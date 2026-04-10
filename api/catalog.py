import json
import os
import re
from pathlib import Path

FALLBACK_ENCODINGS = ("utf-8-sig", "utf-8", "cp1252", "latin-1")
TOKEN_PATTERN = re.compile(r"[^a-z0-9]+")


def resolve_catalog_path() -> Path:
    env_path = os.getenv("CATALOG_PATH")
    candidates = []
    if env_path:
        candidates.append(Path(env_path))

    base_dir = Path(__file__).resolve().parent
    candidates.extend(
        [
            base_dir.parent / "servicedesk" / "categorias.json",
            Path("/servicedesk/categorias.json"),
            base_dir / "categorias.json",
        ]
    )

    for candidate in candidates:
        if candidate.exists():
            return candidate

    checked = ", ".join(str(path) for path in candidates)
    raise RuntimeError(f"No se encontro el archivo del catalogo. Rutas revisadas: {checked}")


def load_catalog():
    catalog_path = resolve_catalog_path()
    last_error = None
    for encoding in FALLBACK_ENCODINGS:
        try:
            return json.loads(catalog_path.read_text(encoding=encoding))
        except UnicodeDecodeError as exc:
            last_error = exc
        except json.JSONDecodeError:
            raise

    raise RuntimeError(f"No se pudo leer el catalogo: {last_error}")


def flatten_catalog(catalog):
    entries = []
    for categoria, subcategorias in catalog.items():
        if categoria == "Categoria" or not isinstance(subcategorias, dict):
            continue

        for subcategoria, articulos in subcategorias.items():
            if not isinstance(articulos, list):
                continue

            for articulo in articulos:
                entries.append(
                    {
                        "categoria": categoria,
                        "subcategoria": subcategoria,
                        "articulo": articulo,
                    }
                )

    return entries


def search_catalog_entries(query, catalog, limit=10):
    query = (query or "").strip()
    if not query:
        return []

    query_tokens = [token for token in TOKEN_PATTERN.split(query.lower()) if token]
    if not query_tokens:
        return []

    ranked = []
    for entry in flatten_catalog(catalog):
        haystack = " ".join(entry.values()).lower()
        normalized = TOKEN_PATTERN.sub(" ", haystack)

        score = 0
        for token in query_tokens:
            if token in normalized:
                score += 3
            if token == entry["categoria"].lower():
                score += 4
            if token == entry["subcategoria"].lower():
                score += 5
            if token == entry["articulo"].lower():
                score += 6

        if query.lower() in haystack:
            score += 8

        if score > 0:
            ranked.append({**entry, "score": score})

    ranked.sort(
        key=lambda item: (
            -item["score"],
            item["categoria"],
            item["subcategoria"],
            item["articulo"],
        )
    )
    return ranked[:limit]
