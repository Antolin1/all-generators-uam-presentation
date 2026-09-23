import time

import pytest
from fastapi.testclient import TestClient

from app.llm import chain
from app.main import app
from app.state import state

from conftest import EXAMPLES, GOOD_YAKINDU, ScriptedLLM

BAD = "from models import Statechart\nmodel = Statechart.model_construct()\nmodel.nada.append(1)\n"
PAYLOAD = {"rootClass": "Statechart", "classBounds": {"State": {"min": 2, "max": 3}}, "maxIterations": 4, "model": "fake-model"}


@pytest.fixture()
def client(monkeypatch):
    state.metamodel = state.last_model = None
    state.constraints = []
    c = TestClient(app)
    with open(EXAMPLES / "yakindu_simplified.ecore", "rb") as f:
        assert c.post("/api/metamodel", files={"file": ("y.ecore", f)}).status_code == 200
    assert c.post("/api/constraints", json={"text": (EXAMPLES / "yakindu_constraints.ocl").read_text()}).status_code == 200
    return c


def wait(client, job_id, timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        job = client.get(f"/api/llm/jobs/{job_id}").json()
        if job["status"] != "running":
            return job
        time.sleep(0.1)
    raise AssertionError("el trabajo no terminó")


def test_setup_exposes_classes_and_the_code_the_llm_will_see(client, monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    data = client.get("/api/llm/setup").json()
    assert data["apiKeyConfigured"] is False and "Statechart" in data["rootCandidates"]
    assert "class Region(Entity)" in data["moduleCode"] and "OCL" not in data["moduleCode"]


def test_examples_bundle_metamodel_and_constraints(client):
    examples = {e["id"]: e for e in client.get("/api/examples").json()}
    assert {"yakindu", "family"} <= set(examples)
    yakindu = examples["yakindu"]
    assert yakindu["filename"].endswith(".ecore") and "<ecore:EPackage" in yakindu["ecore"]
    assert "context" in yakindu["ocl"] and "inv" in yakindu["ocl"]


def test_generate_requires_the_api_key(client, monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    response = client.post("/api/llm/generate", json=PAYLOAD)
    assert response.status_code == 503 and "OPENAI_API_KEY" in response.json()["detail"]


def test_scope_is_validated(client, monkeypatch):
    monkeypatch.setattr(chain, "create_llm", lambda model: ScriptedLLM().runnable)
    bad = dict(PAYLOAD, classBounds={"Nope": {"min": 1}})
    assert client.post("/api/llm/generate", json=bad).status_code == 400
    bad = dict(PAYLOAD, classBounds={"State": {"min": 5, "max": 2}})
    assert client.post("/api/llm/generate", json=bad).status_code == 400
    assert client.post("/api/llm/generate", json=dict(PAYLOAD, rootClass="Vertex")).status_code == 400  # abstract


def test_full_job_with_feedback_and_xmi_export(client, monkeypatch):
    llm = ScriptedLLM(BAD, GOOD_YAKINDU)
    monkeypatch.setattr(chain, "create_llm", lambda model: llm.runnable)
    job_id = client.post("/api/llm/generate", json=PAYLOAD).json()["jobId"]
    job = wait(client, job_id)

    assert job["status"] == "done" and job["valid"]
    first, second = job["attempts"]
    assert first["status"] == "failed" and first["issues"][0]["category"] == "runtime" and "nada" in first["feedback"]
    assert second["status"] == "ok" and second["hasXmi"] and second["graph"]["stats"]["objects"] == 9
    assert all(row["ok"] for row in second["scope"])

    xmi = client.get(f"/api/llm/jobs/{job_id}/attempts/2/xmi")
    assert xmi.status_code == 200 and "Statechart" in xmi.text
    assert client.get(f"/api/llm/jobs/{job_id}/attempts/1/xmi").status_code == 404

    # the exported XMI is a model the rest of the app accepts and validates as conforming
    check = client.post("/api/models", files={"file": ("m.xmi", xmi.content)}).json()
    assert check["conforms"] and check["pydanticCheck"]["ok"]


def test_the_prompts_shown_are_the_messages_sent_to_the_llm(client, monkeypatch):
    llm = ScriptedLLM(*[BAD] * 5)
    monkeypatch.setattr(chain, "create_llm", lambda model: llm.runnable)
    preview = client.post("/api/llm/prompt", json=PAYLOAD).json()
    job = wait(client, client.post("/api/llm/generate", json=dict(PAYLOAD, maxIterations=5)).json()["jobId"])

    system, task = llm.calls[0]
    assert job["prompt"] == preview == {"system": system.content, "task": task.content}
    assert "State" in task.content and "entre 2 y 3" in task.content  # the scope, in words
    # which earlier attempts (answer + feedback) each call carried: the history is trimmed to the last three
    assert [a["context"] for a in job["attempts"]] == [[], [1], [1, 2], [1, 2, 3], [2, 3, 4]]
    assert [len(call) for call in llm.calls] == [2, 4, 6, 8, 8]
    last = llm.calls[4]
    assert last[2].content == job["attempts"][1]["raw"] and last[3].content == job["attempts"][1]["feedback"]


def test_prompt_preview_needs_a_valid_scope(client):
    assert client.post("/api/llm/prompt", json=dict(PAYLOAD, rootClass="Nope")).status_code == 400


def test_llm_errors_are_reported_not_raised(client, monkeypatch):
    def broken(_):
        raise RuntimeError("Error code: 401 - invalid api key")
    monkeypatch.setattr(chain, "create_llm", lambda model: __import__("langchain_core.runnables", fromlist=["RunnableLambda"]).RunnableLambda(broken))
    job = wait(client, client.post("/api/llm/generate", json=PAYLOAD).json()["jobId"])
    assert job["status"] == "failed" and "invalid api key" in job["error"]


def test_error_messages_never_show_the_api_key(client, monkeypatch):
    from langchain_core.runnables import RunnableLambda

    monkeypatch.setenv("OPENAI_API_KEY", "sk-proj-abcdef1234567890")

    def broken(_):
        raise RuntimeError("Incorrect API key provided: sk-proj-abcdef1234567890, or sk-proj-************7890")

    monkeypatch.setattr(chain, "create_llm", lambda model: RunnableLambda(broken))
    job = wait(client, client.post("/api/llm/generate", json=PAYLOAD).json()["jobId"])
    assert job["status"] == "failed" and "abcdef" not in job["error"] and "sk-***" in job["error"]
