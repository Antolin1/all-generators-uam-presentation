# mm-ocl-py

Backend (FastAPI) para trabajar con un metamodelo **Ecore** y sus **restricciones OCL**: validar
modelos **XMI** (conformidad estructural y OCL), traducir el par metamodelo+OCL a un módulo **Pydantic**
autocontenido y **generar modelos con un LLM** (LangChain + OpenAI) que usa ese módulo como único contexto y se
corrige con un bucle de retroalimentación ([ver más abajo](#generador-de-modelos-con-un-llm)).

Es solo API (`/api/...`, documentación interactiva en `/docs`). La interfaz web está en
[`../frontend/`](../frontend/) y `../docker-compose.yml` levanta las dos partes; el README de la carpeta superior
explica cómo ejecutarlo.

## Alcance y limitaciones

- **Los EAttributes no se soportan como parte del "producto" del validador
  web**: no se muestran en el diagrama de clases y no hace falta definir
  restricciones sobre ellos. El foco está en clases, herencia y referencias
  (con contención y multiplicidad). Dicho esto, si tu `.ecore` trae
  atributos (p. ej. `name`), el metamodelo se registra completo en pyecore
  para poder cargar los `.xmi` reales sin errores, las expresiones OCL sí
  pueden navegar hasta esos atributos si los necesitas (`self.nombre`,
  etc.), y el generador de Pydantic (ver más abajo) sí les genera un campo
  real con su tipo — porque ahí sí hacen falta para producir código que
  ejecute sin `AttributeError`.
- **OCL implementado es un subconjunto pragmático**, no el estándar OMG
  completo. No hay librería Python madura de OCL reutilizable (se investigó
  `pyecoreocl`, que es un transpilador experimental de expresiones sin
  soporte de `context ... inv ...:`, sin publicar en PyPI y con limitaciones
  documentadas por su propio autor), así que se implementó un intérprete
  propio con [Lark](https://github.com/lark-parser/lark). Ver la sección
  [Subconjunto OCL soportado](#subconjunto-ocl-soportado).
- **Estado en memoria, sesión única**: pensada para que la use una persona a
  la vez desde su máquina (subir metamodelo, escribir OCL, validar modelos).
  No hay usuarios, autenticación ni persistencia en disco entre reinicios del
  servidor.
- La comprobación estructural de multiplicidad tiene una limitación conocida:
  si un `.xmi` mal formado asigna dos valores a una referencia de
  multiplicidad `0..1`/`1..1`, pyecore se queda solo con el último y esa
  sobre-asignación deja de ser detectable a posteriori. Los casos de
  cardinalidad mínima (referencias obligatorias ausentes) y de colecciones
  `0..*`/`1..*` que superan su cota sí se detectan siempre.

## Estructura del repositorio

```
mm-ocl-py/     (la interfaz está en ../frontend)
├── backend/
│   └── app/
│       ├── main.py            # FastAPI: endpoints del metamodelo, OCL, validación y Pydantic
│       ├── state.py           # estado en memoria (single-session)
│       ├── ecore_service.py   # carga de .ecore (pyecore) + diagrama de clases
│       ├── xmi_service.py     # carga de .xmi + chequeo estructural + diagrama de objetos
│       ├── validation.py      # ejecuta las restricciones OCL sobre un modelo cargado
│       ├── ocl/
│       │   ├── grammar.lark   # gramática del subconjunto OCL
│       │   ├── parser.py      # parseo de texto OCL -> árboles por restricción
│       │   ├── evaluator.py   # intérprete del árbol OCL contra objetos pyecore
│       │   └── errors.py
│       ├── codegen/
│       │   ├── naming.py         # camelCase -> snake_case para nombres de campo
│       │   ├── ocl_compiler.py   # compila el mismo árbol OCL a código Python (no lo evalúa)
│       │   ├── generator.py      # ensambla el módulo Pydantic (clases + reglas); variante neutra para el LLM
│       │   └── xmi_bridge.py     # ejecuta el módulo generado y le pasa el .xmi ya cargado
│       └── llm/                  # generación con LLM (ver más abajo)
│           ├── chain.py          # LangChain: prompt | ChatOpenAI y el bucle generar -> validar -> feedback
│           ├── analysis.py       # análisis estático (ast) del script: sintaxis, imports, construcciones prohibidas
│           ├── sandbox.py        # lanza el runner en un subproceso aislado
│           ├── runner.py         # ejecuta el script instrumentado y devuelve un informe (metaprogramación)
│           ├── report.py         # del informe a incidencias: estructura, reglas, scope
│           ├── feedback.py       # redacta el feedback para el LLM (solo habla de código Pydantic)
│           ├── export.py         # modelo -> pyecore -> XMI, y grafo para la interfaz
│           ├── spec.py           # scope, y datos del metamodelo para el sandbox
│           ├── jobs.py           # trabajos en segundo plano
│           └── api.py            # endpoints /api/llm/* y /api/examples
├── backend/tests/             # pytest (ver «Tests»)
├── Dockerfile
├── examples/
│   ├── family.ecore              # metamodelo de ejemplo (Persona/Mascota)
│   ├── family_valid.xmi          # modelo que conforma
│   ├── family_invalid.xmi        # modelo que viola una restricción OCL
│   ├── family_constraints.ocl    # restricciones de ejemplo
│   ├── yakindu_simplified.ecore  # metamodelo simplificado de statecharts Yakindu
│   ├── yakindu_valid.xmi         # statechart que conforma
│   ├── yakindu_invalid.xmi       # statechart con 4 violaciones a propósito
│   └── yakindu_constraints.ocl   # traducción a OCL de las restricciones VQL del DSL Reasoner
├── requirements.txt
└── README.md
```

## Instalación

Requiere Python 3.11+.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Ejecución

```bash
source .venv/bin/activate
uvicorn app.main:app --app-dir backend --reload
```

La API queda en <http://127.0.0.1:8000> (documentación en <http://127.0.0.1:8000/docs>). Para generar con el LLM,
define antes `OPENAI_API_KEY` (`export OPENAI_API_KEY=sk-...`). No se envían cabeceras CORS: la interfaz la sirve
nginx (Docker) o el servidor de desarrollo de Vite (ambos hacen de proxy de `/api`), así que ninguna otra web puede
llamar a la API desde el navegador y gastar tu clave.

## Uso de la API

Ejemplo con `curl` del flujo de validación (con la interfaz esto lo hace la aplicación por ti):

```bash
curl -F file=@examples/family.ecore localhost:8000/api/metamodel            # 1. metamodelo
curl -X POST localhost:8000/api/constraints -H 'content-type: application/json' \
     -d '{"text": "context Persona inv SinHijoPropio:\n  self.hijos->forAll(h | h <> self)"}'   # 2. OCL
curl -F file=@examples/family_valid.xmi localhost:8000/api/models           # 3. validar un .xmi
curl localhost:8000/api/generate/pydantic                                    # 4. módulo Pydantic
```

- **Metamodelo** (`POST/GET /api/metamodel`): se carga el `.ecore`.
- **Restricciones** (`POST/GET/DELETE /api/constraints`), una o varias, con la sintaxis:
  ```
  context Persona inv SinHijoPropio:
    self.hijos->forAll(h | h <> self)
  ```
  El nombre de la invariante (`SinHijoPropio`) es opcional. Un error de sintaxis se devuelve con línea/columna; si la
  clase de contexto no existe en el metamodelo se avisa como advertencia (no bloquea el guardado).
- **Validar un `.xmi`** (`POST /api/models`, por ejemplo `examples/family_valid.xmi` o `family_invalid.xmi`): indica si
  el modelo conforma o no, listando errores de carga (tipos/`features` inexistentes), problemas de multiplicidad, el
  resultado de cada restricción OCL para cada instancia de su clase de contexto y una
  [comprobación cruzada](#comprobación-cruzada-el-mismo-xmi-validado-con-las-clases-generadas) contra las clases Pydantic.
- **Módulo Pydantic** (`GET /api/generate/pydantic`): ver [Generador de clases Pydantic](#generador-de-clases-pydantic).

### Ejemplo Yakindu (traducción de restricciones VQL a OCL)

`examples/yakindu_simplified.ecore` es una versión simplificada del
metamodelo de statecharts de Yakindu (`Region`, `Vertex`, `Transition`,
`Entry`, `Exit`, `Choice`, `State`, `FinalState`, etc.). Sus reglas de buena
formación se definían originalmente como patrones VIATRA Query Language
(VQL) con `@Constraint(severity="error", ...)`, donde un *match* del patrón
señala un error. `examples/yakindu_constraints.ocl` traduce cada uno de esos
patrones a la invariante OCL equivalente (la condición que debe cumplirse
para que **no** haya match), por ejemplo:

| Patrón VQL (error si hay match)     | Invariante OCL equivalente |
|--------------------------------------|-----------------------------|
| `noEntryInRegion` / `multipleEntryInRegion` | `Region inv HasEntry` + `AtMostOneEntry`: la región tiene exactamente una `Entry` |
| `incomingToEntry`                    | `Entry inv NoIncomingTransitions` |
| `noOutgoingTransitionFromEntry` / `multipleTransitionFromEntry` | `Entry inv HasOutgoingTransition` + `AtMostOneOutgoingTransition` |
| `outgoingFromExit`                   | `Exit inv NoOutgoingTransitions` |
| `outgoingFromFinal`                  | `FinalState inv NoOutgoingTransitions` |
| `noStateInRegion`                    | `Region inv HasState` |
| `choiceHasNoOutgoing` / `choiceHasNoIncoming` | `Choice inv HasOutgoingTransition` + `HasIncomingTransition` |

`yakindu_valid.xmi` cumple las 10 invariantes; `yakindu_invalid.xmi` viola a
propósito 4 de ellas (dos `Entry` en la misma región, una `Entry` con
transición entrante, un `Exit` con transición saliente, y una región sin
ningún `State`) para poder comprobar el reporte de errores.

## Generador de clases Pydantic

`GET /api/generate/pydantic` (sobre el metamodelo y las restricciones cargados en ese momento) produce
un fichero `.py` autocontenido con:

- una clase `pydantic.BaseModel` por cada `EClass` (la herencia múltiple de
  Ecore se traduce directamente a herencia múltiple de Python: por ejemplo
  `State(RegularState, CompositeElement)` en el ejemplo Yakindu);
- un campo por cada `EReference` (`List['Target']`, `Optional['Target']` o
  `'Target'` obligatorio, según su multiplicidad) y por cada `EAttribute`
  (mapeando `EString`→`str`, `EInt`→`int`, `EBoolean`→`bool`,
  `EDouble`/`EFloat`→`float`; cualquier otro tipo cae a `Any`);
- un método `check_constraints()` por clase (que devuelve **todas** las violaciones del objeto como
  tuplas `(tipo, nombre, mensaje)` y amplía las de sus superclases, de modo que una regla declarada en
  una superclase también se aplica a sus subclases) y, definido una sola vez en `OclEntity`, el
  `@model_validator(mode="after")` que lanza `ValueError` con la primera. Las comprobaciones son, en este orden:
  comprobación de multiplicidad mínima en referencias `0..*`/`1..*` (extra,
  por coherencia con el validador web, no pedido explícitamente y fácil de
  borrar si no se quiere), consistencia bidireccional para cada referencia
  con `eOpposite` (el patrón `if t.source and t not in t.source.outgoing_transitions: raise ValueError(...)`
  que sirvió de ejemplo para pedir esta función), y cada restricción OCL
  cuyo contexto sea esa clase, compilada a una expresión booleana Python. Además `OclEntity` comprueba
  que los campos obligatorios estén asignados y que los atributos tengan el tipo correcto (los objetos
  construidos con `model_construct` no pasan por la validación de Pydantic).

Una clase común `OclEntity` (definida al principio del fichero generado)
hace de base de todas las clases sin superclase en el metamodelo: sobreescribe
`__eq__`/`__hash__` para que sean por identidad de Python en vez de por
valor (el comportamiento por defecto de Pydantic), que es la semántica real
de `=`/`<>` de OCL sobre objetos y la que necesitan `asSet`, `isUnique` o
`union` para funcionar con instancias de estas clases.

**Cómo usar el fichero generado — importante:** estos metamodelos suelen
ser grafos, no árboles (referencias cruzadas vía `eOpposite`, como
`Transition.source`/`Vertex.outgoingTransitions`), y un objeto no puede
cumplir sus invariantes de referencia antes de que el resto del grafo
exista. Por eso Pydantic no puede validar cada objeto en el momento de
construirlo. El propio fichero generado incluye una función `validate_all(root)`
para esto — constrúyelo todo con `Clase.model_construct(...)` (que no
valida nada), enlaza las referencias por mutación, y llama a
`validate_all(raiz)` una sola vez al final; lanzará `ValueError` en la
primera restricción violada. (La alternativa obvia, forzar
`revalidate_instances="always"` para que `model_validate()` revalide en
cascada, se probó y se descartó: falla con "cyclic reference detected" en
cuanto el grafo tiene un ciclo real, que es el caso normal aquí.)

**Restricciones que no se pueden traducir:** `Clase.allInstances()` no tiene
equivalente razonable en un validador que solo ve un objeto y lo alcanzable
por containment/referencias desde él — no hay forma de acceder a "todas las
instancias del modelo" sin ese contexto global. Cuando una restricción usa
`allInstances()` (o cualquier otra construcción no traducible), el generador
no aborta: deja esa restricción como comentario `# TODO` en el código
generado con el motivo, y lo reporta también en la lista `warnings` de la
respuesta de la API.

### Comprobación cruzada: el mismo .xmi validado con las clases generadas

Cada vez que subes un `.xmi` a `/api/models`, además del resultado del
intérprete OCL propio, la app genera las clases Pydantic al vuelo
(`codegen/generator.py`), las ejecuta en memoria (`exec` sobre el código
generado, nunca se escribe a disco), convierte los objetos pyecore ya
cargados del modelo en instancias `Clase.model_construct(...)` de esas
clases (`codegen/xmi_bridge.py`: dos pasadas, una para crear todas las
instancias vacías y otra para enlazar atributos y referencias, necesario
porque el grafo puede tener ciclos) y llama a `validate_all(...)` sobre
cada raíz del modelo. El resultado se muestra como "Comprobación cruzada"
junto al veredicto principal — dos implementaciones independientes (un
intérprete que evalúa el árbol OCL directamente, y un compilador que lo
traduce a Python) respondiendo la misma pregunta de conformidad sobre el
mismo modelo. Dos matices:

- Si la comprobación cruzada dice que el modelo NO conforma, solo enseña la
  **primera** violación que encuentra (para en el primer `ValueError`),
  mientras que la tabla de arriba enseña el resultado de **todas** las
  restricciones sobre **todas** las instancias.
- Si alguna restricción no se pudo traducir a Python (ver el punto
  anterior sobre `allInstances()`), la comprobación cruzada **no la cubre**
  — puede decir "conforma" sin haber comprobado esa restricción. Por eso
  esos casos se listan explícitamente como advertencia junto al resultado.

## Generador de modelos con un LLM

Pide un modelo a un LLM de OpenAI, lo valida y, si falla, le explica qué y dónde para que lo corrija.

```
metamodelo + OCL ──► módulo Pydantic (variante neutra)
                            │
scope del usuario ──────────┤   prompt = solo código Pydantic + scope
                            ▼
              ┌──► LLM (LangChain: prompt | ChatOpenAI) ──► script Python
              │                                                    │
        feedback                                     análisis estático (ast)
     (qué falló y dónde)                                           │
              │                                     sandbox: ejecución instrumentada
              │                                                    │
              └──────── incidencias ◄── estructura · reglas · scope ┘
                                              │ (válido)
                                              ▼
                                  grafo en pantalla + exportar XMI
```

**Qué recibe el LLM: solo código Pydantic.** El módulo `models` con las clases (campos, tipos, qué campos son «hijos»
y cuáles son referencias, referencias inversas, y las reglas de validez escritas en Python dentro de
`check_constraints`) va en el **mensaje de sistema**, junto con las instrucciones; el **mensaje de usuario** (el primer
turno del historial) lleva solo el scope en lenguaje natural — así queda claro que el módulo es contexto fijo de la
tarea y no parte de la petición de cada intento. El LLM no sabe nada de OCL, de Ecore ni del metamodelo: la variante
`neutral=True` de `generate_pydantic_module` genera el mismo código sin ninguna mención (la base se llama `Entity`, no
`OclEntity`; los mensajes son `Clase.Regla`, no la expresión OCL) y el sandbox ejecuta exactamente ese texto, así que los
números de línea que se le citan son los que ve. La interfaz lo muestra tal cual en la pestaña «Código Pydantic», y
también en la pestaña «Prompt» (dentro del mensaje de sistema).

**Qué escribe: un script.** Instancia las clases con `Clase.model_construct(...)`, enlaza las referencias y asigna la
raíz a `model`. Solo puede importar `models` y unos pocos módulos estándar (`typing, random, math, itertools,
collections, string, functools`).

**Scope** (se pide en pantalla): clase raíz, mínimo/máximo de instancias por clase (contando las de sus subclases),
y total de objetos. Se comprueba sobre el modelo resultante. Al LLM solo se le pasa esto: no hay texto libre.

### El bucle de retroalimentación

Tras cada intento se evalúa el script por etapas ([`report.py`](backend/app/llm/report.py)) y **todo lo que falla se
devuelve junto, agrupado por tipo**, para que el LLM lo corrija de una vez:

| Tipo | Cómo se detecta | Qué se le dice |
|---|---|---|
| **Código** – sintaxis, imports, prohibido | `ast` antes de ejecutar ([`analysis.py`](backend/app/llm/analysis.py)) | error, línea y línea de código; imports permitidos; clases que sí existen en `models` |
| **Código** – ejecución, tiempo, contrato | excepción en el sandbox ([`runner.py`](backend/app/llm/runner.py)); falta `model`; `model` de otra clase | excepción con su línea del script, código de esa línea y pila |
| **Estructura** | recorrido de los objetos | objetos huérfanos (creados y no enlazados), objetos que no cuelgan de `model`, con dos padres, de clase abstracta, del tipo equivocado, listas mal formadas |
| **Reglas de validez** | `check_constraints()` de cada objeto | *qué regla* (`Exit.NoOutgoingTransitions`), *qué objeto* (`exit_1`, y la línea del script donde se creó) y *dónde está la regla* (línea del módulo y condición Python) |
| **Scope** | recuento por clase | «hay 5 `State` y se piden entre 2 y 3» |

Mientras haya fallos de código no se evalúa lo demás (el script no llegó a producir un modelo), y así se le dice.

**Dónde entra la metaprogramación** ([`runner.py`](backend/app/llm/runner.py)): el módulo generado se carga dinámicamente
con `exec` y se instrumenta con un gancho (`_on_create`, llamado desde `model_post_init`) que anota **en qué línea del
script se creó cada objeto**; se ejecuta el script con `builtins` e imports restringidos; se inspecciona su espacio de
nombres para **nombrar los objetos por su variable** (`exit_1`, `states[2]`) o, si no tienen, por su **ruta** desde `model`
(`model.regions[0].vertices[3]`); y se llama a `check_constraints()` en cada objeto alcanzable para saber qué regla
incumple cada uno (los validadores de Pydantic solo darían la primera). Las reglas que no se pueden traducir a Python
(`allInstances()`) se comprueban con el intérprete OCL sobre el modelo exportado.

**LangChain** ([`chain.py`](backend/app/llm/chain.py)): la cadena es `ChatPromptTemplate(SystemMessage + MessagesPlaceholder("history")) | ChatOpenAI`.
El `SystemMessage` (`system_prompt(ctx)`) lleva las instrucciones y el módulo Pydantic; el historial empieza con la
petición (solo el scope, `task_message(ctx)`) y por cada intento fallido añade la respuesta del LLM (`AIMessage`) y el
feedback (`HumanMessage`); tras más de tres intentos se conservan la petición y los tres últimos. El LLM es siempre de OpenAI.

### Configuración y uso

* La clave se lee **solo** de la variable de entorno `OPENAI_API_KEY` (nunca se guarda, se registra ni se manda al
  navegador). Opcionales: `OPENAI_MODEL` (por defecto de la interfaz; si no, `gpt-4.1`), `OPENAI_BASE_URL`
  (endpoint compatible con OpenAI) y `OPENAI_TEMPERATURE` (los modelos de razonamiento no la admiten: solo se envía si la defines).
  El modelo también se puede escribir en la interfaz.
* Pasos en la interfaz: carga el metamodelo (un ejemplo o *Subir .ecore*), escribe las restricciones OCL, define el
  scope y pulsa *Generate*. El trabajo corre en segundo plano y la pantalla enseña cada intento: su grafo, sus problemas,
  el prompt (sistema y usuario) y el feedback que se mandó, el script, el código Pydantic y el scope. Los objetos que incumplen algo salen **en rojo**
  con el número de problemas. **Exportar XMI** descarga el modelo de cualquier intento que se haya podido ejecutar.
* Endpoints: `GET /api/examples`, `GET /api/llm/setup`, `POST /api/llm/prompt` (los mensajes de sistema y de usuario
  del primer intento con un scope, sin llamar al LLM), `POST /api/llm/generate`, `GET /api/llm/jobs/{id}`,
  `POST /api/llm/jobs/{id}/cancel`, `GET /api/llm/jobs/{id}/attempts/{n}/xmi`.
* Con Docker: desde la carpeta superior, `OPENAI_API_KEY=sk-... docker compose up --build` y <http://localhost:8110>
  (o pon la clave en un `.env`, ver `.env.example`).

### Seguridad

El script del LLM es código arbitrario que se ejecuta en el servidor. Capas: análisis estático (imports en lista blanca,
sin `eval/exec/open`, sin acceso a atributos especiales); `builtins` restringidos; un **subproceso** por script con
`python -I`, **entorno vacío** (el script no ve `OPENAI_API_KEY`), memoria y CPU limitadas y un tiempo máximo (20 s) tras el
que se mata; y en Docker, usuario sin privilegios. No es un sandbox de nivel de seguridad (el contenedor sigue teniendo red):
es una herramienta local, por eso el puerto solo se publica en `127.0.0.1` y la API no admite peticiones de otros orígenes.

### Límites

* Probado una vez con OpenAI real (`gpt-4.1`, ejemplo de Yakindu, `Region` 1..1 y `State` 2..3): el primer intento falló,
  el segundo fue válido (9 objetos, unos 7 800 tokens). Fuera de eso, el bucle está probado con un LLM simulado (un
  `Runnable` de LangChain); una clave falsa devuelve el error 401 de OpenAI, que la aplicación muestra como error del trabajo.
* La calidad del modelo depende del LLM: los metamodelos con muchas reglas cruzadas pueden necesitar varios intentos.
* Los atributos se generan si el metamodelo los tiene (con el tipo comprobado); las restricciones que necesiten
  `allInstances()` solo se pueden verificar tras el intento (con el intérprete), no desde el código Pydantic que ve el LLM.
* Un máximo de 3000 objetos por modelo, 60 000 caracteres por script y 10 intentos.

### Tests

```bash
pip install -r requirements-dev.txt
pytest
```

Cubren el generador (variante neutra sin jerga, todas las violaciones, herencia de reglas), el análisis estático, el
sandbox (excepciones con línea, tiempo, entorno vacío, objetos huérfanos/doblemente contenidos/abstractos, reglas por
objeto), el bucle de LangChain con un LLM simulado (incluido que **nada de lo que recibe el LLM menciona OCL, Ecore o el
metamodelo**) y la API. `python backend/tests/run_with_fake_llm.py` arranca el backend con un LLM simulado (puerto 8111) para probar
la interfaz sin clave (ver el README de la carpeta superior).

## Subconjunto OCL soportado

- Navegación: `self`, `.propiedad`, `->operacion(...)`, encadenada.
- Colecciones (a partir de referencias `0..*`/`1..*`, o literales
  `Set{...}` / `Sequence{...}` / `Bag{...}` / rangos `1..5`):
  `size`, `isEmpty`, `notEmpty`, `includes`, `excludes`, `includesAll`,
  `excludesAll`, `count`, `sum`, `max`, `min`, `first`, `last`, `at`,
  `asSet`, `asBag`, `asSequence`, `asOrderedSet`, `flatten`, `union`,
  `intersection`, `including`, `excluding`.
- Operaciones con lambda: `forAll(x | ...)`, `exists(x | ...)`, `one(x | ...)`,
  `isUnique(x | ...)`, `select(x | ...)`, `reject(x | ...)`, `collect(x | ...)`,
  `sortedBy(x | ...)`, `any(x | ...)`. `forAll`/`exists` admiten varias
  variables (`forAll(a, b | ...)`), evaluando sobre el producto cartesiano —
  típico para restricciones de unicidad por pares.
- Lógica: `and`, `or`, `xor`, `not`, `implies`.
- Comparación: `=`, `<>`, `<`, `>`, `<=`, `>=`.
- Aritmética: `+`, `-`, `*`, `/`, `div`, `mod`.
- Control: `if ... then ... else ... endif`, `let x = ... in ...`.
- Tipos: `oclIsKindOf(Clase)`, `oclIsTypeOf(Clase)`, `oclAsType(Clase)`,
  `Clase.allInstances()`, `oclIsUndefined()`.
- Cadenas y números: `toUpperCase`, `toLowerCase`, `concat`, `substring`,
  `toInteger`, `toReal`, `toString`, `abs`, `round`, `floor`, etc.
- Comentarios de línea con `--`.

No implementado (fuera de alcance de este subconjunto): `iterate`, tipos
`Tuple`, mensajes OCL (`^`), `@pre` sobre operaciones, y la distinción real
entre `Set`/`Bag`/`Sequence`/`OrderedSet` (todas se representan como listas
Python; `asSet` sí deduplica).

## Tests manuales realizados

El motor OCL y la carga Ecore/XMI se probaron con scripts ad-hoc contra
pyecore (navegación, `forAll` con múltiples variables, `allInstances`,
`oclIsKindOf`, `let`/`if`, colecciones, aritmética) y el flujo completo
end-to-end se validó vía `curl` contra los ejemplos en `examples/`
(metamodelo → restricciones → modelo válido conforma → modelo inválido no
conforma, con mensajes de error legibles tanto para OCL mal escrito como
para XMI con *features* desconocidas). La parte del generador con LLM sí tiene tests
automatizados (`pytest`, ver más arriba); el motor OCL y la carga Ecore/XMI siguen probados solo a mano.
