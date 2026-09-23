"""Loading .xmi models against an already-loaded Ecore metamodel, plus a
best-effort structural (multiplicity) check and an object-diagram renderer."""
from __future__ import annotations

from dataclasses import dataclass, field

from pyecore.ecore import EAttribute, EReference
from pyecore.resources import URI

from .ecore_service import Metamodel


class XmiLoadError(Exception):
    pass


@dataclass
class StructuralIssue:
    message: str


@dataclass
class LoadedModel:
    roots: list
    all_objects: list
    object_ids: dict[int, str]
    structural_issues: list[StructuralIssue] = field(default_factory=list)
    mermaid: str = ""

    @property
    def conforms_structurally(self) -> bool:
        return not self.structural_issues


def label_for(obj) -> str:
    for feat in obj.eClass.eAllStructuralFeatures():
        if isinstance(feat, EAttribute) and feat.name == "name":
            val = getattr(obj, feat.name, None)
            if val:
                return str(val)
    for feat in obj.eClass.eAllStructuralFeatures():
        if isinstance(feat, EAttribute) and feat.eType and feat.eType.name == "EString":
            val = getattr(obj, feat.name, None)
            if val:
                return str(val)
    return obj.eClass.name


def load_xmi(path: str, metamodel: Metamodel) -> LoadedModel:
    try:
        resource = metamodel.resource_set.get_resource(URI(path))
        roots = list(resource.contents)
    except Exception as e:  # noqa: BLE001
        raise XmiLoadError(f"No se pudo interpretar el fichero .xmi: {e}") from e

    if not roots:
        raise XmiLoadError("El fichero .xmi no contiene ningún objeto raíz.")

    all_objects: list = []
    for root in roots:
        all_objects.append(root)
        all_objects.extend(root.eAllContents())

    object_ids = {id(o): f"o{i}" for i, o in enumerate(all_objects)}

    issues = _check_structural(all_objects, object_ids)
    mermaid = _build_object_diagram(all_objects, object_ids)

    return LoadedModel(
        roots=roots,
        all_objects=all_objects,
        object_ids=object_ids,
        structural_issues=issues,
        mermaid=mermaid,
    )


def _check_structural(all_objects: list, object_ids: dict[int, str]) -> list[StructuralIssue]:
    issues: list[StructuralIssue] = []
    for obj in all_objects:
        label = f"{object_ids[id(obj)]} ({label_for(obj)} : {obj.eClass.name})"
        for feat in obj.eClass.eAllStructuralFeatures():
            if not isinstance(feat, EReference):
                continue
            val = getattr(obj, feat.name)
            size = (0 if val is None else 1) if feat.upperBound == 1 else len(val)
            if feat.lowerBound > size:
                issues.append(
                    StructuralIssue(
                        f"{label}: la referencia '{feat.name}' requiere al menos "
                        f"{feat.lowerBound} elemento(s), tiene {size}."
                    )
                )
            if feat.upperBound != -1 and size > feat.upperBound:
                issues.append(
                    StructuralIssue(
                        f"{label}: la referencia '{feat.name}' permite como máximo "
                        f"{feat.upperBound} elemento(s), tiene {size}."
                    )
                )
    return issues


def _build_object_diagram(all_objects: list, object_ids: dict[int, str]) -> str:
    lines = ["graph LR"]
    if not all_objects:
        return "\n".join(lines + ["  empty[No hay objetos]"])
    for obj in all_objects:
        oid = object_ids[id(obj)]
        label = f"{label_for(obj)} : {obj.eClass.name}".replace('"', "'")
        lines.append(f'  {oid}["{label}"]')
    for obj in all_objects:
        oid = object_ids[id(obj)]
        for feat in obj.eClass.eAllStructuralFeatures():
            if not isinstance(feat, EReference):
                continue
            val = getattr(obj, feat.name)
            targets = [val] if feat.upperBound == 1 else list(val)
            for t in targets:
                if t is None or id(t) not in object_ids:
                    continue
                tid = object_ids[id(t)]
                lines.append(f"  {oid} -->|{feat.name}| {tid}")
    return "\n".join(lines)
