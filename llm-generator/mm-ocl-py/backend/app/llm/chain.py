"""El bucle generar → validar → retroalimentar, con LangChain y un modelo de OpenAI.

`prompt | llm` es la cadena de LangChain: un prompt con el mensaje de sistema (las instrucciones y el módulo Pydantic
de esta petición) y el historial de la conversación (`MessagesPlaceholder`) alimenta a `ChatOpenAI`. El primer turno
de usuario del historial es solo el scope. El historial crece con cada intento fallido (la respuesta del LLM y el
feedback que generó `report`/`feedback`), de modo que el LLM ve qué hizo y qué falló.
"""
from __future__ import annotations

import os
import re
import time
from dataclasses import dataclass, field
from typing import Callable

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder

from . import feedback
from .analysis import Issue
from .report import Context, Evaluation, evaluate
from .spec import ALLOWED_STDLIB, MODULE_NAME

DEFAULT_MODEL = "gpt-4.1"
MODEL_SUGGESTIONS = ["gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini", "o4-mini", "gpt-5", "gpt-5-mini"]

SYSTEM_PROMPT = f"""Eres un generador de datos de prueba en Python. Recibirás el código de un módulo llamado `{MODULE_NAME}` con clases Pydantic \
(cada clase tiene sus reglas de validez en el método `check_constraints`) y una petición de tamaño (el "scope"). \
Tu trabajo es escribir UN script Python que construya un conjunto de objetos de esas clases, plausible y variado, que \
cumpla todas las reglas del módulo y el scope pedido.

Reglas del script:
1. Responde únicamente con un bloque ```python ... ``` que contenga el script completo. Nada de explicaciones fuera del bloque.
2. Solo puedes importar `{MODULE_NAME}` (por ejemplo `from {MODULE_NAME} import A, B`) y estos módulos de la biblioteca estándar: \
{", ".join(ALLOWED_STDLIB)}. Cualquier otro import falla.
3. Crea los objetos con `Clase.model_construct(campo=valor, ...)` (no valida nada) y enlaza las referencias asignando campos. \
Los campos marcados como «inversa» deben quedar coherentes por los dos lados: si `a.x` apunta a `b`, entonces `b.y` debe apuntar a `a` \
(o contenerlo si es una lista).
4. Los campos marcados como «hijos» forman un árbol: todo objeto, salvo el raíz, debe estar en el campo de hijos de exactamente \
un padre, y por esa cadena colgar del objeto raíz. Los campos «referencia a otros objetos ya existentes» solo apuntan a objetos \
que ya están en ese árbol.
5. Asigna todos los campos obligatorios (los que no tienen valor por defecto) con el tipo correcto (str, int, bool, float; una lista \
donde el campo es `List[...]`).
6. No instancies clases marcadas como abstractas: usa una subclase concreta.
7. Al final del script, asigna a la variable `model` el objeto raíz. No llames a `print` ni a `validate_all`: el script se valida por fuera.
8. Usa datos plausibles y distintos entre sí (nombres con sentido, no `x1`, `x2`).
9. Cumple exactamente el scope indicado. Puedes usar bucles y funciones auxiliares para no repetir código.

Si después recibes una lista de fallos, corrígelos TODOS y devuelve de nuevo el script completo."""

_CODE_BLOCK = re.compile(r"```(?:python|py)?[ \t]*\n(.*?)```", re.DOTALL | re.IGNORECASE)


class LlmConfigError(RuntimeError):
    """Falta algo para poder llamar al LLM (p. ej. la clave de API)."""


def api_key_configured() -> bool:
    return bool(os.environ.get("OPENAI_API_KEY"))


def default_model() -> str:
    return os.environ.get("OPENAI_MODEL") or DEFAULT_MODEL


def create_llm(model: str) -> BaseChatModel:
    """Un `ChatOpenAI` de LangChain. La clave sale de la variable de entorno `OPENAI_API_KEY`."""
    if not api_key_configured():
        raise LlmConfigError("Falta la variable de entorno OPENAI_API_KEY: defínela antes de arrancar el servidor.")
    from langchain_openai import ChatOpenAI

    options: dict = {"model": model, "max_retries": 2, "timeout": 180}
    if os.environ.get("OPENAI_TEMPERATURE"):  # los modelos de razonamiento no admiten `temperature`: solo si se pide
        options["temperature"] = float(os.environ["OPENAI_TEMPERATURE"])
    if os.environ.get("OPENAI_BASE_URL"):
        options["base_url"] = os.environ["OPENAI_BASE_URL"]
    return ChatOpenAI(**options)


