"""Valida un script del LLM de principio a fin y lo convierte en una lista de incidencias con contexto."""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field

from ..codegen.generator import untranslatable_constraints
from ..ecore_service import Metamodel
from ..ocl.parser import ParsedConstraint
from . import analysis, export, sandbox
from .analysis import Issue
from .spec import MODULE_NAME, Scope, build_spec, describe_range

_CODE_CATEGORIES = {"syntax", "import", "forbidden", "contract", "runtime", "timeout"}


@dataclass
class Context:
    """Todo lo que hace falta para evaluar intentos de un mismo trabajo."""

    metamodel: Metamodel
    constraints: list[ParsedConstraint]
    module_code: str  # el módulo Pydantic neutro: lo que ve el LLM y lo que ejecuta el sandbox
    scope: Scope
    spec: dict = field(init=False)
    class_names: list[str] = field(init=False)
    untranslatable: list[ParsedConstraint] = field(init=False)

    def __post_init__(self) -> None:
        self.spec = build_spec(self.metamodel)
        self.class_names = list(self.metamodel.classes)
        self.untranslatable = untranslatable_constraints(self.metamodel, self.constraints)


@dataclass
class Evaluation:
    ok: bool
    issues: list[Issue]
    phase: str  # static | exec | validated
    graph: dict | None = None
    xmi: str | None = None
    scope_report: list[dict] = field(default_factory=list)
    stats: dict = field(default_factory=dict)
    stdout: str = ""


def _rule_location(module_code: str, message: str) -> tuple[int | None, str]:
    """Línea del módulo `models` donde está la comprobación de una regla, y su condición en Python."""
    needle = f'"{message}"'
    for number, text in enumerate(module_code.splitlines(), 1):
        if needle in text:
            condition = text.split("lambda:", 1)[1].strip() if "lambda:" in text else text.strip()
            return number, (condition[:-1] if condition.endswith(")") else condition)[:240]
    return None, ""


def _describe(o: dict) -> str:
    who = f"`{o['vars'][0]}` ({o['class']}" if o["vars"] else f"el objeto en `{o['path'] or '?'}` ({o['class']}"
    return who + (f", creado en la línea {o['line']})" if o["line"] else ")")


def _scope_report(scope: Scope, spec: dict, objects: list[dict]) -> tuple[list[dict], list[Issue]]:
    counts: Counter = Counter()
    for o in objects:
        for ancestor in spec[o["class"]]["ancestors"]:
            counts[ancestor] += 1
    rows, issues = [], []
    for name, (low, high) in scope.class_bounds.items():
        actual = counts.get(name, 0)
        ok = (low is None or actual >= low) and (high is None or actual <= high)
        rows.append({"class": name, "min": low, "max": high, "actual": actual, "ok": ok})
        if not ok:
            issues.append(Issue("scope", f"Hay {actual} instancia(s) de `{name}` (contando las de sus subclases) y se piden {describe_range(low, high)}."))
    if scope.total_min is not None or scope.total_max is not None:
        actual = len(objects)
        ok = (scope.total_min is None or actual >= scope.total_min) and (scope.total_max is None or actual <= scope.total_max)
        rows.append({"class": "(total)", "min": scope.total_min, "max": scope.total_max, "actual": actual, "ok": ok})
        if not ok:
            issues.append(Issue("scope", f"El modelo tiene {actual} objeto(s) en total y se piden {describe_range(scope.total_min, scope.total_max)}."))
    return rows, issues


