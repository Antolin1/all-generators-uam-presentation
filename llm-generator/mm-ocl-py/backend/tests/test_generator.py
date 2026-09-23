import re

from app.codegen.generator import generate_pydantic_module, untranslatable_constraints
from app.codegen.xmi_bridge import build_pydantic_objects, cross_check_model, load_generated_namespace
from app.xmi_service import load_xmi

from conftest import EXAMPLES


def test_neutral_module_never_mentions_ocl_ecore_or_the_metamodel(yakindu):
    metamodel, constraints = yakindu
    neutral, _ = generate_pydantic_module(metamodel, constraints, neutral=True)
    assert not re.search(r"(?i)ocl|ecore|metamod|mm-ocl|eopposite|contenci", neutral)
    assert "class Entity(BaseModel)" in neutral


def test_full_module_keeps_working_and_documents_the_ocl(yakindu):
    metamodel, constraints = yakindu
    full, _ = generate_pydantic_module(metamodel, constraints)
    assert "OclEntity" in full and "HasEntry" in full
    valid = load_xmi(str(EXAMPLES / "yakindu_valid.xmi"), metamodel)
    invalid = load_xmi(str(EXAMPLES / "yakindu_invalid.xmi"), metamodel)
    assert cross_check_model(valid.all_objects, valid.roots, full)["ok"]
    assert not cross_check_model(invalid.all_objects, invalid.roots, full)["ok"]


def test_collect_violations_reports_every_violation_not_just_the_first(yakindu):
    metamodel, constraints = yakindu
    full, _ = generate_pydantic_module(metamodel, constraints)
    invalid = load_xmi(str(EXAMPLES / "yakindu_invalid.xmi"), metamodel)
    namespace = load_generated_namespace(full)
    cache = build_pydantic_objects(invalid.all_objects, namespace)
    found = namespace["collect_violations"](cache[id(invalid.roots[0])])
    assert {(type(o).__name__, name) for o, _kind, name, _m in found} == {
        ("Region", "AtMostOneEntry"), ("Region", "HasState"), ("Entry", "NoIncomingTransitions"), ("Exit", "NoOutgoingTransitions")}


def test_rules_of_a_superclass_apply_to_its_subclasses():
    from app.ecore_service import load_ecore
    from app.ocl.parser import parse_constraints
    metamodel = load_ecore(str(EXAMPLES / "yakindu_simplified.ecore"))
    # the rule is declared on Vertex (abstract); State inherits from Vertex through RegularState
    constraints = parse_constraints("context Vertex inv NoIncoming: self.incomingTransitions->isEmpty()")
    code, _ = generate_pydantic_module(metamodel, constraints, neutral=True)
    namespace = {}
    exec(compile(code, "<m>", "exec"), namespace)
    State, Transition = namespace["State"], namespace["Transition"]
    t = Transition.model_construct(source=None)
    state = State.model_construct(incoming_transitions=[t], outgoing_transitions=[], regions=[])
    t.target = state
    assert ("rule", "NoIncoming", "Vertex.NoIncoming") in state.check_constraints()
    assert ("rule", "NoIncoming", "Vertex.NoIncoming") not in State.model_construct(incoming_transitions=[], outgoing_transitions=[], regions=[]).check_constraints()


def test_untranslatable_constraints_are_listed(yakindu):
    from app.ocl.parser import parse_constraints
    metamodel, _ = yakindu
    constraints = parse_constraints("context Region inv Global: Region.allInstances()->size() < 5")
    assert [c.name for c in untranslatable_constraints(metamodel, constraints)] == ["Global"]
