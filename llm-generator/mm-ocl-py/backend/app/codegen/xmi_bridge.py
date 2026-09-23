"""Bridges an already-loaded .xmi model (pyecore objects, from xmi_service)
into instances of the Pydantic classes produced by generator.py, so the
generated code can be used as an independent cross-check of the same
conformance question the web validator answers with the OCL interpreter.

The generated module is never imported as a file on disk: its source is
`exec`'d into a fresh namespace dict, since it is always regenerated from
whatever metamodel + constraints are currently loaded in this session.
"""
from __future__ import annotations

from typing import Any

from pyecore.ecore import EAttribute, EReference

from .naming import to_snake_case


class PydanticBridgeError(Exception):
    pass


def load_generated_namespace(code: str) -> dict[str, Any]:
    namespace: dict[str, Any] = {}
    try:
        exec(compile(code, "<generated pydantic module>", "exec"), namespace)
    except Exception as e:  # noqa: BLE001 - the generated code is untrusted-ish, be defensive
        raise PydanticBridgeError(f"El código Pydantic generado no se pudo ejecutar: {e}") from e
    return namespace


def build_pydantic_objects(all_objects: list, namespace: dict[str, Any]) -> dict[int, Any]:
    """Mirrors a pyecore object graph into `Clase.model_construct()` instances.

    Two passes, because the graph can have cycles (eOpposite pairs) and
    forward references (containment children referencing not-yet-built
    parents via a non-containment opposite): first create an empty shell
    per object, then fill in every field once every shell exists.
    """
    cache: dict[int, Any] = {}

    def shell_for(obj) -> Any:
        key = id(obj)
        if key not in cache:
            cls_name = obj.eClass.name
            cls = namespace.get(cls_name)
            if cls is None:
                raise PydanticBridgeError(
                    f"No existe una clase generada '{cls_name}' para un objeto del modelo "
                    "(¿se regeneró el código después de cambiar el metamodelo?)"
                )
            cache[key] = cls.model_construct()
        return cache[key]

    for obj in all_objects:
        shell_for(obj)

    for obj in all_objects:
        instance = cache[id(obj)]
        for feat in obj.eClass.eAllStructuralFeatures():
            py_name = to_snake_case(feat.name)
            if isinstance(feat, EReference):
                if feat.upperBound == 1:
                    val = getattr(obj, feat.name)
                    setattr(instance, py_name, shell_for(val) if val is not None else None)
                else:
                    setattr(instance, py_name, [shell_for(v) for v in getattr(obj, feat.name)])
            elif isinstance(feat, EAttribute):
                setattr(instance, py_name, getattr(obj, feat.name))

    return cache


def cross_check_model(all_objects: list, roots: list, code: str) -> dict[str, Any]:
    """Runs the generated Pydantic classes' `validate_all` against a model
    already loaded from .xmi, as an independent check of the same
    conformance question the OCL interpreter answers.

    Returns {"ok": bool, "errors": [str, ...]}. Never raises - failures to
    even run the check (bad generated code, unmapped classes...) are
    reported as a single error entry with ok=False, same as a genuine
    validation failure, since either way the cross-check couldn't confirm
    conformance.
    """
    try:
        namespace = load_generated_namespace(code)
        cache = build_pydantic_objects(all_objects, namespace)
        validate_all = namespace["validate_all"]
    except PydanticBridgeError as e:
        return {"ok": False, "errors": [str(e)]}

    errors: list[str] = []
    for root in roots:
        try:
            validate_all(cache[id(root)])
        except ValueError as e:
            errors.append(str(e))
    return {"ok": not errors, "errors": errors}
