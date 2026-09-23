# EMF Instantiator Playground

Interfaz web para el [EMF random instantiator](mondo-atlzoo-benchmark/fr.inria.atlanmod.instantiator/README.md) de AtlanMod
(`atlanmod/mondo-atlzoo-benchmark`): genera modelos aleatorios de **cualquier metamodelo `.ecore`** y dibuja el resultado como grafo.

```
docker compose up --build        # la primera vez tarda unos minutos (descarga dependencias Maven/npm)
```

Abre <http://localhost:8090>. Se para con `docker compose down`. Los puertos (8090 front, 8091 API) no chocan con los de
[`../randomemf`](../randomemf), así que pueden estar los dos en marcha.

| Servicio   | Qué hace | Puerto |
|------------|----------|--------|
| `backend`  | El código original del instantiator (sin modificar) tras un servidor HTTP pequeño: carga el metamodelo, ejecuta la generación con la configuración de la UI, valida el modelo con EMF y lo devuelve como grafo + XMI + registro. | `127.0.0.1:8091` (solo para depurar con `curl`) |
| `frontend` | Aplicación web (Vite + TypeScript) servida por nginx, que hace de proxy de `/api`. | `127.0.0.1:8090` |

## Qué ves

* **Metamodelos**: copia cualquier `.ecore` en [`metamodels/`](metamodels/) (montada en el backend, solo lectura) y aparece en el desplegable
  (botón *Actualizar* o al volver a la pestaña). El instantiator trabaja con el metamodelo como datos (EMF dinámico), así que
  **no hay que generar ni compilar nada**. Vienen dos de ejemplo: `library.ecore` (atributos, enum, herencia) y `yakindu_simplified.ecore`.
* **Parámetros** (los de la línea de comandos del instantiator):

  | UI | Opción | Significado |
  |----|--------|-------------|
  | Tamaño | `-s` | objetos del modelo |
  | Grado | `-d` | referencias **y** valores de atributo por objeto (ver nota abajo) |
  | Tolerancia del tamaño (%) | `-p` | cuánto puede variar el tamaño real respecto al pedido, de más o de menos (por defecto ±10 %) |
  | Tolerancia del grado (%) | `-v` | lo mismo para el grado (referencias y atributos; por defecto ±10 %) |
  | Semilla | `-e` | por defecto una nueva en cada *Generate* (se muestra la usada); con el candado, la misma semilla da siempre el mismo modelo |

  Fijos, sin control en la interfaz: longitud media de las cadenas **12** con su propia variación ±10 % (`-z`), el modelo **siempre se
  diagnostica** (`-g`) y **nunca se fuerza** (`-f`): un metamodelo con errores de validación no se usa hasta corregirlo (los avisos no bloquean).
* **Metaclases**: el instantiator admite configurar qué clases intervienen; la línea de comandos no lo expone pero su interfaz
  `ISpecimenConfiguration` sí. Aquí, por metaclase: **Usar** (desmarcar = no se instancia) y **Raíz** (qué clases pueden ser raíz; por defecto las que ninguna otra contiene).
* **Restricciones OCL**: copia también un `.ocl` en `metamodels/` con invariantes `context Clase inv Nombre: ...` (ver
  `yakindu_constraints.ocl`) y se comprueban sobre cada modelo generado. Un `.ocl` se asocia a "su" metamodelo automáticamente: una
  restricción cuenta para un metamodelo si su clase de `context` existe ahí (sin depender de que los nombres de archivo coincidan). La
  pestaña **Restricciones OCL** lista cada invariante con cuántas instancias se comprobaron, cuántas la incumplen y ejemplos de cuáles; en el
  grafo, los objetos que incumplen algo salen con un punto rojo y un contador. Ten en cuenta que el instantiator genera **al azar, sin
  intentar cumplir las restricciones** (solo respeta la estructura del metamodelo: tipos, multiplicidades, contención), así que ver
  invariantes incumplidas es lo esperable, no un fallo del generador — es justo lo que esta pestaña sirve para mostrar. El motor de OCL
  soporta un subconjunto pragmático (navegación, `select/reject/exists/forAll/collect`, `size/isEmpty/notEmpty`, `oclIsKindOf`,
  comparaciones, lógica booleana, `if/let`); no implementa `allInstances()` ni el estándar completo.
