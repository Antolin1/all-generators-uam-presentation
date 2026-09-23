from pathlib import Path

import pytest
from langchain_core.messages import AIMessage
from langchain_core.runnables import RunnableLambda

from app.codegen.generator import generate_pydantic_module
from app.ecore_service import load_ecore
from app.llm.report import Context
from app.llm.spec import Scope
from app.ocl.parser import parse_constraints

EXAMPLES = Path(__file__).resolve().parents[2] / "examples"

GOOD_YAKINDU = '''
from models import Statechart, Region, Entry, State, FinalState, Transition

statechart = Statechart.model_construct()
region = Region.model_construct()
start = Entry.model_construct()
idle = State.model_construct()
running = State.model_construct()
done = FinalState.model_construct()

def link(a, b):
    t = Transition.model_construct(source=a, target=b)
    a.outgoing_transitions.append(t)
    b.incoming_transitions.append(t)

link(start, idle)
link(idle, running)
link(running, done)
region.vertices.extend([start, idle, running, done])
statechart.regions.append(region)
model = statechart
'''


@pytest.fixture(scope="session")
def yakindu():
    metamodel = load_ecore(str(EXAMPLES / "yakindu_simplified.ecore"))
    constraints = parse_constraints((EXAMPLES / "yakindu_constraints.ocl").read_text())
    return metamodel, constraints


@pytest.fixture()
def yakindu_ctx(yakindu):
    metamodel, constraints = yakindu
    module, _ = generate_pydantic_module(metamodel, constraints, neutral=True)
    scope = Scope.from_payload({"rootClass": "Statechart", "classBounds": {"State": {"min": 2, "max": 3}, "Region": {"min": 1, "max": 1}}}, metamodel)
    return Context(metamodel, constraints, module, scope)


class ScriptedLLM:
    """Un LLM de mentira: un Runnable de LangChain que devuelve respuestas guionizadas y recuerda lo que recibió."""

    def __init__(self, *replies):
        self.replies, self.calls = list(replies), []
        self.runnable = RunnableLambda(self._answer)

    def _answer(self, prompt_value):
        self.calls.append(prompt_value.to_messages())
        reply = self.replies.pop(0)
        return AIMessage(content=f"```python\n{reply}\n```" if not reply.startswith("RAW:") else reply[4:])
