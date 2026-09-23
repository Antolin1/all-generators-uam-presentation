"""Ejecuta el script del LLM aislado y devuelve un informe JSON. Se lanza como subproceso (ver sandbox.py).

Es un fichero autónomo (solo usa la biblioteca estándar y el módulo Pydantic generado, que recibe como
texto), para poder ejecutarse con `python -I` y un entorno vacío: el script del LLM no ve ninguna variable
de entorno, como `OPENAI_API_KEY`. Entrada: JSON por stdin. Salida: `RESULT_MARK` + JSON por stdout.

Aquí es donde actúa la metaprogramación: el módulo generado se carga dinámicamente con `exec`, se
instrumenta (gancho `_on_create`) para saber en qué línea del script se creó cada objeto, se ejecuta el
script con `builtins` e imports restringidos, se recorren los objetos para nombrarlos por su variable o su
ruta de contención, y se invoca `check_constraints()` en cada uno para saber QUÉ restricción viola QUÉ objeto.
"""
import builtins
import io
import json
import sys
import traceback
import types

RESULT_MARK = "\x00RESULT\x00"
MAX_OBJECTS = 3000

SAFE_BUILTINS = (
    "abs all any bool bytes callable chr dict divmod enumerate filter float format frozenset getattr hasattr hash id int "
    "isinstance issubclass iter len list map max min next object ord pow print range repr reversed round set setattr "
    "slice sorted str sum super tuple type zip "
    "Exception ValueError TypeError KeyError IndexError AttributeError RuntimeError StopIteration NotImplementedError "
    "ZeroDivisionError AssertionError ArithmeticError LookupError"
).split()


def _limits():
    try:
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (2 << 30, 2 << 30))
        resource.setrlimit(resource.RLIMIT_CPU, (30, 30))
    except Exception:  # noqa: BLE001 - not available on every platform
        pass


def _builtins(allowed_modules):
    safe = {name: getattr(builtins, name) for name in SAFE_BUILTINS}

    def guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
        if level != 0 or name.split(".")[0] not in allowed_modules:
            raise ImportError(f"import no permitido: {name!r}")
        return builtins.__import__(name, globals, locals, fromlist, level)

    safe["__import__"] = guarded_import
    safe["__build_class__"] = builtins.__build_class__
    safe["__name__"] = "llm_model"
    return safe


def _describe(error, llm_lines):
    frames = []
    for frame in traceback.extract_tb(error.__traceback__):
        if frame.filename == "<llm_model>":
            text = llm_lines[frame.lineno - 1].strip() if 0 < frame.lineno <= len(llm_lines) else ""
            frames.append({"line": frame.lineno, "code": text, "function": frame.name})
    if isinstance(error, SyntaxError):
        category, frames = "syntax", [{"line": error.lineno, "code": (error.text or "").strip(), "function": "<module>"}]
    elif isinstance(error, ImportError):
        category = "import"
    else:
        category = "runtime"
    message = f"{type(error).__name__}: {error}"
    details = []
    errors = getattr(error, "errors", None)
    if callable(errors):
        try:
            for item in errors()[:8]:
                details.append(f"{'.'.join(str(p) for p in item.get('loc', ()))}: {item.get('msg')}")
        except Exception:  # noqa: BLE001
            pass
    return {"category": category, "message": message[:1500], "frames": frames[-4:], "details": details}


def _json_value(value):
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, (list, tuple, set)):
        return [_json_value(v) for v in value]
    return str(value)


