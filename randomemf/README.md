# RandomEMF Playground

Editor de **rcore** + botón **Generate** que ejecuta un generador de [RandomEMF](RandomEMF/) y dibuja el
modelo resultante como grafo de su sintaxis abstracta, junto con las **reglas que se aplicaron** para crearlo.

```
docker compose up --build        # la primera vez tarda unos minutos (descarga dependencias Maven/npm)
```

Abre <http://localhost:8080>. Se para con `docker compose down`.

| Servicio   | Qué hace | Puerto |
|------------|----------|--------|
| `backend`  | RandomEMF completo (Xtext 2.9, JDK 8) + un servidor HTTP pequeño. Genera el código EMF de tus metamodelos, valida el `.rcore`, deja que RandomEMF genere el Java del generador, lo compila en memoria, lo ejecuta y devuelve grafo + traza. | `127.0.0.1:8081` (solo para depurar con `curl`) |
| `frontend` | Aplicación web (Vite + TypeScript) servida por nginx, que también hace de proxy de `/api` hacia el backend. | `127.0.0.1:8080` |

> **Seguridad.** Las expresiones de un `.rcore` son Xbase, es decir, Java arbitrario, y el backend las compila y ejecuta.
> Es una herramienta local: los puertos solo escuchan en `127.0.0.1`. No la publiques en una red no confiable.

## Qué ves

* **Generador**: editor con resaltado de rcore y errores de Xtext en línea (parseo, enlazado, tipos de Xbase) mientras escribes.
  Si el generador declara parámetros (`generator Foo(int n, String p) ...`), aparecen como campos junto a *Generate*.
* **Sintaxis abstracta**: un nodo por objeto (tipo, nombre, atributos y la regla que lo creó), aristas de contención (rombo) y
  de referencia (discontinuas). Los objetos externos al modelo (p. ej. `EString` de `EcorePackage`) salen punteados.
  «implícitos» muestra objetos que EMF crea por su cuenta y ninguna regla generó (p. ej. `EGenericType`).
* **Reglas aplicadas**: árbol de la ejecución (regla → asignaciones `:=`/`+=` con cuántas veces se evaluaron → reglas hijas;
  en las `alter`, qué alternativa se eligió), **Resumen** (aplicaciones por regla, reparto real de alternativas, objetos por tipo)
  y el **Java generado**.
* Todo está enlazado: clic en un nodo → su fila del árbol y su regla en el editor; clic en una fila → el nodo y la línea de
  la regla; el cursor en una regla resalta en el grafo los objetos que creó.
* **Semilla**: por defecto una nueva en cada *Generate* (se muestra la usada); con el candado, la misma semilla da siempre el mismo modelo.

## Usar tus propios metamodelos

Copia tus `.ecore` en la carpeta [`metamodels/`](metamodels/) (está montada en el backend, solo lectura). **No hace falta reiniciar ni generar
nada a mano**: el backend detecta los cambios y, para cada `.ecore`, genera su `.genmodel` y su código Java con el generador de EMF,
lo compila y lo registra; si cambias el `.ecore` lo rehace, y si lo borras lo olvida.

* Si al lado hay un `.genmodel` con el mismo nombre (`foo.ecore` + `foo.genmodel`), se usa ese (paquete base, prefijos…). Si no, se crea uno con
  paquete base `mm` (por ejemplo `mm.yakindumm.State`).
* En el generador el metamodelo se referencia así (el botón **Metamodelos** de la UI te da la línea exacta y un botón *Copiar*):

  ```
  generator Mio for yakindumm
      in "platform:/resource/metamodels/yakindu_simplified.ecore" { … }
  ```
* **Metamodelos** (botón del editor) lista lo detectado, con su estado y, si un `.ecore` no se puede procesar, el motivo. Desde ahí, *Nuevo generador
  para este metamodelo* escribe en el editor un generador inicial: una regla por clase alcanzable por contención (con `alter` donde una referencia admite
  varias clases), atributos con valores aleatorios según su tipo (incluidos enums) y la contención acotada con `depth`. Las referencias no contenidas
  (p. ej. el destino de una transición) quedan comentadas con un ejemplo `@(…)`, porque qué objeto elegir depende de tu dominio.
