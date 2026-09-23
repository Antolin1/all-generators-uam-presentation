"""Redacta el feedback que se le devuelve al LLM. Habla solo de código Pydantic: nada de OCL ni de metamodelos."""
from __future__ import annotations

from .analysis import Issue

MAX_PER_CATEGORY = 12

_SECTIONS = [
    ("code", "Fallos del código (el script no se pudo analizar o ejecutar)", {"syntax", "import", "forbidden", "contract", "runtime", "timeout"}),
    ("structure", "Fallos de estructura (cómo están enlazados los objetos)", {"structure"}),
    ("constraint", "Reglas de validez incumplidas (métodos `check_constraints` del módulo `models`)", {"constraint"}),
    ("scope", "El modelo no respeta el tamaño pedido (scope)", {"scope"}),
]

_CODE_CATEGORIES = {"syntax", "import", "forbidden", "contract", "runtime", "timeout"}
_LABELS = {"syntax": "SINTAXIS", "import": "IMPORT", "forbidden": "PROHIBIDO", "contract": "CONTRATO", "runtime": "EJECUCIÓN",
           "timeout": "TIEMPO", "structure": "ESTRUCTURA", "constraint": "REGLA", "scope": "SCOPE"}


def _bullet(issue: Issue) -> str:
    # objects already say where they were created; only failures of the code itself point at a line
    where = ""
    if issue.category in _CODE_CATEGORIES and issue.line:
        where = f" (línea {issue.line}" + (f": `{issue.code}`)" if issue.code else ")")
    return f"- [{_LABELS[issue.category]}] {issue.message}{where}"


def render(issues: list[Issue], attempt: int, max_attempts: int) -> str:
    """El mensaje que se envía tras un intento fallido, agrupado por tipo de fallo."""
    present = {i.category for i in issues}
    parts = [f"El intento {attempt} de {max_attempts} NO es válido. Corrige TODOS los problemas de abajo y devuelve el script completo "
             "otra vez en un único bloque ```python."]
    code_failed = bool(present & _SECTIONS[0][2])
    for _key, title, categories in _SECTIONS:
        items = [i for i in issues if i.category in categories]
        if not items:
            continue
        parts.append(f"\n## {title}")
        parts.extend(_bullet(i) for i in items[:MAX_PER_CATEGORY])
        if len(items) > MAX_PER_CATEGORY:
            parts.append(f"- … y {len(items) - MAX_PER_CATEGORY} más del mismo tipo.")
    if code_failed:
        parts.append("\nMientras el script no se ejecute sin errores no se pueden comprobar las reglas ni el tamaño pedido: "
                     "arregla primero esto.")
    return "\n".join(parts)


def plural(n: int, one: str, many: str) -> str:
    return one if n == 1 else many
