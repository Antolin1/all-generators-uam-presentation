from __future__ import annotations

from dataclasses import dataclass

from .ocl.errors import OclEvalError
from .ocl.evaluator import evaluate_on
from .ocl.parser import ParsedConstraint
from .xmi_service import LoadedModel, label_for


@dataclass
class ConstraintResult:
    constraint_name: str
    context_class: str
    object_label: str
    passed: bool
    error: str | None = None


def run_constraints(
    constraints: list[ParsedConstraint],
    loaded_model: LoadedModel,
    class_registry: dict[str, type],
) -> list[ConstraintResult]:
    results: list[ConstraintResult] = []
    for c in constraints:
        target_class = class_registry.get(c.context_class)
        if target_class is None:
            results.append(
                ConstraintResult(
                    constraint_name=c.name,
                    context_class=c.context_class,
                    object_label="-",
                    passed=False,
                    error=f"La clase '{c.context_class}' no existe en el metamodelo.",
                )
            )
            continue

        instances = [o for o in loaded_model.all_objects if isinstance(o, target_class)]
        for obj in instances:
            label = f"{loaded_model.object_ids[id(obj)]} ({label_for(obj)} : {obj.eClass.name})"
            try:
                value = evaluate_on(c.body, obj, loaded_model.all_objects, class_registry)
            except OclEvalError as e:
                results.append(
                    ConstraintResult(c.name, c.context_class, label, False, error=str(e))
                )
                continue
            if not isinstance(value, bool):
                results.append(
                    ConstraintResult(
                        c.name,
                        c.context_class,
                        label,
                        False,
                        error=f"La expresión no evalúa a un booleano (devolvió {value!r}).",
                    )
                )
                continue
            results.append(ConstraintResult(c.name, c.context_class, label, value))
    return results
