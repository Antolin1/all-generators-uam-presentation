"""Datos del metamodelo para el sandbox, y el scope que pide el usuario (lo único que el LLM recibe en texto)."""
from __future__ import annotations

from dataclasses import dataclass, field

from ..codegen.naming import to_snake_case
from ..ecore_service import ClassInfo, Metamodel

# Módulos de la biblioteca estándar que el script generado puede importar (además de `metamodel`).
ALLOWED_STDLIB = ("typing", "random", "math", "itertools", "collections", "string", "functools")
MODULE_NAME = "models"
ENTITY_NAME = "Entity"


class ScopeError(ValueError):
    pass


@dataclass
class Scope:
    """Lo que el usuario pide: clase raíz y cuántos objetos de cada clase."""

    root_class: str
    class_bounds: dict[str, tuple[int | None, int | None]] = field(default_factory=dict)
    total_min: int | None = None
    total_max: int | None = None

    @classmethod
    def from_payload(cls, payload: dict, metamodel: Metamodel) -> "Scope":
        root = payload.get("rootClass")
        if root not in metamodel.classes:
            raise ScopeError(f"La clase raíz «{root}» no existe en el metamodelo.")
        if metamodel.classes[root].abstract:
            raise ScopeError(f"La clase raíz «{root}» es abstracta: elige una clase concreta.")

        def number(value, label):
            if value in (None, ""):
                return None
            try:
                n = int(value)
            except (TypeError, ValueError):
                raise ScopeError(f"{label}: «{value}» no es un número entero.") from None
            if n < 0:
                raise ScopeError(f"{label}: no puede ser negativo.")
            return n

        bounds: dict[str, tuple[int | None, int | None]] = {}
        for name, b in (payload.get("classBounds") or {}).items():
            if name not in metamodel.classes:
                raise ScopeError(f"El scope menciona la clase «{name}», que no existe en el metamodelo.")
            low, high = number(b.get("min"), f"{name} (mín)"), number(b.get("max"), f"{name} (máx)")
            if low is None and high is None:
                continue
            if low is not None and high is not None and low > high:
                raise ScopeError(f"{name}: el mínimo ({low}) es mayor que el máximo ({high}).")
            bounds[name] = (low, high)
        total_min, total_max = number(payload.get("totalMin"), "Total (mín)"), number(payload.get("totalMax"), "Total (máx)")
        if total_min is not None and total_max is not None and total_min > total_max:
            raise ScopeError("Total: el mínimo es mayor que el máximo.")
        return cls(root, bounds, total_min, total_max)

    def describe(self) -> str:
        lines = [f"- Clase raíz: `{self.root_class}` (la variable `model` debe ser una instancia suya)."]
        for name, (low, high) in self.class_bounds.items():
            lines.append(f"- Instancias de `{name}` (contando las de sus subclases): {describe_range(low, high)}.")
        if self.total_min is not None or self.total_max is not None:
            lines.append(f"- Total de objetos del modelo (todas las clases): {describe_range(self.total_min, self.total_max)}.")
        if len(lines) == 1:
            lines.append("- Sin límites de tamaño: elige un tamaño razonable y representativo.")
        return "\n".join(lines)


def describe_range(low: int | None, high: int | None) -> str:
    if low is not None and high is not None:
        return f"exactamente {low}" if low == high else f"entre {low} y {high}"
    if low is not None:
        return f"al menos {low}"
    return f"como máximo {high}"


def ancestors(metamodel: Metamodel, name: str) -> list[str]:
    """La clase y todas sus superclases (sin repetir, la clase primero)."""
    order: list[str] = []

    def visit(n: str) -> None:
        if n in order or n not in metamodel.classes:
            return
        order.append(n)
        for parent in metamodel.classes[n].super_types:
            visit(parent)

    visit(name)
    return order


def root_candidates(metamodel: Metamodel) -> list[str]:
    """Clases concretas que ninguna otra contiene (ni sus superclases): las raíces naturales de un modelo."""
    contained: set[str] = set()
    for info in metamodel.classes.values():
        for ref in info.references:
            if ref.containment:
                contained.add(ref.target)
    result = []
    for name, info in metamodel.classes.items():
        if info.abstract:
            continue
        if any(a in contained for a in ancestors(metamodel, name)):
            continue
        result.append(name)
    return result or [n for n, i in metamodel.classes.items() if not i.abstract]


def build_spec(metamodel: Metamodel) -> dict:
    """Datos del metamodelo para el sandbox: por clase, sus referencias y atributos (heredados incluidos)."""
    classes = {}
    for name in metamodel.classes:
        refs, attrs = {}, {}
        for anc in reversed(ancestors(metamodel, name)):
            info: ClassInfo = metamodel.classes[anc]
            for r in info.references:
                refs[to_snake_case(r.name)] = dict(
                    name=r.name, target=r.target, containment=r.containment, lower=r.lower, upper=r.upper,
                    opposite=to_snake_case(r.opposite) if r.opposite else None)
            for a in info.attributes:
                attrs[to_snake_case(a.name)] = dict(name=a.name, type=a.type_name, lower=a.lower, upper=a.upper)
        classes[name] = dict(abstract=metamodel.classes[name].abstract, ancestors=ancestors(metamodel, name), refs=refs, attrs=attrs)
    return classes
