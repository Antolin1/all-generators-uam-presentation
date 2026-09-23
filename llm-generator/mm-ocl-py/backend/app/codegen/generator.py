"""Generates a self-contained Pydantic module from a loaded Ecore metamodel
plus a set of parsed OCL constraints.

Mapping:
  - each EClass -> a Pydantic class (multiple inheritance mirrors multiple
    eSuperTypes; classes without a supertype inherit from `OclEntity`, a
    small shared base restoring identity-based equality/hashing so OCL's
    object semantics hold - see its docstring in the generated file).
  - each EReference -> a field (`List[Target]`, `Optional[Target]`, or a
    required `Target` depending on its multiplicity).
  - each EReference with an `eOpposite` -> a bidirectional-consistency check.
  - each OCL invariant -> a check compiled to a Python boolean expression
    (see ocl_compiler.py).
  The checks of a class live together in its `check_constraints()` method,
  which returns *all* the violations of the object as (kind, name, message)
  tuples and extends those of its superclasses. The base class defines, once,
  the `@model_validator(mode="after")` that raises `ValueError` with the
  first of them; `collect_violations(root)` gathers every violation of a whole
  object graph (used by the LLM feedback loop to say exactly what failed).

Two flavours of the same module are produced:
  - the default one, for the user: documented in terms of Ecore/OCL;
  - `neutral=True`, for the LLM: the very same code, but with nothing that
    mentions OCL, Ecore or the metamodel (the base class is called `Entity`,
    comments and messages talk only about Python objects and their rules).
    The LLM is shown - and the sandbox runs - exactly this text, so the line
    numbers quoted in the feedback are the ones the LLM sees.
"""
from __future__ import annotations

import json

from ..ecore_service import AttributeInfo, ClassInfo, Metamodel, ReferenceInfo
from ..ocl.parser import ParsedConstraint
from .naming import to_snake_case
from .ocl_compiler import OclCompileError, compile_constraint_body, find_reference

_FULL_MODULE_DOC = '''"""Generado automáticamente por mm-ocl-py a partir del metamodelo Ecore
"@@PACKAGE@@" y de las restricciones OCL definidas en la aplicación.

No editar a mano si se va a regenerar: los cambios se perderían. Este
fichero es autocontenido: no importa nada del proyecto mm-ocl-py, solo
necesita `pydantic` instalado.
"""'''

_FULL_BASE_DOC = '''"""Base común a todas las clases generadas: restaura la igualdad/hash
    por identidad de Python (en vez de la igualdad estructural por defecto
    de Pydantic), para que '='/'<>' de OCL y las operaciones de
    colecciones basadas en sets (asSet, isUnique, union...) tengan
    semántica de igualdad de referencia entre objetos, como en OCL.

    También define `check_constraints()`, que devuelve la lista de TODAS las
    violaciones del objeto como tuplas (tipo, nombre, mensaje), y el único
    `@model_validator` (`validate_constraints`), que lanza `ValueError` con
    la primera. Cada clase generada amplía `check_constraints()` con sus
    propias comprobaciones y las de sus superclases (vía `super()`)."""'''

_NEUTRAL_MODULE_DOC = '''"""Clases Pydantic del dominio.

Un objeto se crea con `Clase.model_construct(campo=valor, ...)` (no valida nada) y sus
referencias a otros objetos se enlazan por asignación. `objeto.check_constraints()` devuelve
las reglas de validez que ese objeto incumple, `collect_violations(raiz)` las de todos los
objetos alcanzables desde `raiz`, y `validate_all(raiz)` lanza `ValueError` con la primera.
"""'''

_NEUTRAL_BASE_DOC = '''"""Base de todas las clases. Los objetos se comparan por identidad (no por valor).

    `check_constraints()` devuelve la lista de TODAS las reglas que incumple el objeto,
    como tuplas (tipo, nombre, mensaje); cada clase la amplía con sus reglas propias
    y las de sus superclases."""'''

