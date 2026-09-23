"""Análisis estático (con `ast`) del script que escribe el LLM, antes de ejecutarlo.

Detecta lo que se puede saber sin ejecutar: errores de sintaxis, imports no permitidos o de clases que
no existen en el módulo, construcciones prohibidas y que no se asigne `model`. Cada problema lleva
su categoría, línea y la línea de código, para poder explicárselo al LLM con precisión.
"""
from __future__ import annotations

import ast
import re
from dataclasses import dataclass

from .spec import ALLOWED_STDLIB, MODULE_NAME

MAX_CODE_CHARS = 60_000
FORBIDDEN_CALLS = {"eval", "exec", "compile", "open", "__import__", "globals", "locals", "vars", "input", "breakpoint",
                   "memoryview", "help", "exit", "quit"}
_DUNDER = re.compile(r"^__\w+__$")
_DUNDER_OK = {"__name__"}


@dataclass
class Issue:
    category: str  # syntax | import | forbidden | contract | runtime | timeout | structure | constraint | scope
    message: str
    line: int | None = None
    code: str | None = None
    obj: int | None = None  # id del objeto del modelo implicado (para resaltarlo en el grafo)
    module_line: int | None = None  # línea del módulo `models` donde está la regla incumplida

    def to_json(self) -> dict:
        return dict(category=self.category, message=self.message, line=self.line, code=self.code, object=self.obj, moduleLine=self.module_line)


def _line(lines: list[str], number: int | None) -> str | None:
    return lines[number - 1].strip() if number and 0 < number <= len(lines) else None


def analyze(code: str, class_names: list[str]) -> list[Issue]:
    """Devuelve los problemas del script (lista vacía = no hay nada que objetar antes de ejecutarlo)."""
    if len(code) > MAX_CODE_CHARS:
        return [Issue("forbidden", f"El script es demasiado largo ({len(code)} caracteres; el máximo es {MAX_CODE_CHARS}).")]
    lines = code.splitlines()
    try:
        tree = ast.parse(code, filename="<llm_model>")
    except SyntaxError as error:
        return [Issue("syntax", f"{error.__class__.__name__}: {error.msg}", error.lineno, _line(lines, error.lineno))]

    issues: list[Issue] = []
    allowed_names = set(class_names)
    allowed_modules = set(ALLOWED_STDLIB) | {MODULE_NAME}

    def add(category: str, message: str, node: ast.AST) -> None:
        issues.append(Issue(category, message, node.lineno, _line(lines, node.lineno)))

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                top = alias.name.split(".")[0]
                if top not in allowed_modules:
                    add("import", f"El módulo `{alias.name}` no está permitido. Solo se puede importar `{MODULE_NAME}` "
                                  f"y de la biblioteca estándar: {', '.join(ALLOWED_STDLIB)}.", node)
        elif isinstance(node, ast.ImportFrom):
            top = (node.module or "").split(".")[0]
            if node.level:
                add("import", "Los imports relativos no están permitidos.", node)
            elif top not in allowed_modules:
                add("import", f"El módulo `{node.module}` no está permitido. Solo se puede importar `{MODULE_NAME}` "
                              f"y de la biblioteca estándar: {', '.join(ALLOWED_STDLIB)}.", node)
            elif top == MODULE_NAME:
                for alias in node.names:
                    if alias.name != "*" and alias.name not in allowed_names:
                        add("import", f"`{alias.name}` no existe en `{MODULE_NAME}`. Las clases disponibles son: "
                                      f"{', '.join(sorted(allowed_names))}.", node)
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in FORBIDDEN_CALLS:
            add("forbidden", f"`{node.func.id}(...)` no está permitido en este script.", node)
        elif isinstance(node, ast.Attribute) and _DUNDER.match(node.attr) and node.attr not in _DUNDER_OK:
            add("forbidden", f"No se permite acceder a atributos especiales como `.{node.attr}`.", node)
        elif isinstance(node, ast.Constant) and isinstance(node.value, str) and _DUNDER.match(node.value) and node.value not in _DUNDER_OK:
            add("forbidden", f"No se permiten cadenas como `{node.value!r}` (acceso a atributos especiales).", node)
        elif isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id == MODULE_NAME:
            if node.attr not in allowed_names:
                add("import", f"`{MODULE_NAME}.{node.attr}` no existe. Las clases disponibles son: "
                              f"{', '.join(sorted(allowed_names))}.", node)

    if not _assigns_model(tree):
        issues.append(Issue("contract", "El script no asigna la variable `model` a nivel de módulo (debe ser el objeto raíz del modelo)."))
    return issues


def _assigns_model(tree: ast.Module) -> bool:
    """¿Hay alguna asignación a `model` a nivel de módulo (incluyendo dentro de if/for/with/try)?"""
    def targets(node: ast.AST):
        if isinstance(node, ast.Assign):
            yield from node.targets
        elif isinstance(node, (ast.AnnAssign, ast.AugAssign)):
            yield node.target

    def names(t: ast.AST):
        if isinstance(t, ast.Name):
            yield t.id
        elif isinstance(t, (ast.Tuple, ast.List)):
            for e in t.elts:
                yield from names(e)

    def scan(body):
        for stmt in body:
            for t in targets(stmt):
                if "model" in set(names(t)):
                    return True
            if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                continue
            for attr in ("body", "orelse", "finalbody"):
                if scan(getattr(stmt, attr, []) or []):
                    return True
            for handler in getattr(stmt, "handlers", []) or []:
                if scan(handler.body):
                    return True
        return False

    return scan(tree.body)