def run(payload):
    _limits()
    spec, root_class = payload["spec"], payload["rootClass"]
    llm_lines = payload["llmCode"].splitlines()

    module = types.ModuleType(payload["moduleName"])
    try:
        exec(compile(payload["moduleCode"], "<models>", "exec"), module.__dict__)
    except BaseException as error:  # noqa: BLE001
        return {"phase": "internal", "error": {"category": "internal", "message": f"El módulo de clases no se pudo cargar: {error}", "frames": [], "details": []}}
    sys.modules[payload["moduleName"]] = module

    created, lines = [], {}

    def on_create(obj):
        created.append(obj)
        frame = sys._getframe(1)
        while frame is not None and frame.f_code.co_filename != "<llm_model>":
            frame = frame.f_back
        lines[id(obj)] = frame.f_lineno if frame is not None else None

    module._on_create = on_create

    namespace = {"__name__": "llm_model", "__builtins__": _builtins(set(payload["allowedModules"]))}
    real_stdout, captured = sys.stdout, io.StringIO()
    sys.stdout = captured
    error = None
    try:
        exec(compile(payload["llmCode"], "<llm_model>", "exec"), namespace)
    except BaseException as exc:  # noqa: BLE001 - whatever the script does, report it
        error = _describe(exc, llm_lines)
    finally:
        sys.stdout = real_stdout
    printed = captured.getvalue()[:2000]
    if error is not None:
        return {"phase": "exec", "error": error, "stdout": printed}

    if "model" not in namespace:
        return {"phase": "exec", "stdout": printed, "error": {"category": "contract", "message": "El script terminó pero no definió la variable `model`.", "frames": [], "details": []}}
    model, Entity = namespace["model"], module.__dict__[payload["entityName"]]
    root_type = module.__dict__.get(root_class)
    if not isinstance(model, Entity):
        return {"phase": "exec", "stdout": printed, "error": {"category": "contract", "message": f"`model` debe ser el objeto raíz (una instancia de `{root_class}`), pero es {type(model).__name__}.", "frames": [], "details": []}}
    if root_type is None or not isinstance(model, root_type):
        return {"phase": "exec", "stdout": printed, "error": {"category": "contract", "message": f"`model` debe ser una instancia de `{root_class}` (o de una subclase), pero es de tipo `{type(model).__name__}`.", "frames": [], "details": []}}

    return {"phase": "done", "stdout": printed, "report": _inspect(module, spec, model, namespace, created, lines, payload["entityName"])}