_TEMPLATE = '''@@MODULE_DOC@@
from __future__ import annotations

import math
from typing import Any, ForwardRef, List, Optional, Self, get_args

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, model_validator

# Gancho de instrumentación: si vale una función, se llama con cada objeto
# nada más crearlo (con `Clase(...)` o con `Clase.model_construct(...)`).
# Por defecto no hace nada.
_on_create = None


def _flatten(items):
    result = []
    for item in items:
        if isinstance(item, list):
            result.extend(item)
        else:
            result.append(item)
    return result


def _check(violations, kind, name, message, predicate):
    """Evalúa `predicate()`; si es falso, o si no se puede evaluar (p. ej.
    porque falta un campo por asignar), añade una violación a la lista."""
    try:
        if not predicate():
            violations.append((kind, name, message))
    except Exception as exc:  # noqa: BLE001
        violations.append(("error", name, f"{message} [no se pudo evaluar: {type(exc).__name__}: {exc}]"))


def _mentions_entity(tp):
    if isinstance(tp, (str, ForwardRef)):
        return True
    if isinstance(tp, type):
        return issubclass(tp, @@BASE@@)
    return any(_mentions_entity(arg) for arg in get_args(tp))


class @@BASE@@(BaseModel):
    @@BASE_DOC@@

    model_config = ConfigDict(arbitrary_types_allowed=True)

    def __eq__(self, other):
        return self is other

    def __hash__(self):
        return id(self)

    def model_post_init(self, context) -> None:
        if _on_create is not None:
            _on_create(self)

    def check_constraints(self) -> list:
        violations = []
        for _name, _field in type(self).model_fields.items():
            if _name not in self.__dict__:
                if _field.is_required():
                    violations.append(("missing", _name, f"'{_name}' es obligatorio y no está asignado"))
                continue
            if not _mentions_entity(_field.annotation):
                try:
                    TypeAdapter(_field.annotation).validate_python(self.__dict__[_name], strict=True)
                except Exception as exc:  # noqa: BLE001
                    violations.append(("type", _name, f"'{_name}' tiene un valor de tipo incorrecto: {self.__dict__[_name]!r} ({exc.__class__.__name__})"))
        return violations

    @model_validator(mode="after")
    def validate_constraints(self) -> Self:
        for _kind, _name, _message in self.check_constraints():
            raise ValueError(_message)
        return self


def iter_objects(root):
    """Recorre (en profundidad, una vez por objeto) todos los objetos
    alcanzables desde `root` siguiendo cualquier campo que sea otro
    objeto (`@@BASE@@`) o una lista de ellos."""
    seen = set()
    stack = [root]
    while stack:
        obj = stack.pop()
        if not isinstance(obj, @@BASE@@) or id(obj) in seen:
            continue
        seen.add(id(obj))
        yield obj
        children = []
        for name in type(obj).model_fields:
            value = obj.__dict__.get(name)
            if isinstance(value, list):
                children.extend(value)
            else:
                children.append(value)
        stack.extend(reversed(children))


def collect_violations(root) -> list:
    """Todas las violaciones de todos los objetos alcanzables desde `root`,
    como tuplas (objeto, tipo, nombre, mensaje). No lanza nada."""
    return [(obj, kind, name, message) for obj in iter_objects(root) for kind, name, message in obj.check_constraints()]


def validate_all(root: @@BASE@@) -> None:
    """Ejecuta validate_constraints() en cada objeto alcanzable desde `root`.

    Estos modelos son grafos (referencias cruzadas, p. ej.
    Transition <-> Vertex), no árboles: para construirlos hace falta crear los
    objetos con `Clase.model_construct(...)` (que NO valida) y enlazarlos por
    mutación, ya que un objeto no puede cumplir sus reglas de referencia antes
    de que el resto del grafo exista. `validate_all` recorre el grafo a mano y
    deja que la primera violación se propague como `ValueError` (para verlas
    todas, usa `collect_violations`).

    Uso típico:
        objetos = [...]              # construidos con model_construct(...)
        # ... enlazar referencias por mutación ...
        validate_all(raiz)           # lanza ValueError en la primera violación
    """
    for obj in iter_objects(root):
        obj.validate_constraints()

'''


def _topo_order(classes: dict[str, ClassInfo]) -> list[str]:
    order: list[str] = []
    done: set[str] = set()
    remaining = dict(classes)
    while remaining:
        progressed = False
        for name in list(remaining.keys()):
            info = remaining[name]
            if all(s in done or s not in classes for s in info.super_types):
                order.append(name)
                done.add(name)
                del remaining[name]
                progressed = True
        if not progressed:
            # Cycle (shouldn't happen for a well-formed Ecore) - bail out safely.
            order.extend(remaining.keys())
            break
    return order


