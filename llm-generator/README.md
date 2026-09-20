# Generador de modelos con un LLM

Aplicación web que pide a un LLM de OpenAI (vía LangChain) un modelo que cumpla un metamodelo Ecore, sus
restricciones OCL y un *scope* que defines en pantalla. Valida el resultado y, si falla, se lo devuelve al LLM
explicando qué regla, qué objeto y qué línea. El modelo final se ve como grafo y se exporta a XMI.

El código está en [`mm-ocl-py/`](mm-ocl-py/) (su [README](mm-ocl-py/README.md) explica cómo funciona por dentro);
aquí solo cómo ejecutarlo.

## Con Docker (recomendado)

Necesitas Docker con Compose y una clave de API de OpenAI.

```bash
cd llm-generator
cp .env.example .env          # y pon tu clave en OPENAI_API_KEY=
docker compose up --build
```

Abre <http://localhost:8110>.

También puedes pasar la clave sin fichero: `OPENAI_API_KEY=sk-... docker compose up --build`.

Para parar: `Ctrl+C` (o `docker compose down` si lo lanzaste con `-d`). Los logs: `docker compose logs -f`.

### Variables de entorno

| Variable | Obligatoria | Para qué |
|---|---|---|
| `OPENAI_API_KEY` | sí | La clave de OpenAI. Solo se lee de aquí; nunca se guarda ni se muestra. |
| `OPENAI_MODEL` | no | Modelo que aparece por defecto en la interfaz (si no, `gpt-4.1`). También se puede cambiar en pantalla. |
| `OPENAI_BASE_URL` | no | Un endpoint compatible con OpenAI. |
| `OPENAI_TEMPERATURE` | no | Solo se envía si la defines (los modelos de razonamiento no la admiten). |

Si cambias el `.env`, vuelve a levantar el contenedor (`docker compose up -d`).

## Sin Docker

Requiere Python 3.11 o superior.

```bash
cd llm-generator/mm-ocl-py
python3 -m venv .venv-llm && source .venv-llm/bin/activate
pip install -r requirements.txt
export OPENAI_API_KEY=sk-...
uvicorn app.main:app --app-dir backend --reload
```

Abre <http://127.0.0.1:8000>. (Usa un entorno nuevo: el `.venv` que ya había no tiene LangChain.)

## Primer uso, con el ejemplo de Yakindu

1. En la pestaña **Metamodelo, OCL y validación**, sube `mm-ocl-py/examples/yakindu_simplified.ecore`.
2. Pega en el editor de restricciones el contenido de `mm-ocl-py/examples/yakindu_constraints.ocl` y pulsa
   *Guardar restricciones*.
3. Abre la pestaña **Generar un modelo con un LLM**. Define el scope, por ejemplo:
   clase raíz `Statechart`, `Region` entre 1 y 1, `State` entre 2 y 3. Opcionalmente, unas indicaciones
   («un flujo de trabajo simple»).
4. Pulsa **Generar**. Va apareciendo cada intento; pulsa en uno para ver su grafo, sus problemas, el feedback
   que se le mandó al LLM, su script y el scope. Los objetos que incumplen algo salen en rojo.
5. Cuando un intento es válido (✓), **Exportar XMI** descarga el modelo. Puedes volver a subirlo en la primera
   pestaña para validarlo.

También hay ejemplos de familia (`family.ecore` y `family_constraints.ocl`) en la misma carpeta.

## Probar la interfaz sin clave

Arranca la aplicación con un LLM simulado (responde un script con un import prohibido, otro que incumple
reglas y el scope, y uno correcto) y sigue los pasos de arriba con el ejemplo de Yakindu:

```bash
cd llm-generator/mm-ocl-py
pip install -r requirements-dev.txt
python backend/tests/run_with_fake_llm.py         # http://127.0.0.1:8110
```

## Tests

```bash
cd llm-generator/mm-ocl-py
pip install -r requirements-dev.txt
pytest
```

## Si algo falla

- **«Falta la variable de entorno OPENAI_API_KEY»**: la clave no llegó al servidor. En Docker, comprueba el `.env`
  (debe estar junto a `docker-compose.yml`) y recrea el contenedor; sin Docker, haz el `export` en la misma terminal
  donde lanzas `uvicorn`.
- **El botón Generar está desactivado**: falta subir el metamodelo o falta la clave; el aviso de arriba lo dice.
- **Error 401 de OpenAI en el resultado**: la clave no es válida.
- **Otros errores de OpenAI** (límite de uso, modelo inexistente…): salen tal cual en el panel de resultado; prueba con otro
  modelo en el campo «Modelo de OpenAI».
- **El puerto 8110 está ocupado**: cambia `"127.0.0.1:8110:8000"` en `docker-compose.yml`.

> El script que escribe el LLM se ejecuta en el servidor (aislado en un subproceso). Es una herramienta local: el
> puerto solo se publica en `127.0.0.1`; no la expongas a internet.
