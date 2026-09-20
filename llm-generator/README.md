# Generador de modelos con un LLM

Aplicación web que pide a un LLM de OpenAI (vía LangChain) un modelo que cumpla un metamodelo Ecore, sus
restricciones OCL y un *scope* que defines en pantalla. Valida el resultado y, si falla, se lo devuelve al LLM
explicando qué regla, qué objeto y qué línea. El modelo final se ve como grafo y se exporta a XMI.

```
llm-generator/
├── docker-compose.yml
├── .env.example
├── frontend/      Interfaz (Vite + TypeScript), servida por nginx
└── mm-ocl-py/     Backend (FastAPI): Pydantic, sandbox, bucle de feedback, LangChain
```

El backend está explicado por dentro en [`mm-ocl-py/README.md`](mm-ocl-py/README.md); aquí solo cómo ejecutarlo.

## Con Docker (recomendado)

Necesitas Docker con Compose y una clave de API de OpenAI.

```bash
cd llm-generator
cp .env.example .env          # y pon tu clave en OPENAI_API_KEY=
docker compose up --build
```

Abre <http://localhost:8110>. También puedes pasar la clave sin fichero: `OPENAI_API_KEY=sk-... docker compose up --build`.

| Servicio | Puerto | Qué es |
|---|---|---|
| `frontend` | <http://localhost:8110> | La interfaz. nginx reenvía `/api` al backend. |
| `backend` | <http://localhost:8111> | La API (para depurar; documentación en `/docs`). |

Ambos puertos solo se publican en `127.0.0.1`. Para parar: `Ctrl+C` (o `docker compose down` si lo lanzaste con `-d`).
Los logs: `docker compose logs -f`.

### Variables de entorno

| Variable | Obligatoria | Para qué |
|---|---|---|
| `OPENAI_API_KEY` | sí | La clave de OpenAI. Solo se lee de aquí; nunca se guarda ni se muestra. |
| `OPENAI_MODEL` | no | Modelo que aparece por defecto en la interfaz (si no, `gpt-4.1`). También se puede cambiar en pantalla. |
| `OPENAI_BASE_URL` | no | Un endpoint compatible con OpenAI. |
| `OPENAI_TEMPERATURE` | no | Solo se envía si la defines (los modelos de razonamiento no la admiten). |

Si cambias el `.env`, vuelve a levantar los contenedores (`docker compose up -d`).

## Sin Docker

Necesitas Python 3.11 o superior y Node 18 o superior. Dos terminales:

```bash
# 1. Backend  ->  http://127.0.0.1:8111
cd llm-generator/mm-ocl-py
python3 -m venv .venv-llm && source .venv-llm/bin/activate
pip install -r requirements.txt
export OPENAI_API_KEY=sk-...
uvicorn app.main:app --app-dir backend --port 8111 --reload
```

```bash
# 2. Frontend  ->  http://localhost:5173  (Vite reenvía /api al puerto 8111)
cd llm-generator/frontend
npm install
npm run dev
```

Usa un entorno de Python nuevo: el `.venv` que ya hubiera en `mm-ocl-py` no tiene LangChain.

## Primer uso, con el ejemplo de Yakindu

1. En **1 · Metamodelo**, elige *Yakindu · máquinas de estados* en el desplegable (o sube tu propio `.ecore`).
   Las restricciones OCL del ejemplo se cargan solas en **2 · Restricciones OCL**; si usas tu metamodelo, escríbelas
   ahí (se guardan al momento).
2. En **3 · Scope**, elige la clase raíz (`Statechart`) y los límites por clase, por ejemplo `Region` entre 1 y 1 y
   `State` entre 2 y 3. Los campos vacíos no tienen límite.
3. Pulsa **Generate** (o `Ctrl+Enter`). Va apareciendo cada intento; pulsa en uno para ver su grafo y, abajo, sus
   pestañas: **Problemas** (con enlaces a la línea del script y a la regla en el código Pydantic), **Prompt** (el prompt de
   sistema y el de usuario, y en los reintentos también las respuestas y el feedback anteriores; antes de generar
   enseña los del primer intento con el scope actual), **Feedback al LLM** (el mensaje que se le mandó),
   **Script del LLM**, **Código Pydantic** (lo único que ve el LLM), **Scope** y **XMI**.
   Los objetos que incumplen algo salen en rojo.
4. Cuando un intento es válido (✓), **Exportar XMI** descarga el modelo.

También hay un ejemplo de familia (`family`) en el desplegable.

## Probar la interfaz sin clave

Arranca el backend con un LLM simulado (responde un script con un import prohibido, otro que incumple reglas y el
scope, y uno correcto) y el frontend en modo desarrollo:

```bash
cd llm-generator/mm-ocl-py
pip install -r requirements-dev.txt
python backend/tests/run_with_fake_llm.py         # http://127.0.0.1:8111

cd ../frontend && npm install && npm run dev      # http://localhost:5173
```

Reinicia el simulador antes de cada prueba: cuenta las respuestas desde que arranca.

## Tests

```bash
cd llm-generator/mm-ocl-py
pip install -r requirements-dev.txt
pytest
```

## Si algo falla

- **«Falta la variable de entorno OPENAI_API_KEY»**: la clave no llegó al backend. En Docker, comprueba el `.env`
  (debe estar junto a `docker-compose.yml`) y recrea los contenedores; sin Docker, haz el `export` en la misma terminal
  donde lanzas `uvicorn`.
- **El botón Generate está desactivado**: falta cargar el metamodelo o falta la clave; el indicador de arriba lo dice.
- **Error 401 de OpenAI en el resultado**: la clave no es válida.
- **Otros errores de OpenAI** (límite de uso, modelo inexistente…): salen tal cual en el panel de resultado; prueba con otro
  modelo en el campo «Modelo de OpenAI».
- **Un puerto está ocupado**: cambia `"127.0.0.1:8110:80"` (interfaz) o `"127.0.0.1:8111:8000"` (API) en `docker-compose.yml`.

> El script que escribe el LLM se ejecuta en el servidor (aislado en un subproceso). Es una herramienta local: los
> puertos solo se publican en `127.0.0.1` y la API no acepta peticiones de otros orígenes; no la expongas a internet.
