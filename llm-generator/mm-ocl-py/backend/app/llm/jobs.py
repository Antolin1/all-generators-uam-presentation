"""Trabajos de generación en segundo plano: el bucle con el LLM puede tardar minutos, la interfaz consulta el progreso."""
from __future__ import annotations

import os
import re
import threading
import time
import uuid
from collections import OrderedDict
from typing import Callable

from langchain_core.language_models.chat_models import BaseChatModel

from . import chain
from .report import Context

MAX_JOBS = 20


class Job:
    def __init__(self, ctx: Context, model: str, max_iterations: int) -> None:
        self.id = uuid.uuid4().hex[:12]
        self.ctx, self.model, self.max_iterations = ctx, model, max_iterations
        self.prompt = chain.prompt_texts(ctx)
        self.status = "running"  # running | done | failed | cancelled
        self.phase = "Preparando…"
        self.error: str | None = None
        self.attempts: list[dict] = []
        self.xmis: dict[int, str] = {}
        self.started, self.finished = time.time(), None
        self.usage = {"input_tokens": 0, "output_tokens": 0}
        self._stop = threading.Event()
        self._lock = threading.Lock()

    def cancel(self) -> None:
        self._stop.set()

    def to_json(self) -> dict:
        with self._lock:
            return {
                "id": self.id, "status": self.status, "phase": self.phase, "error": self.error, "model": self.model,
                "maxIterations": self.max_iterations, "prompt": self.prompt, "attempts": list(self.attempts), "usage": dict(self.usage),
                "seconds": round((self.finished or time.time()) - self.started, 1),
                "valid": self.status == "done" and bool(self.attempts) and self.attempts[-1]["status"] == "ok",
            }

    # --- events from the loop ---

    def _on_event(self, name: str, data: dict) -> None:
        with self._lock:
            if name == "llm_start":
                self.phase = f"Intento {data['n']}: esperando al LLM…"
                self.attempts.append({"n": data["n"], "status": "generating", "code": None, "issues": [], "feedback": None,
                                      "context": data["context"]})
            elif name == "llm_done":
                self.phase = f"Intento {data['n']}: validando el script…"
                self.attempts[-1].update(status="validating", code=data["code"], raw=data["raw"])
            elif name == "attempt":
                a, ev = data["attempt"], data["attempt"].evaluation
                self.attempts[-1].update(
                    status="ok" if ev.ok else "failed", phase=ev.phase, issues=[i.to_json() for i in ev.issues],
                    feedback=a.feedback, graph=ev.graph, scope=ev.scope_report, stats=ev.stats, stdout=ev.stdout,
                    hasXmi=ev.xmi is not None, seconds=round(a.seconds, 1), usage=a.usage)
                if ev.xmi is not None:
                    self.xmis[a.n] = ev.xmi
                self.usage["input_tokens"] += a.usage.get("input_tokens", 0)
                self.usage["output_tokens"] += a.usage.get("output_tokens", 0)

    def run(self, llm_factory: Callable[[str], BaseChatModel]) -> None:
        try:
            llm = llm_factory(self.model)
            outcome = chain.run_loop(llm, self.ctx, self.max_iterations, self._on_event, self._stop.is_set)
            with self._lock:
                self.status = "cancelled" if outcome.cancelled else "done"
                self.phase = "Cancelado" if outcome.cancelled else ("Modelo válido" if outcome.ok else "Sin modelo válido tras todos los intentos")
        except Exception as error:  # noqa: BLE001 - whatever the LLM/API raised is shown to the user
            with self._lock:
                self.status, self.phase = "failed", "Error"
                self.error = _redact(f"{type(error).__name__}: {error}")
        finally:
            self.finished = time.time()


def _redact(text: str) -> str:
    """Errors from the OpenAI client can echo (part of) the API key: never show it."""
    key = os.environ.get("OPENAI_API_KEY")
    if key:
        text = text.replace(key, "sk-***")
    return re.sub(r"sk-[\w\-*]{6,}", "sk-***", text)


_jobs: "OrderedDict[str, Job]" = OrderedDict()
_jobs_lock = threading.Lock()


def start(ctx: Context, model: str, max_iterations: int, llm_factory: Callable[[str], BaseChatModel] | None = None) -> Job:
    job = Job(ctx, model, max_iterations)
    with _jobs_lock:
        _jobs[job.id] = job
        while len(_jobs) > MAX_JOBS:
            _jobs.popitem(last=False)
    threading.Thread(target=job.run, args=(llm_factory or chain.create_llm,), daemon=True).start()
    return job


def get(job_id: str) -> Job | None:
    with _jobs_lock:
        return _jobs.get(job_id)
