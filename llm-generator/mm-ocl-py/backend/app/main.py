from __future__ import annotations

import tempfile
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from pydantic import BaseModel

from .codegen.generator import generate_pydantic_module
from .codegen.xmi_bridge import cross_check_model
from .ecore_service import EcoreLoadError, load_ecore
from .llm.api import router as llm_router
from .ocl.errors import OclParseError
from .ocl.parser import parse_constraints
from .state import state
from .validation import run_constraints
from .xmi_service import XmiLoadError, load_xmi

app = FastAPI(title="mm-ocl-py")

# Sin CORS abierto: la interfaz (otro contenedor, con nginx delante) llama a la API en el mismo origen. Con
# `allow_origins=["*"]` cualquier web abierta en el navegador podría llamar a esta API local y gastar la clave de OpenAI.


def _save_upload(upload: UploadFile, suffix: str) -> str:
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(upload.file.read())
        return tmp.name


def _metamodel_payload() -> dict:
    mm = state.metamodel
    if mm is None:
        return {"loaded": False}
    classes = []
    for name, info in mm.classes.items():
        classes.append(
            {
                "name": name,
                "abstract": info.abstract,
                "superTypes": info.super_types,
                "references": [
                    {
                        "name": r.name,
                        "target": r.target,
                        "containment": r.containment,
                        "lower": r.lower,
                        "upper": r.upper,
                    }
                    for r in info.references
                ],
            }
        )
    return {
        "loaded": True,
        "filename": state.metamodel_filename,
        "packageName": mm.package_name,
        "classes": classes,
        "mermaid": mm.mermaid,
    }


def _constraints_payload() -> dict:
    warnings = []
    if state.metamodel is not None:
        for c in state.constraints:
            if c.context_class not in state.metamodel.classes:
                warnings.append(
                    f"'{c.name}': la clase de contexto '{c.context_class}' no existe en el metamodelo."
                )
    return {
        "text": state.constraints_text,
        "error": state.constraints_error,
        "warnings": warnings,
        "constraints": [
            {"name": c.name, "contextClass": c.context_class, "source": c.source}
            for c in state.constraints
        ],
    }


@app.get("/api/status")
def get_status():
    return {
        "metamodel": _metamodel_payload(),
        "constraints": _constraints_payload(),
        "lastModelFilename": state.last_model_filename,
    }


@app.post("/api/metamodel")
async def upload_metamodel(file: UploadFile = File(...)):
    path = _save_upload(file, suffix=".ecore")
    try:
        mm = load_ecore(path)
    except EcoreLoadError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    state.metamodel = mm
    state.metamodel_filename = file.filename
    state.last_model = None
    state.last_model_filename = None
    return _metamodel_payload()


@app.get("/api/metamodel")
def get_metamodel():
    return _metamodel_payload()


class ConstraintsPayload(BaseModel):
    text: str


@app.post("/api/constraints")
def set_constraints(payload: ConstraintsPayload):
    if state.metamodel is None:
        raise HTTPException(status_code=400, detail="Sube primero un metamodelo .ecore.")
    try:
        parsed = parse_constraints(payload.text)
    except OclParseError as e:
        state.constraints_text = payload.text
        state.constraints = []
        state.constraints_error = str(e)
        raise HTTPException(status_code=400, detail=str(e)) from e
    state.constraints_text = payload.text
    state.constraints = parsed
    state.constraints_error = None
    return _constraints_payload()


@app.get("/api/constraints")
def get_constraints():
    return _constraints_payload()


@app.delete("/api/constraints")
def clear_constraints():
    state.constraints_text = ""
    state.constraints = []
    state.constraints_error = None
    return _constraints_payload()


@app.post("/api/models")
async def upload_model(file: UploadFile = File(...)):
    if state.metamodel is None:
        raise HTTPException(status_code=400, detail="Sube primero un metamodelo .ecore.")

    path = _save_upload(file, suffix=".xmi")
    try:
        loaded = load_xmi(path, state.metamodel)
    except XmiLoadError as e:
        state.last_model = None
        state.last_model_filename = file.filename
        return {
            "filename": file.filename,
            "conforms": False,
            "loadError": str(e),
            "structuralIssues": [],
            "constraintResults": [],
            "mermaid": "",
            "objectCount": 0,
            "pydanticCheck": None,
        }

    constraint_results = run_constraints(state.constraints, loaded, state.metamodel.class_registry)
    conforms = loaded.conforms_structurally and all(r.passed for r in constraint_results)

    state.last_model = loaded
    state.last_model_filename = file.filename

    try:
        pydantic_code, pydantic_warnings = generate_pydantic_module(state.metamodel, state.constraints)
        pydantic_check = cross_check_model(loaded.all_objects, loaded.roots, pydantic_code)
        pydantic_check["generationWarnings"] = pydantic_warnings
    except Exception as e:  # noqa: BLE001 - this is a best-effort second opinion, never fail the main result
        pydantic_check = {"ok": False, "errors": [f"No se pudo ejecutar la comprobación cruzada: {e}"], "generationWarnings": []}

    return {
        "filename": file.filename,
        "conforms": conforms,
        "loadError": None,
        "structuralIssues": [i.message for i in loaded.structural_issues],
        "constraintResults": [
            {
                "name": r.constraint_name,
                "contextClass": r.context_class,
                "object": r.object_label,
                "passed": r.passed,
                "error": r.error,
            }
            for r in constraint_results
        ],
        "mermaid": loaded.mermaid,
        "objectCount": len(loaded.all_objects),
        "pydanticCheck": pydantic_check,
    }


@app.get("/api/generate/pydantic")
def generate_pydantic():
    if state.metamodel is None:
        raise HTTPException(status_code=400, detail="Sube primero un metamodelo .ecore.")
    code, warnings = generate_pydantic_module(state.metamodel, state.constraints)
    return {"code": code, "warnings": warnings}


app.include_router(llm_router)
