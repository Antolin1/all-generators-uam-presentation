"""Loading .ecore metamodels with pyecore and turning them into diagram-ready data.

Per the project's scope, EAttributes are not rendered in the class diagram
nor specially validated by the web validator - only EClass, inheritance and
EReference (with containment + multiplicity) show up there. They are still
captured in `ClassInfo.attributes` because the Pydantic code generator
(codegen/) needs real field types to produce runnable classes, and because
the full metamodel (attributes included) is always registered with pyecore
so that real-world .xmi files - which usually do carry attribute values -
load without spurious "unknown feature" errors.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from pyecore.ecore import EAttribute, EClass, EPackage, EReference
from pyecore.resources import ResourceSet, URI


class EcoreLoadError(Exception):
    pass


@dataclass
class ReferenceInfo:
    name: str
    target: str
    containment: bool
    lower: int
    upper: int
    opposite: str | None = None


@dataclass
class AttributeInfo:
    name: str
    type_name: str
    lower: int
    upper: int


@dataclass
class ClassInfo:
    name: str
    abstract: bool
    super_types: list[str] = field(default_factory=list)
    references: list[ReferenceInfo] = field(default_factory=list)
    attributes: list[AttributeInfo] = field(default_factory=list)


@dataclass
class Metamodel:
    package_name: str
    resource_set: ResourceSet
    classes: dict[str, ClassInfo]
    class_registry: dict[str, type]
    mermaid: str


def _iter_packages(root):
    yield root
    for sub in getattr(root, "eSubpackages", []):
        yield from _iter_packages(sub)


def _mult(lower: int, upper: int) -> str:
    up = "*" if upper == -1 else str(upper)
    if lower == upper:
        return str(lower) if lower != -1 else "*"
    return f"{lower}..{up}"


def load_ecore(path: str) -> Metamodel:
    rset = ResourceSet()
    try:
        resource = rset.get_resource(URI(path))
        roots = list(resource.contents)
    except Exception as e:  # noqa: BLE001 - surface any parse failure to the user
        raise EcoreLoadError(f"No se pudo interpretar el fichero .ecore: {e}") from e

    if not roots:
        raise EcoreLoadError("El fichero .ecore no contiene ningún EPackage.")

    packages: list[EPackage] = []
    for root in roots:
        if isinstance(root, EPackage):
            packages.extend(_iter_packages(root))
    if not packages:
        raise EcoreLoadError("El fichero .ecore no define ningún EPackage válido.")

    for pkg in packages:
        if pkg.nsURI:
            rset.metamodel_registry[pkg.nsURI] = pkg

    classes: dict[str, ClassInfo] = {}
    class_registry: dict[str, type] = {}
    for pkg in packages:
        for classifier in pkg.eClassifiers:
            if not isinstance(classifier, EClass):
                continue
            info = ClassInfo(
                name=classifier.name,
                abstract=bool(classifier.abstract),
                super_types=[s.name for s in classifier.eSuperTypes],
            )
            for feat in classifier.eStructuralFeatures:
                if isinstance(feat, EReference):
                    info.references.append(
                        ReferenceInfo(
                            name=feat.name,
                            target=feat.eType.name if feat.eType else "?",
                            containment=bool(feat.containment),
                            lower=feat.lowerBound,
                            upper=feat.upperBound,
                            opposite=feat.eOpposite.name if feat.eOpposite else None,
                        )
                    )
                elif isinstance(feat, EAttribute):
                    info.attributes.append(
                        AttributeInfo(
                            name=feat.name,
                            type_name=feat.eType.name if feat.eType else "?",
                            lower=feat.lowerBound,
                            upper=feat.upperBound,
                        )
                    )
            classes[classifier.name] = info
            class_registry[classifier.name] = classifier

    mermaid = _build_mermaid(classes)
    return Metamodel(
        package_name=packages[0].name,
        resource_set=rset,
        classes=classes,
        class_registry=class_registry,
        mermaid=mermaid,
    )


def _build_mermaid(classes: dict[str, ClassInfo]) -> str:
    lines = ["classDiagram"]
    for name, info in classes.items():
        lines.append(f"  class {name}")
        if info.abstract:
            lines.append(f"  <<abstract>> {name}")
    for name, info in classes.items():
        for parent in info.super_types:
            lines.append(f"  {parent} <|-- {name}")
    for name, info in classes.items():
        for ref in info.references:
            arrow = "*--" if ref.containment else "-->"
            mult = _mult(ref.lower, ref.upper)
            lines.append(f'  {name} "1" {arrow} "{mult}" {ref.target} : {ref.name}')
    if len(lines) == 1:
        lines.append("  class Empty")
    return "\n".join(lines)
