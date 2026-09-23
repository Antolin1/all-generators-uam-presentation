"""Endpoints de la generación con LLM (se montan bajo /api/llm)."""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from ..codegen.generator import generate_pydantic_module, untranslatable_constraints
from ..state import state
from . import chain, jobs
from .report import Context
from .spec import Scope, ScopeError, root_candidates

router = APIRouter(prefix="/api")

_EXAMPLES_DIR = Path(__file__).resolve().parents[3] / "examples"
_EXAMPLES = [
    ("yakindu", "Yakindu · máquinas de estados", "yakindu_simplified.ecore", "yakindu_constraints.ocl"),
    ("family", "Familia · personas y mascotas", "family.ecore", "family_constraints.ocl"),
]


@router.get("/examples")
def examples():
    """Los pares metamodelo + restricciones de ejemplo que trae la aplicación."""
    result = []
    for key, title, ecore, ocl in _EXAMPLES:
        if (_EXAMPLES_DIR / ecore).is_file() and (_EXAMPLES_DIR / ocl).is_file():
            result.append({"id": key, "title": title, "filename": ecore,
                           "ecore": (_EXAMPLES_DIR / ecore).read_text(encoding="utf-8"),
                           "ocl": (_EXAMPLES_DIR / ocl).read_text(encoding="utf-8")})
    return result


def _require_inputs():
    if state.metamodel is None:
        raise HTTPException(status_code=400, detail="Sube primero un metamodelo .ecore.")
    return state.metamodel, list(state.constraints)


@router.get("/llm/setup")
def setup():
    """Lo que necesita la pestaña: estado de la clave, clases del metamodelo y el módulo Pydantic que verá el LLM."""
    base = {
        "apiKeyConfigured": chain.api_key_configured(),
        "canGenerate": chain.api_key_configured() or _llm_overridden(),
        "defaultModel": chain.default_model(),
        "modelSuggestions": chain.MODEL_SUGGESTIONS,
        "metamodelLoaded": state.metamodel is not None,
    }
    if state.metamodel is None:
        return base
    mm, constraints = _require_inputs()
    code, _warnings = generate_pydantic_module(mm, constraints, neutral=True)
    return {
        **base,
        "metamodelFilename": state.metamodel_filename,
        "constraintCount": len(constraints),
        "classes": [{"name": n, "abstract": i.abstract, "superTypes": i.super_types} for n, i in mm.classes.items()],
        "rootCandidates": root_candidates(mm),
        "moduleCode": code,
        "interpreterOnly": [f"{c.context_class}.{c.name}" for c in untranslatable_constraints(mm, constraints)],
    }


class GeneratePayload(BaseModel):
    rootClass: str
    classBounds: dict[str, dict] = {}
    totalMin: int | None = None
    totalMax: int | None = None
    model: str | None = None
    maxIterations: int = 5


def _context(payload: GeneratePayload) -> Context:
    mm, constraints = _require_inputs()
    try:
        scope = Scope.from_payload(payload.model_dump(), mm)
    except ScopeError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    module_code, _ = generate_pydantic_module(mm, constraints, neutral=True)
    return Context(metamodel=mm, constraints=constraints, module_code=module_code, scope=scope)


@router.post("/llm/prompt")
def prompt(payload: GeneratePayload):
    """Los mensajes de sistema y de usuario que recibiría el LLM en el primer intento con este scope (no llama al LLM)."""
    return chain.prompt_texts(_context(payload))


@router.post("/llm/generate")
def generate(payload: GeneratePayload):
    if not 1 <= payload.maxIterations <= 10:
        raise HTTPException(status_code=400, detail="El número de intentos debe estar entre 1 y 10.")
    ctx = _context(payload)
    if not chain.api_key_configured() and not _llm_overridden():
        raise HTTPException(status_code=503, detail="Falta la variable de entorno OPENAI_API_KEY: defínela antes de arrancar el servidor.")
    job = jobs.start(ctx, payload.model or chain.default_model(), payload.maxIterations)
    return {"jobId": job.id}


def _llm_overridden() -> bool:
    """¿Se ha sustituido la fábrica del LLM (tests)? Entonces no hace falta la clave."""
    return getattr(chain.create_llm, "__module__", "") != chain.__name__


def _job(job_id: str) -> jobs.Job:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Trabajo desconocido (¿se reinició el servidor?).")
    return job


@router.get("/llm/jobs/{job_id}")
def job_state(job_id: str):
    return _job(job_id).to_json()


@router.post("/llm/jobs/{job_id}/cancel")
def cancel(job_id: str):
    _job(job_id).cancel()
    return {"ok": True}


@router.get("/llm/jobs/{job_id}/attempts/{n}/xmi")
def export_xmi(job_id: str, n: int):
    xmi = _job(job_id).xmis.get(n)
    if xmi is None:
        raise HTTPException(status_code=404, detail="Ese intento no tiene un modelo exportable.")
    return Response(xmi, media_type="application/xml", headers={"Content-Disposition": f'attachment; filename="model-{job_id}-{n}.xmi"'})
