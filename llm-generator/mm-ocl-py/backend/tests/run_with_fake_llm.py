"""Arranca la aplicación con un LLM simulado (sin OpenAI): sirve para probar la interfaz de extremo a extremo.

    python backend/tests/run_with_fake_llm.py [puerto]

Responde, en orden, con: un script con un import prohibido, uno que incumple reglas y el scope, y uno correcto.
"""
import sys
from pathlib import Path

import uvicorn
from langchain_core.messages import AIMessage
from langchain_core.runnables import RunnableLambda

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.llm import chain  # noqa: E402
from conftest import GOOD_YAKINDU  # noqa: E402

BAD_IMPORT = "import networkx\nmodel = None\n"
BAD_SEMANTIC = GOOD_YAKINDU.replace("link(start, idle)\n", "link(idle, start)\n") + '''
orphan = State.model_construct()
region.vertices.extend([State.model_construct(), State.model_construct()])
'''
replies = {"n": 0}


def fake_llm(model):
    def answer(_prompt):
        script = [BAD_IMPORT, BAD_SEMANTIC, GOOD_YAKINDU][min(replies["n"], 2)]
        replies["n"] += 1
        return AIMessage(content=f"Aquí tienes:\n```python\n{script}\n```", usage_metadata={"input_tokens": 1200, "output_tokens": 300, "total_tokens": 1500})
    return RunnableLambda(answer)


chain.create_llm = fake_llm
from app.main import app  # noqa: E402

uvicorn.run(app, host="127.0.0.1", port=int(sys.argv[1]) if len(sys.argv) > 1 else 8111, log_level="warning")