def text_of(message: BaseMessage) -> str:
    content = message.content
    if isinstance(content, str):
        return content
    return "".join(part.get("text", "") if isinstance(part, dict) else str(part) for part in content)


def extract_code(text: str) -> str | None:
    """El script de la respuesta: el bloque ```python más largo (o, si no hay bloques, el texto entero si parece código)."""
    blocks = _CODE_BLOCK.findall(text)
    if blocks:
        return max(blocks, key=len).strip("\n")
    stripped = text.strip()
    return stripped if stripped.startswith(("import ", "from ", "#")) else None


def system_prompt(ctx: Context) -> str:
    """El mensaje de sistema: las instrucciones fijas más el módulo Pydantic de esta petición (no va en el turno del usuario)."""
    return f"{SYSTEM_PROMPT}\n\n## Código del módulo `{MODULE_NAME}`\n```python\n{ctx.module_code}\n```"


def task_message(ctx: Context) -> HumanMessage:
    return HumanMessage(content=f"## Petición\nGenera el modelo con este scope:\n{ctx.scope.describe()}\n\nEscribe el script.")


def prompt_texts(ctx: Context) -> dict:
    """Lo que se le manda al LLM antes de cualquier intento: el mensaje de sistema (instrucciones + módulo) y el de usuario (el scope)."""
    return {"system": system_prompt(ctx), "task": text_of(task_message(ctx))}


@dataclass
class Attempt:
    n: int
    code: str | None
    llm_text: str
    evaluation: Evaluation
    feedback: str | None
    seconds: float
    usage: dict = field(default_factory=dict)


@dataclass
class Outcome:
    ok: bool
    attempts: list[Attempt]
    cancelled: bool = False


KEEP_PAIRS = 3


def _trim(history: list[BaseMessage], keep_pairs: int = KEEP_PAIRS) -> list[BaseMessage]:
    """Tras muchos intentos se conserva la petición y los últimos: el historial no crece sin límite."""
    return history if len(history) <= 1 + 2 * keep_pairs else [history[0], *history[-2 * keep_pairs:]]


def run_loop(
    llm: BaseChatModel,
    ctx: Context,
    max_iterations: int,
    on_event: Callable[[str, dict], None] = lambda *_: None,
    should_stop: Callable[[], bool] = lambda: False,
    timeout: float = 20.0,
) -> Outcome:
    chain = ChatPromptTemplate.from_messages([SystemMessage(content=system_prompt(ctx)), MessagesPlaceholder("history")]) | llm
    history: list[BaseMessage] = [task_message(ctx)]
    attempts: list[Attempt] = []
    answered: list[int] = []  # intentos fallidos cuya respuesta y feedback están en el historial
    for n in range(1, max_iterations + 1):
        if should_stop():
            return Outcome(False, attempts, cancelled=True)
        started = time.time()
        on_event("llm_start", {"n": n, "context": answered[-KEEP_PAIRS:]})  # los intentos que el LLM ve en este mensaje
        message = chain.invoke({"history": _trim(history)})
        raw = text_of(message)
        usage = dict(getattr(message, "usage_metadata", None) or {})
        code = extract_code(raw)
        on_event("llm_done", {"n": n, "code": code, "raw": raw, "usage": usage})

        if code is None:
            evaluation = Evaluation(False, [Issue("contract", "Tu respuesta no contiene un bloque ```python con el script.")], "static")
        else:
            evaluation = evaluate(code, ctx, timeout)
        text = None if evaluation.ok or n == max_iterations else feedback.render(evaluation.issues, n, max_iterations)
        attempt = Attempt(n, code, raw, evaluation, text, time.time() - started, usage)
        attempts.append(attempt)
        on_event("attempt", {"attempt": attempt})
        if evaluation.ok:
            return Outcome(True, attempts)
        if text is not None:
            history += [AIMessage(content=raw), HumanMessage(content=text)]
            answered.append(n)
    return Outcome(False, attempts)
