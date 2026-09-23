"""Lanza runner.py en un subproceso aislado y recoge su informe."""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

from .spec import ALLOWED_STDLIB, ENTITY_NAME, MODULE_NAME

RUNNER = Path(__file__).with_name("runner.py")
RESULT_MARK = "\x00RESULT\x00"


@dataclass
class SandboxResult:
    phase: str  # done | exec | internal | timeout | crash
    error: dict | None = None
    report: dict | None = None
    stdout: str = ""


def run_script(module_code: str, llm_code: str, spec: dict, root_class: str, timeout: float = 20.0) -> SandboxResult:
    """Ejecuta `llm_code` con el módulo Pydantic `module_code` cargado como `models`.

    Subproceso con `-I` (sin PYTHONPATH ni site de usuario) y entorno vacío: el script no ve `OPENAI_API_KEY`.
    """
    payload = json.dumps({
        "moduleCode": module_code, "llmCode": llm_code, "spec": spec, "rootClass": root_class,
        "allowedModules": [MODULE_NAME, *ALLOWED_STDLIB], "moduleName": MODULE_NAME, "entityName": ENTITY_NAME,
    })
    with tempfile.TemporaryDirectory() as cwd:
        try:
            done = subprocess.run(
                [sys.executable, "-I", str(RUNNER)], input=payload, capture_output=True, text=True,
                timeout=timeout, cwd=cwd, env={"PYTHONHASHSEED": "0"})
        except subprocess.TimeoutExpired:
            return SandboxResult("timeout", error={
                "category": "timeout", "frames": [], "details": [],
                "message": f"El script tardó más de {timeout:.0f} s en ejecutarse (¿bucle infinito o demasiado trabajo?)."})
    if RESULT_MARK not in done.stdout:
        tail = (done.stderr or done.stdout or "").strip()[-800:]
        return SandboxResult("crash", error={
            "category": "runtime", "frames": [], "details": [],
            "message": f"El script terminó de forma anómala (código {done.returncode}). {tail}"})
    result = json.loads(done.stdout.split(RESULT_MARK, 1)[1])
    return SandboxResult(result["phase"], error=result.get("error"), report=result.get("report"), stdout=result.get("stdout", ""))