* **Modelo generado**: un nodo por objeto (tipo, valores de atributo) y aristas de contención (rombo) y de referencia (discontinuas).
  Clic en un nodo o en una metaclase (tabla o barras del resumen) resalta los objetos de esa clase.
* **Resultado**: *Resumen* (objetos pedidos/generados, configuración aplicada, diagnóstico de EMF, restricciones OCL, objetos por metaclase),
  *Restricciones OCL* (detalle por invariante), *Registro* (lo que escribe el instantiator) y *XMI* (el modelo serializado, con botón de
  descarga).

## Cómo está construido

```
atlanmod-instantiator/
├── docker-compose.yml
├── mondo-atlzoo-benchmark/     # copia de atlanmod/mondo-atlzoo-benchmark (solo la carpeta fr.inria.atlanmod.instantiator), sin su .git
├── metamodels/                 # tus *.ecore y *.ocl, montada en el backend
├── backend/                    # Maven: módulo `instantiator` (sus fuentes, tal cual) + módulo `server` (HTTP)
└── frontend/                   # Vite + TypeScript, ELK (layout) y SVG propio (grafo)
```

La copia no se modifica: Maven compila sus `src/` con las dependencias de su `ivy.xml` (los fuentes están en Latin-1, por eso van en un
módulo aparte del servidor, que es UTF-8). La extensión de configuración está en
[`ConfigurableConfig.java`](backend/server/src/main/java/de/hub/instantiator/server/ConfigurableConfig.java). La comprobación de OCL
(parser y evaluador propios, sin relación con el instantiator) está en
[`Ocl.java`](backend/server/src/main/java/de/hub/instantiator/server/Ocl.java) y se aplica desde
[`Runner.java`](backend/server/src/main/java/de/hub/instantiator/server/Runner.java).

## Límites y cosas a saber

* **Grado**: como en el `Launcher` original, un único valor fija el rango de referencias *y* el de valores de atributo por objeto.
  (El `Launcher` tiene además un fallo: solo lee `-d` si también se pasa `-z`, y falla si se pasa `-z` sin `-d`; aquí no aplica porque se
  configura directamente la API.) El número de referencias por objeto se ajusta a la multiplicidad de cada referencia.
* Se dibuja el grafo si hay como máximo **300 objetos y 1500 aristas**; por encima solo se muestran los números y el XMI (que se ofrece si pesa
  menos de 3 MB). Los valores por defecto (tamaño 20, grado 2) están pensados para que el dibujo sea legible.
* El instantiator no garantiza modelos válidos (lo dice su README); El resumen muestra el diagnóstico de EMF con los errores que encuentre.
* Las cadenas y números son aleatorios sin más (p. ej. un `year` puede salir negativo): es lo que produce el instantiator.
* Se ejecuta una generación a la vez y tiene un límite de 60 s (el hilo se aborta). Tamaño máximo: 200 000 objetos.
* Un `.ecore` que dependa de otro archivo `.ecore` no se resuelve (se carga cada uno por separado).
* Un fallo de evaluación de una restricción OCL sobre un objeto concreto (p. ej. navegar una referencia vacía en algo que asumía que no
  lo estaba) cuenta como incumplimiento de esa restricción para ese objeto, y el ejemplo lo indica ("— error de evaluación: …").
* Código original: EPL 1.0, © AtlanMod / Obeo (ver [`epl-v10.html`](mondo-atlzoo-benchmark/fr.inria.atlanmod.instantiator/epl-v10.html)).

## Desarrollo

* API: `curl localhost:8091/api/health`, `GET /api/metamodels` (incluye las restricciones OCL de cada metamodelo), `POST /api/generate
  {"metamodel": "yakindu_simplified.ecore", "size": 20, "degree": 2, "sizeVariation": 0.1, "degreeVariation": 0.1, "seed": 1}` (la
  respuesta incluye `ocl`, con el resultado de cada invariante).
* Front con recarga en caliente: `cd frontend && npm install && npm run dev` (proxy a `localhost:8091`).
* Reconstruir solo un servicio: `docker compose up -d --build backend`.
