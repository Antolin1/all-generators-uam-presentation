"""Generación de modelos con un LLM (LangChain + OpenAI) con bucle de retroalimentación.

El LLM escribe un script Python que instancia las clases Pydantic generadas a partir del
metamodelo y las restricciones OCL. El script se analiza estáticamente (`analysis`), se ejecuta
aislado en un subproceso que lo instrumenta (`runner`, lanzado por `sandbox`) y el resultado se
valida (estructura, restricciones, scope; `report`). Si algo falla, `feedback` explica qué y dónde
y `chain` se lo devuelve al LLM para que lo corrija.
"""
