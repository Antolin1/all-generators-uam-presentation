"""Del informe del sandbox al resto: modelo pyecore (para exportar XMI y para el intérprete OCL) y grafo para la interfaz."""
from __future__ import annotations

import re
import tempfile
from pathlib import Path

from pyecore.resources import ResourceSet, URI

from ..ecore_service import Metamodel
from ..ocl.parser import ParsedConstraint
from ..validation import run_constraints
from ..xmi_service import LoadedModel


def build_pyecore(metamodel: Metamodel, spec: dict, objects: list[dict]):
    """Reconstruye el modelo como objetos pyecore. Devuelve (raíz, {id: objeto}, [problemas])."""
    created, problems = {}, []
    for o in objects:
        cls = metamodel.class_registry.get(o["class"])
        if cls is None or spec[o["class"]]["abstract"]:
            raise ValueError(f"No se puede instanciar `{o['class']}` en el modelo exportable.")
        created[o["id"]] = cls()
    for o in objects:
        target, cspec = created[o["id"]], spec[o["class"]]
        for field, value in o["attrs"].items():
            info = cspec["attrs"][field]
            try:
                if info["upper"] != 1:
                    getattr(target, info["name"]).extend(value if isinstance(value, list) else [value])
                elif value is not None:
                    setattr(target, info["name"], value)
            except Exception as error:  # noqa: BLE001 - pyecore is strict about attribute types
                problems.append(f"{o['class']}.{field}: {error}")
        for field, value in o["refs"].items():
            info = cspec["refs"][field]
            try:
                if info["upper"] != 1:
                    collection = getattr(target, info["name"])
                    for t in value or []:
                        if created[t] not in collection:
                            collection.append(created[t])
                elif value is not None:
                    setattr(target, info["name"], created[value])
            except Exception as error:  # noqa: BLE001
                problems.append(f"{o['class']}.{field}: {error}")
    return created[0], created, problems


def to_xmi(metamodel: Metamodel, root) -> str:
    resource_set = ResourceSet()
    resource_set.metamodel_registry.update(metamodel.resource_set.metamodel_registry)
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "model.xmi"
        resource = resource_set.create_resource(URI(str(path)))
        resource.append(root)
        resource.save()
        return path.read_text(encoding="utf-8")


def interpreter_failures(metamodel: Metamodel, constraints: list[ParsedConstraint], root, created: dict) -> list[dict]:
    """Comprueba con el intérprete OCL las restricciones que no se pueden traducir a Pydantic (p. ej. `allInstances()`).

    Devuelve [{name, contextClass, object, error}] con `object` = id del objeto del informe.
    """
    if not constraints:
        return []
    all_objects = [root, *root.eAllContents()]
    by_pyobj = {id(py): oid for oid, py in created.items()}
    object_ids = {id(o): f"o{by_pyobj.get(id(o), -1)}" for o in all_objects}
    loaded = LoadedModel(roots=[root], all_objects=all_objects, object_ids=object_ids)
    failures = []
    for r in run_constraints(constraints, loaded, metamodel.class_registry):
        if not r.passed:
            match = re.match(r"o(-?\d+)", r.object_label)
            failures.append({"name": r.constraint_name, "contextClass": r.context_class, "error": r.error,
                             "object": int(match.group(1)) if match and int(match.group(1)) >= 0 else None})
    return failures


def to_graph(spec: dict, objects: list[dict], problems: dict[int, list[str]]) -> dict:
    """Grafo del modelo para la interfaz: un nodo por objeto y una arista por referencia (sin duplicar las inversas)."""
    by_id = {o["id"]: o for o in objects}
    present = set()
    for o in objects:
        for field, value in o["refs"].items():
            for t in (value if isinstance(value, list) else [value]):
                if t is not None:
                    present.add((o["id"], field, t))
    edges = []
    for o in objects:
        cspec = spec[o["class"]]["refs"]
        for field, value in o["refs"].items():
            ref = cspec[field]
            for t in (value if isinstance(value, list) else [value]):
                if t is None or t not in by_id:
                    continue
                opposite = ref["opposite"]
                if not ref["containment"] and opposite:
                    other = spec[by_id[t]["class"]]["refs"].get(opposite)
                    if other is not None:
                        if other["containment"]:
                            continue  # el campo del hijo que apunta a su padre: ya lo dice la contención
                        if (t, opposite, o["id"]) in present:
                            if ref["upper"] != 1 and other["upper"] == 1:
                                continue  # se dibuja el lado de un solo valor
                            if (ref["upper"] == 1) == (other["upper"] == 1) and field > opposite:
                                continue
                edges.append({"id": f"e{len(edges)}", "source": f"n{o['id']}", "target": f"n{t}", "name": field,
                              "kind": "containment" if ref["containment"] else "reference"})
    nodes = []
    for o in objects:
        label = o["attrs"].get("name") if isinstance(o["attrs"].get("name"), str) else None
        attrs = [{"name": k, "value": ", ".join(map(str, v)) if isinstance(v, list) else str(v)}
                 for k, v in o["attrs"].items() if v not in (None, [], "") and k != "name"]
        nodes.append({"id": f"n{o['id']}", "type": o["class"], "abstract": spec[o["class"]]["abstract"],
                      "name": label or (o["vars"][0] if o["vars"] else None), "external": False, "implicit": False,
                      "attributes": attrs, "rule": o["class"], "app": None,
                      "problems": problems.get(o["id"], []), "line": o["line"]})
    by_type: dict[str, int] = {}
    for o in objects:
        by_type[o["class"]] = by_type.get(o["class"], 0) + 1
    return {"root": "n0", "nodes": nodes, "edges": edges,
            "stats": {"objects": len(nodes), "edges": len(edges), "containments": sum(e["kind"] == "containment" for e in edges), "byType": by_type}}