def evaluate(code: str, ctx: Context, timeout: float = 20.0) -> Evaluation:
    # 1. análisis estático: sintaxis, imports, construcciones prohibidas, que se asigne `model`
    static = analysis.analyze(code, ctx.class_names)
    if static:
        return Evaluation(False, static, "static")

    # 2. ejecución aislada e instrumentada
    result = sandbox.run_script(ctx.module_code, code, ctx.spec, ctx.scope.root_class, timeout)
    if result.error:
        error = result.error
        frames = error.get("frames") or []
        message = error["message"]
        if error.get("details"):
            message += " — " + "; ".join(error["details"])
        if len(frames) > 1:
            message += " (pila: " + " → ".join(f"línea {f['line']}" for f in frames) + ")"
        last = frames[-1] if frames else {}
        return Evaluation(False, [Issue(error["category"], message, last.get("line"), last.get("code"))], "exec", stdout=result.stdout)

    report = result.report
    if "tooMany" in report:
        return Evaluation(False, [Issue("structure", f"El modelo tiene demasiados objetos ({report['tooMany']}); genera uno más pequeño.")], "exec")
    objects = report["objects"]
    by_id = {o["id"]: o for o in objects}
    issues: list[Issue] = []

    # 3. estructura: cómo están enlazados los objetos
    for item in report["structure"]:
        o = by_id[item["object"]]
        issues.append(Issue("structure", f"{_describe(o)}: {item['message']}", o["line"], None, o["id"]))
    for orphan in report["orphans"]:
        who = f"`{orphan['vars'][0]}` " if orphan["vars"] else ""
        issues.append(Issue("structure", f"Creaste un `{orphan['class']}` {who}que no está enlazado a `model` (no cuelga de ningún objeto). "
                                         "Añádelo al modelo o quítalo del script.", orphan["line"]))

    # 4. reglas de validez: TODAS las que incumple cada objeto, con la línea del módulo donde está la comprobación
    for v in report["violations"]:
        o = by_id[v["object"]]
        module_line = None
        if v["kind"] == "rule":
            line, condition = _rule_location(ctx.module_code, v["message"])
            module_line = line
            where = f" Está en el módulo `{MODULE_NAME}`, línea {line}: `{condition}`." if line else ""
            text = f"La regla `{v['message']}` no se cumple para {_describe(o)}.{where}"
        elif v["kind"] == "opposite":
            text = f"{_describe(o)}: {v['message']}. Asigna también el lado contrario de la referencia."
        else:
            text = f"{_describe(o)}: {v['message']}."
        issues.append(Issue("constraint", text, o["line"], None, o["id"], module_line))

    # 5. exportar a un modelo real; el intérprete comprueba las reglas que no se pueden traducir a Pydantic
    xmi, export_problem = None, None
    blocking = any(s["kind"] in ("abstract", "unknown_class") for s in report["structure"])
    if not blocking:
        try:
            root, created, attr_problems = export.build_pyecore(ctx.metamodel, ctx.spec, objects)
            xmi = export.to_xmi(ctx.metamodel, root)
            seen = {(i.category, i.obj, i.message) for i in issues}
            for f in export.interpreter_failures(ctx.metamodel, ctx.untranslatable, root, created):
                o = by_id.get(f["object"])
                source = next((c.source for c in ctx.untranslatable if c.name == f["name"] and c.context_class == f["contextClass"]), "")
                detail = f" ({f['error']})" if f["error"] else ""
                text = (f"La regla `{f['contextClass']}.{f['name']}` no se cumple" + (f" para {_describe(o)}" if o else "")
                        + f". Condición: `{source}`{detail}.")
                if ("constraint", f["object"], text) not in seen:
                    issues.append(Issue("constraint", text, o["line"] if o else None, None, o["id"] if o else None))
        except Exception as error:  # noqa: BLE001 - exporting is best-effort; the checks above are what matters
            export_problem = str(error)

    # 6. scope
    scope_rows, scope_issues = _scope_report(ctx.scope, ctx.spec, objects)
    issues.extend(scope_issues)

    problems: dict[int, list[str]] = {}
    for i in issues:
        if i.obj is not None:
            problems.setdefault(i.obj, []).append(i.message)
    graph = export.to_graph(ctx.spec, objects, problems)
    stats = {"objects": len(objects), "created": report["created"], "byType": graph["stats"]["byType"]}
    if export_problem:
        stats["exportProblem"] = export_problem
    return Evaluation(not issues, issues, "validated", graph, xmi, scope_rows, stats, result.stdout)