def _inspect(module, spec, model, namespace, created, lines, entity_name):
    Entity = module.__dict__[entity_name]
    reachable = list(module.iter_objects(model))
    if len(reachable) > MAX_OBJECTS:
        return {"tooMany": len(reachable)}
    ids = {id(o): i for i, o in enumerate(reachable)}
    kind = lambda o: type(o).__name__  # noqa: E731

    def edges(obj, containment_only):
        result = []
        for field, ref in spec.get(kind(obj), {}).get("refs", {}).items():
            value = obj.__dict__.get(field)
            if value is None:
                continue
            for index, target in enumerate(value if isinstance(value, list) else [value]):
                if isinstance(target, Entity):
                    if not containment_only or ref["containment"]:
                        result.append((field, index if isinstance(value, list) else None, target, ref))
        return result

    # variable names the script gave to objects (metaprogramming: introspect the script's namespace)
    variables = {}
    for name, value in namespace.items():
        if name.startswith("_"):
            continue
        items = [(name, value)]
        if isinstance(value, (list, tuple)):
            items = [(f"{name}[{i}]", v) for i, v in enumerate(value)]
        elif isinstance(value, dict):
            items = [(f"{name}[{k!r}]", v) for k, v in value.items()]
        for label, v in items:
            if isinstance(v, Entity):
                variables.setdefault(id(v), []).append(label)

    # containment tree from the root: path of each object, and who contains whom
    paths, contained, parents = {id(model): "model"}, {id(model)}, {}
    queue = [model]
    while queue:
        obj = queue.pop(0)
        for field, index, target, _ref in edges(obj, True):
            parents[id(target)] = parents.get(id(target), 0) + 1
            if id(target) not in contained:
                contained.add(id(target))
                paths[id(target)] = f"{paths[id(obj)]}.{field}" + (f"[{index}]" if index is not None else "")
                queue.append(target)

    structure = []
    for obj in reachable:
        oid, cls = ids[id(obj)], spec.get(kind(obj))
        if cls is None:
            structure.append({"kind": "unknown_class", "object": oid, "message": f"La clase `{kind(obj)}` no pertenece al módulo `models`."})
            continue
        if cls["abstract"]:
            structure.append({"kind": "abstract", "object": oid, "message": f"`{kind(obj)}` es una clase abstracta: no se puede instanciar (usa una subclase concreta)."})
        if id(obj) not in contained:
            structure.append({"kind": "not_contained", "object": oid, "message": f"Este `{kind(obj)}` no cuelga de `model`: ningún objeto lo tiene entre sus hijos (campos marcados como «hijos»). Añádelo al campo de hijos de su objeto padre."})
        if parents.get(id(obj), 0) > 1:
            structure.append({"kind": "multi_contained", "object": oid, "message": f"Este `{kind(obj)}` está como hijo de {parents[id(obj)]} objetos a la vez; solo puede tener un padre."})
        for field, ref in cls["refs"].items():
            value = obj.__dict__.get(field)
            if value is None:
                continue
            target_class = module.__dict__.get(ref["target"])
            many = ref["upper"] != 1
            if many and not isinstance(value, list):
                structure.append({"kind": "shape", "object": oid, "message": f"`{field}` debe ser una lista (admite varios elementos), pero es `{type(value).__name__}`."})
                continue
            if not many and isinstance(value, list):
                structure.append({"kind": "shape", "object": oid, "message": f"`{field}` admite un solo elemento, no una lista."})
                continue
            values = value if isinstance(value, list) else [value]
            for item in values:
                if not isinstance(item, Entity) or (target_class is not None and not isinstance(item, target_class)):
                    structure.append({"kind": "wrong_type", "object": oid, "message": f"`{field}` debe contener objetos `{ref['target']}`, pero contiene {item!r:.60}."})
                    break
            if many and ref["upper"] > 0 and len(values) > ref["upper"]:
                structure.append({"kind": "upper", "object": oid, "message": f"`{field}` admite como máximo {ref['upper']} elemento(s) y tiene {len(values)}."})

    violations = []
    for obj in reachable:
        try:
            found = obj.check_constraints()
        except Exception as exc:  # noqa: BLE001
            found = [("error", "check_constraints", f"no se pudieron comprobar las restricciones: {type(exc).__name__}: {exc}")]
        for kind_, name, message in found:
            violations.append({"kind": kind_, "name": name, "message": message, "object": ids[id(obj)]})

    objects = []
    for obj in reachable:
        cls = spec.get(kind(obj), {"refs": {}, "attrs": {}})
        objects.append({
            "id": ids[id(obj)], "class": kind(obj), "vars": variables.get(id(obj), []), "path": paths.get(id(obj)),
            "line": lines.get(id(obj)),
            "attrs": {f: _json_value(obj.__dict__.get(f)) for f in cls["attrs"] if f in obj.__dict__},
            "refs": {f: ([ids[id(t)] for t in v if isinstance(t, Entity) and id(t) in ids] if isinstance(v, list)
                         else (ids.get(id(v)) if isinstance(v, Entity) else None))
                     for f in cls["refs"] for v in [obj.__dict__.get(f)] if f in obj.__dict__},
        })
    orphans = [{"class": kind(o), "vars": variables.get(id(o), []), "line": lines.get(id(o))}
               for o in created if id(o) not in ids]
    return {"objects": objects, "structure": structure, "violations": violations, "orphans": orphans[:50], "created": len(created)}


if __name__ == "__main__":
    sys.dont_write_bytecode = True
    output = run(json.loads(sys.stdin.read()))
    sys.stdout.write(RESULT_MARK + json.dumps(output))
    sys.stdout.flush()