def _field_decl(ref: ReferenceInfo, neutral: bool) -> str:
    py_name = to_snake_case(ref.name)
    target = ref.target
    if ref.upper != 1:
        line = f"    {py_name}: List['{target}'] = Field(default_factory=list)"
    elif ref.lower >= 1:
        line = f"    {py_name}: '{target}'"
    else:
        line = f"    {py_name}: Optional['{target}'] = None"
    if neutral:
        notes = ["hijos: cada objeto pertenece a un único padre" if ref.containment else "referencia a otros objetos ya existentes"]
        if ref.opposite:
            notes.append(f"inversa: {target}.{to_snake_case(ref.opposite)} (mantén ambos lados coherentes)")
        line += "  # " + "; ".join(notes)
    return line


_PRIMITIVE_TYPE_MAP = {
    "EString": "str",
    "EInt": "int",
    "EIntegerObject": "int",
    "ELong": "int",
    "ELongObject": "int",
    "EShort": "int",
    "EByte": "int",
    "EBoolean": "bool",
    "EBooleanObject": "bool",
    "EDouble": "float",
    "EDoubleObject": "float",
    "EFloat": "float",
    "EFloatObject": "float",
    "EChar": "str",
    "EDate": "str",
}


def _attr_field_decl(attr: AttributeInfo) -> str:
    py_name = to_snake_case(attr.name)
    py_type = _PRIMITIVE_TYPE_MAP.get(attr.type_name, "Any")
    if attr.upper != 1:
        return f"    {py_name}: List[{py_type}] = Field(default_factory=list)"
    if attr.lower >= 1:
        return f"    {py_name}: {py_type}"
    return f"    {py_name}: Optional[{py_type}] = None"


def _lit(text: str) -> str:
    """A Python string literal (JSON string syntax is valid Python)."""
    return json.dumps(text, ensure_ascii=False)


def _multiplicity_checks(info: ClassInfo) -> list[str]:
    lines: list[str] = []
    for ref in info.references:
        if ref.upper != 1 and ref.lower > 0:
            py_name = to_snake_case(ref.name)
            message = f"'{ref.name}' requiere al menos {ref.lower} elemento(s)"
            lines.append(
                f'_check(violations, "multiplicity", {_lit(ref.name)}, {_lit(message)}, '
                f"lambda: len(self.{py_name}) >= {ref.lower})"
            )
    return lines


def _bidirectional_checks(info: ClassInfo, metamodel: Metamodel) -> list[str]:
    lines: list[str] = []
    for ref in info.references:
        if not ref.opposite:
            continue
        opp = find_reference(metamodel, ref.target, ref.opposite)
        if opp is None:
            continue
        py_name = to_snake_case(ref.name)
        opp_py_name = to_snake_case(opp.name)
        msg = (
            f"Inconsistencia bidireccional: self no aparece en "
            f"{ref.target}.{opp_py_name} a través de '{ref.name}'"
        )
        if ref.upper != 1:
            predicate = (
                f"all(self in _item.{opp_py_name} for _item in self.{py_name})"
                if opp.upper != 1
                else f"all(_item.{opp_py_name} is self for _item in self.{py_name})"
            )
        else:
            predicate = (
                f"self.{py_name} is None or self in self.{py_name}.{opp_py_name}"
                if opp.upper != 1
                else f"self.{py_name} is None or self.{py_name}.{opp_py_name} is self"
            )
        lines.append(f'_check(violations, "opposite", {_lit(ref.name)}, {_lit(msg)}, lambda: {predicate})')
    return lines


def _constraint_checks(
    class_name: str, constraints: list[ParsedConstraint], metamodel: Metamodel, neutral: bool
) -> tuple[list[str], list[str]]:
    lines: list[str] = []
    warnings: list[str] = []
    for c in constraints:
        if c.context_class != class_name:
            continue
        try:
            cv = compile_constraint_body(c.body, metamodel, class_name)
        except OclCompileError as e:
            warnings.append(f"{class_name}::{c.name}: {e}")
            if not neutral:
                lines.append(f"# TODO: no se pudo traducir automáticamente la restricción '{c.name}': {e}")
                lines.append(f"# OCL original: {c.source}")
            continue
        # neutral: only "Class.rule" - the condition itself is right there, in Python, in the lambda
        message = f"{class_name}.{c.name}" if neutral else f"{c.name}: {c.source.replace(chr(10), ' ')}"
        lines.append(f'_check(violations, "rule", {_lit(c.name)}, {_lit(message)}, lambda: ({cv.code}))')
    return lines, warnings


