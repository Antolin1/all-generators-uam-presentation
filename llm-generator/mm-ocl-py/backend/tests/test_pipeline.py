from app.llm.report import evaluate

from conftest import GOOD_YAKINDU


def by_category(evaluation):
    return {i.category for i in evaluation.issues}


def test_valid_script_passes_and_exports_a_model(yakindu_ctx):
    ev = evaluate(GOOD_YAKINDU, yakindu_ctx)
    assert ev.ok, [i.message for i in ev.issues]
    assert ev.xmi and "Statechart" in ev.xmi
    assert {n["type"] for n in ev.graph["nodes"]} == {"Statechart", "Region", "Entry", "State", "FinalState", "Transition"}
    assert all(row["ok"] for row in ev.scope_report)


def test_runtime_error_reports_line_and_source(yakindu_ctx):
    ev = evaluate("from models import Statechart\ns = Statechart.model_construct()\ns.nothing.append(1)\nmodel = s\n", yakindu_ctx)
    [issue] = ev.issues
    assert issue.category == "runtime" and issue.line == 3 and "nothing" in issue.message and issue.code == "s.nothing.append(1)"


def test_disallowed_import_is_caught_before_running(yakindu_ctx):
    ev = evaluate("import socket\nmodel = None\n", yakindu_ctx)
    assert ev.phase == "static" and by_category(ev) == {"import"}


def test_the_script_cannot_see_environment_variables(yakindu_ctx, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-secret")
    ev = evaluate("import os\nmodel = os.environ\n", yakindu_ctx)  # os is not importable at all
    assert by_category(ev) == {"import"}


def test_infinite_loop_times_out(yakindu_ctx):
    ev = evaluate("while True:\n    pass\nmodel = 1\n", yakindu_ctx, timeout=2)
    assert by_category(ev) == {"timeout"}


def test_wrong_root_class_is_a_contract_failure(yakindu_ctx):
    ev = evaluate("from models import Region\nmodel = Region.model_construct()\n", yakindu_ctx)
    assert by_category(ev) == {"contract"} and "Statechart" in ev.issues[0].message


def test_which_rule_failed_for_which_object_and_where(yakindu_ctx):
    code = GOOD_YAKINDU.replace("link(start, idle)\n", "link(idle, start)\n")
    ev = evaluate(code, yakindu_ctx)
    rules = {i.message.split("`")[1] for i in ev.issues if i.category == "constraint"}
    assert rules == {"Entry.NoIncomingTransitions", "Entry.HasOutgoingTransition"}
    issue = next(i for i in ev.issues if "NoIncomingTransitions" in i.message)
    assert "`start`" in issue.message and "creado en la línea" in issue.message and "módulo `models`, línea" in issue.message
    assert issue.obj is not None  # to highlight the object in the graph
    # the frontend jumps to this line of the module the LLM was shown
    module_line = issue.to_json()["moduleLine"]
    assert "Entry.NoIncomingTransitions" in yakindu_ctx.module_code.splitlines()[module_line - 1]


def test_orphans_missing_fields_and_scope(yakindu_ctx):
    code = GOOD_YAKINDU + "\nextra = State.model_construct()\nmodel.regions[0].vertices.extend([State.model_construct(), State.model_construct()])\n"
    ev = evaluate(code.replace("from models import Statechart,", "from models import State, Statechart,"), yakindu_ctx)
    messages = " | ".join(i.message for i in ev.issues)
    assert "que no está enlazado a `model`" in messages  # `extra` is an orphan
    assert any(i.category == "scope" and "`State`" in i.message for i in ev.issues)  # 4 states, at most 3
    assert not all(row["ok"] for row in ev.scope_report)


def test_object_without_mandatory_field_is_reported(yakindu_ctx):
    code = GOOD_YAKINDU.replace("Transition.model_construct(source=a, target=b)", "Transition.model_construct(source=a)")
    ev = evaluate(code, yakindu_ctx)
    assert any("'target' es obligatorio y no está asignado" in i.message for i in ev.issues)


def test_object_contained_twice_and_abstract_instance(yakindu_ctx):
    twice = GOOD_YAKINDU + "\nsecond = Region.model_construct()\nsecond.vertices.append(idle)\nstatechart.regions.append(second)\n"
    assert any("como hijo de 2 objetos" in i.message for i in evaluate(twice, yakindu_ctx).issues)
    abstract = GOOD_YAKINDU.replace("Entry, State,", "Entry, Vertex, State,") + "\nregion.vertices.append(Vertex.model_construct())\n"
    ev = evaluate(abstract, yakindu_ctx)
    assert any("clase abstracta" in i.message for i in ev.issues) and ev.xmi is None