* Los `*.rcore` que dejes en esa carpeta aparecen en la lista de ejemplos. Ya hay dos para Yakindu: [`yakindu_simplified.rcore`](metamodels/yakindu_simplified.rcore) y [`yakindu_parametrico.rcore`](metamodels/yakindu_parametrico.rcore), este con parámetros del generador (`generator X(int states, double extraTransitions, boolean nested)`), que la UI pide junto a *Generate*.
* Limitaciones: un `.ecore` que dependa de otro (`eSuperTypes` o `eType` hacia un segundo archivo) no se genera bien porque cada uno se procesa por separado;
  los tipos de datos con clases Java propias (`instanceClassName` que no esté en el classpath) tampoco. Los `nsURI` no pueden repetirse ni coincidir con el de Ecore.

## Cómo está construido

```
generators/
├── docker-compose.yml
├── RandomEMF/            # copia de tu clon, sin su .git (casi intacta, ver abajo)
├── metamodels/           # tus *.ecore (+ *.genmodel opcional) y *.rcore; montada en el backend
├── backend/
│   ├── Dockerfile        # contexto = raíz del repo: necesita RandomEMF/ y backend/
│   ├── pom.xml           # copia RandomEMF/plugins/de.hub.rcore a target/, genera el lenguaje y compila todo
│   ├── workflow/…mwe2    # GenerateRcore.mwe2 sin los fragmentos de UI de Eclipse
│   └── src/main/java/de/hub/randomemf/server/   # servidor HTTP, metamodelos (EMF codegen), compilación en memoria, traza, exportación a grafo
└── frontend/             # Vite + TypeScript, CodeMirror 6 (editor), ELK (layout) y SVG propio (grafo)
```

RandomEMF se escribió para Eclipse (Xtext 2.9, Mars). El build lo hace headless con Maven y JDK 8, con las versiones de EMF/Xtext
fijadas a esa época (los POM de Xtext 2.9 usan rangos abiertos que hoy arrastran versiones que exigen Java 17).
El workflow MWE2 escribe todo lo generado en `backend/target/`; el clon no se toca al construir.

### Cambios en el clon de RandomEMF

Mínimos, para poder mostrar las reglas aplicadas (todos bajo `RandomEMF/plugins/de.hub.rcore/src/de/hub/randomemf/`; la carpeta ya no tiene `.git`, así que no hay `git diff` que los liste):

* `runtime/Trace.java` (nuevo): observador opcional. El Java generado lo invoca y no hace nada si nadie escucha.
* `jvmmodel/RandomEMFJvmModelInferrer.xtend`: el código generado llama a `Trace` (inicio/fin de regla, asignaciones,
  alternativa elegida, referencias `@(…)` resueltas). No cambia el flujo de números aleatorios.
* `runtime/Random.java`: `setSeed(int)` para repetir ejecuciones, y `RandomID`/`RandomString` usan la misma semilla
  (antes usaban el generador sin semilla de commons-lang, así que no eran reproducibles pese a lo que dice el README).

## Límites y cosas a saber

* **Metamodelos**: ver la sección anterior para sus límites. Ecore va incluido.
* **Bug de RandomEMF, no corregido**: en las reglas `alter` la elección usa `current >= draw` cuando debería ser `current > draw`.
  Con dos alternativas de prioridad 1 la segunda **nunca** sale, y en general la última recibe `(peso − 1)/suma` en lugar de
  `peso/suma` (`Reference(true) | Reference(false) | Attribute#2` da 50 % / 25 % / 25 %, no 25 / 25 / 50). El panel *Resumen*
  muestra el reparto real. La corrección es una línea en el inferrer, pero cambia la salida de cualquier generador con `alter`,
  así que lo dejo a tu criterio.
* **Recursión**: «Máx. objetos» no evita la recursión infinita, porque RandomEMF cuenta un objeto al terminar de generarlo.
  El `StackOverflowError` se captura y se muestra; limita la recursión con `depth`. Una generación tiene un límite de 30 s
  (el hilo se aborta) y solo se ejecuta una a la vez, porque RandomEMF guarda su estado aleatorio en variables estáticas.
* Referencias diferidas `@(…)` sobre `eType` de Ecore fallan en RandomEMF (EMF copia el proxy al `EGenericType`);
  el propio `RandomEcore.rcore` las evita.

## Desarrollo

* API: `curl localhost:8081/api/health`, `GET /api/metamodels`, `POST /api/template {"file": "x.ecore"}`,
  `POST /api/analyze {"source": …}`, `POST /api/generate {"source": …, "seed": 1, "maxObjects": 100, "args": {…}}`.
* Front con recarga en caliente: `cd frontend && npm install && npm run dev` (proxy a `localhost:8081`).
* Reconstruir solo un servicio: `docker compose up -d --build backend`.