def _class_source(
    name: str, info: ClassInfo, metamodel: Metamodel, constraints: list[ParsedConstraint], neutral: bool
) -> tuple[str, list[str]]:
    base = "Entity" if neutral else "OclEntity"
    bases = info.super_types if info.super_types else [base]
    lines = [f"class {name}({', '.join(bases)}):"]
    if info.abstract:
        lines.append(
            "    # clase abstracta: no se instancia directamente, sino a través de sus subclases"
            if neutral
            else "    # clase abstracta en el metamodelo (no se impone en tiempo de ejecución)"
        )

    field_lines = [_attr_field_decl(a) for a in info.attributes] + [
        _field_decl(r, neutral) for r in info.references
    ]
    lines.extend(field_lines)

    mult_lines = _multiplicity_checks(info)
    bidi_lines = _bidirectional_checks(info, metamodel)
    ocl_lines, warnings = _constraint_checks(name, constraints, metamodel, neutral)

    body: list[str] = []
    if mult_lines:
        if neutral:
            body.append("        # (0) número mínimo de elementos en las listas")
        else:
            body.append("        # (0) multiplicidad de referencias (lowerBound; añadido por")
            body.append("        #     coherencia con el validador web, no pedido explícitamente)")
        body.extend("        " + l for l in mult_lines)
    if bidi_lines:
        body.append("        # (i) coherencia entre referencias inversas" if neutral else "        # (i) consistencia bidireccional (eOpposite)")
        body.extend("        " + l for l in bidi_lines)
    if ocl_lines:
        body.append("        # (ii) reglas del dominio" if neutral else "        # (ii) restricciones OCL")
        body.extend("        " + l for l in ocl_lines)

    # Only classes with checks of their own override `check_constraints`; each
    # one extends the checks of its superclasses (cooperative `super()`), so a
    # rule declared on a superclass also applies to its subclasses, as in OCL.
    if body:
        if field_lines:
            lines.append("")
        lines.append("    def check_constraints(self) -> list:")
        lines.append("        violations = list(super().check_constraints())")
        lines.extend(body)
        lines.append("        return violations")
    elif not field_lines:
        lines.append("    pass")

    return "\n".join(lines), warnings


def untranslatable_constraints(metamodel: Metamodel, constraints: list[ParsedConstraint]) -> list[ParsedConstraint]:
    """Constraints that cannot be compiled to Python (e.g. `allInstances()`): only the OCL interpreter can check them."""
    result = []
    for c in constraints:
        if c.context_class not in metamodel.classes:
            continue
        try:
            compile_constraint_body(c.body, metamodel, c.context_class)
        except OclCompileError:
            result.append(c)
    return result


def generate_pydantic_module(
    metamodel: Metamodel, constraints: list[ParsedConstraint], neutral: bool = False
) -> tuple[str, list[str]]:
    order = _topo_order(metamodel.classes)
    blocks: list[str] = []
    warnings: list[str] = []
    for name in order:
        block, w = _class_source(name, metamodel.classes[name], metamodel, constraints, neutral)
        blocks.append(block)
        warnings.extend(w)

    for cc in {c.context_class for c in constraints}:
        if cc not in metamodel.classes:
            warnings.append(
                f"La restricción con contexto '{cc}' no corresponde a ninguna clase del "
                "metamodelo; se ignora."
            )

    code = (
        _TEMPLATE.replace("@@MODULE_DOC@@", _NEUTRAL_MODULE_DOC if neutral else _FULL_MODULE_DOC)
        .replace("@@BASE_DOC@@", _NEUTRAL_BASE_DOC if neutral else _FULL_BASE_DOC)
        .replace("@@BASE@@", "Entity" if neutral else "OclEntity")
        .replace("@@PACKAGE@@", metamodel.package_name)
    )
    code += "\n\n".join(f"\n{b}\n" for b in blocks).replace("\n\n\n\n", "\n\n\n")
    code += "\n\n# Resolución de referencias adelantadas entre clases.\n"
    code += "\n".join(f"{name}.model_rebuild()" for name in order)
    code += "\n"
    return code, warnings
