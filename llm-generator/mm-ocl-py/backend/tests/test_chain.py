import re

from app.llm import chain

from conftest import GOOD_YAKINDU, ScriptedLLM

BAD_IMPORT = "import networkx\nmodel = None\n"
# a Region without Entry, an Entry with an incoming transition, an orphan State, 4 States (at most 3 are allowed)
BAD_SEMANTIC = GOOD_YAKINDU.replace("link(start, idle)\n", "link(idle, start)\n") + '''
orphan = State.model_construct()
region.vertices.extend([State.model_construct(), State.model_construct()])
'''.replace("State.model_construct()", "State.model_construct()")


def texts(messages):
    return "\n".join(str(m.content) for m in messages)


def test_loop_fixes_code_then_semantics_then_succeeds(yakindu_ctx):
    llm = ScriptedLLM(BAD_IMPORT, BAD_SEMANTIC, GOOD_YAKINDU)
    outcome = chain.run_loop(llm.runnable, yakindu_ctx, max_iterations=5)

    assert outcome.ok and [a.evaluation.ok for a in outcome.attempts] == [False, False, True]

    # attempt 1: the code failure is reported as an import problem, and nothing about the rules yet
    first = outcome.attempts[0].feedback
    assert "[IMPORT]" in first and "networkx" in first and "[REGLA]" not in first

    # attempt 2: which rule failed for which object, the orphan, and the scope, each in its own section
    second = outcome.attempts[1].feedback
    assert "Entry.NoIncomingTransitions" in second and "`start`" in second
    assert "## Fallos de estructura" in second and "`orphan`" in second
    assert "## El modelo no respeta el tamaño pedido (scope)" in second and "`State`" in second

    # the LLM is called three times and each call carries the whole conversation so far
    assert [len(call) for call in llm.calls] == [2, 4, 6]
    assert "networkx" in texts(llm.calls[1]) and "Entry.NoIncomingTransitions" in texts(llm.calls[2])


def test_nothing_the_llm_sees_mentions_ocl_ecore_or_the_metamodel(yakindu_ctx):
    llm = ScriptedLLM(BAD_IMPORT, BAD_SEMANTIC, GOOD_YAKINDU)
    chain.run_loop(llm.runnable, yakindu_ctx, max_iterations=5)
    everything = "\n".join(texts(call) for call in llm.calls)
    assert not re.search(r"(?i)ocl|ecore|metamod", everything), re.findall(r"(?i).{30}(?:ocl|ecore|metamod).{30}", everything)[:3]
    assert "```python" in everything and "class Region(Entity)" in everything


def test_system_prompt_contains_the_pydantic_code(yakindu_ctx):
    text = chain.system_prompt(yakindu_ctx)
    assert "class Statechart(CompositeElement)" in text and "def check_constraints" in text


def test_task_message_contains_only_the_scope(yakindu_ctx):
    text = str(chain.task_message(yakindu_ctx).content)
    assert "Instancias de `State`" in text and "entre 2 y 3" in text and "Clase raíz: `Statechart`" in text
    assert "class Statechart" not in text and "check_constraints" not in text


def test_gives_up_after_max_iterations_and_keeps_every_attempt(yakindu_ctx):
    llm = ScriptedLLM(BAD_IMPORT, BAD_IMPORT)
    outcome = chain.run_loop(llm.runnable, yakindu_ctx, max_iterations=2)
    assert not outcome.ok and len(outcome.attempts) == 2 and outcome.attempts[-1].feedback is None


def test_response_without_a_code_block_is_a_failure_too(yakindu_ctx):
    llm = ScriptedLLM("RAW:Claro, aquí tienes el modelo: no puedo escribir código.", GOOD_YAKINDU)
    outcome = chain.run_loop(llm.runnable, yakindu_ctx, max_iterations=3)
    assert outcome.ok and "no contiene un bloque" in outcome.attempts[0].feedback


def test_cancel_stops_before_the_next_call(yakindu_ctx):
    llm = ScriptedLLM(BAD_IMPORT, GOOD_YAKINDU)
    calls = []
    outcome = chain.run_loop(llm.runnable, yakindu_ctx, 5, on_event=lambda name, _d: calls.append(name), should_stop=lambda: len(llm.calls) >= 1)
    assert outcome.cancelled and len(llm.calls) == 1


def test_extract_code_picks_the_longest_block():
    assert chain.extract_code("hola\n```python\nx = 1\n```\ny\n```python\nx = 1\ny = 2\n```") == "x = 1\ny = 2"
    assert chain.extract_code("nada de código") is None


def test_create_llm_requires_the_api_key(monkeypatch):
    import pytest
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with pytest.raises(chain.LlmConfigError):
        chain.create_llm("gpt-4.1")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    llm = chain.create_llm("gpt-4.1")
    assert llm.model_name == "gpt-4.1"
