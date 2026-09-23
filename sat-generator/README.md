# Generador SAT (USE + SAT4J)

Genera modelos de un metamodelo Ecore que cumplan sus restricciones OCL **mapeando la búsqueda a un
problema de satisfacibilidad booleana (SAT)**: en vez de generar al azar y comprobar después (como
[`randomemf`](../randomemf) o [`atlanmod-instantiator`](../atlanmod-instantiator)), codifica en CNF "¿existe
un modelo, dentro de estas cotas, que cumpla el metamodelo y las restricciones?" y se lo pasa a un resolutor
SAT de verdad ([SAT4J](https://www.sat4j.org/)). Si es satisfacible, la asignación que devuelve el resolutor
**es** el modelo; si no, el resolutor lo demuestra (no es "no lo encontré", es "no existe uno dentro de esas
cotas"). Usa [USE](https://github.com/useocl/use) (UML-based Specification Environment) como el motor de
verdad: construye con él el modelo (clases, asociaciones, invariantes) y, una vez encontrado un modelo,
reproduce los mismos objetos y enlaces en un sistema USE real para comprobarlo de forma independiente — no
solo confiando en el propio compilador SAT.

```
docker compose up --build        # la primera vez tarda unos minutos (compila USE, EMF, SAT4J y npm)
```

Abre <http://localhost:8120>. Con el ejemplo de Yakindu que trae por defecto ya sale un modelo válido.

## Cómo funciona

```
metamodelo (.ecore) ──► clases + asociaciones (multiplicidad, contención)
                                    │
restricciones (.ocl) ───────────────┤
                                    ▼
                     codificación a CNF (Encoder + Cnf):
                     - una variable "existe" por hueco candidato de cada clase
                     - una variable "enlazado" por cada posible pareja de huecos de una relación
                     - cotas del scope, multiplicidad por objeto, un único árbol de contención sin ciclos
                     - las restricciones OCL que se puedan traducir (Ocl2Sat), como cláusulas más
                                    │
                                    ▼
                          SAT4J (resolutor SAT)
                                    │
                    ┌────── UNSAT ─┴─ SAT ──────────────┐
                    ▼                                    ▼
        "no existe ningún modelo              decodifica los huecos activos y
         dentro de estas cotas"                enlaces en objetos EMF reales
                                                            │
                                                            ▼
                                        se reproducen en un sistema USE real
                                        (mismas clases, asociaciones e invariantes)
                                                            │
                                                            ▼
                                  checkState() + una consulta OCL por restricción
                                  → comprobación independiente, grafo, y exportar a XMI
```

**El "mapeo a SAT"** ([`Encoder.java`](backend/server/src/main/java/org/satgen/server/Encoder.java),
[`Cnf.java`](backend/server/src/main/java/org/satgen/server/Cnf.java)): cada clase concreta recibe una bolsa
de huecos candidatos (su cota del scope, o una por defecto); cada relación, una variable booleana "enlazado"
por cada pareja de huecos compatible. Sobre esas variables se codifican con puertas de Tseitin y un contador
binario (para `size() OP n`): las cotas de tamaño del scope, la multiplicidad de cada extremo de cada
asociación (solo si el hueco está activo), que cada objeto contenido tenga **exactamente un** padre (y la
raíz, como mucho uno) y, para que la contención no forme un ciclo con el padre en lugar de un árbol, un
"rango" libre por objeto que tiene que crecer estrictamente en cada enlace de contención activo.

**El subconjunto de OCL que se traduce a SAT**
([`Ocl2Sat.java`](backend/server/src/main/java/org/satgen/server/Ocl2Sat.java)): navegación, `select`,
`reject`, `exists`, `forAll`, `size`/`isEmpty`/`notEmpty`/`includes`/`excludes`, `oclIsKindOf`/`oclIsTypeOf`,
lógica booleana y comparaciones numéricas — el mismo subconjunto pragmático que ya usan
[`atlanmod-instantiator`](../atlanmod-instantiator) y [`llm-generator`](../llm-generator), aquí compilado a
cláusulas en vez de interpretado. Lo que no soporta (atributos, `allInstances()`, comparar identidad de
objetos, …) simplemente no entra en la búsqueda SAT — no bloquea nada, se comprueba después con USE (ver
abajo) y se marca en la interfaz como "no traducida a SAT".

**La comprobación con USE** ([`UseModel.java`](backend/server/src/main/java/org/satgen/server/UseModel.java),
en [`Runner.java`](backend/server/src/main/java/org/satgen/server/Runner.java)): el mismo metamodelo se
construye también como un modelo USE de verdad (clases, generalizaciones, asociaciones con su multiplicidad
y agregación, e invariantes registradas con el compilador OCL real de USE). Encontrado un modelo por SAT, se
crean los mismos objetos y enlaces en un sistema USE (`UseSystemApi`) y se llama a `checkState()` — la
comprobación estructural y de invariantes real de USE — y, restricción a restricción, a una consulta
`Clase.allInstances()->select(x | not (...))` para saber exactamente qué objetos la incumplen. Esto cubre
**todas** las restricciones, no solo las que SAT pudo traducir.

## Scope: cotas de búsqueda, no generación aproximada

A diferencia de los generadores aleatorios, aquí "Región entre 1 y 1, State entre 2 y 3" no es un objetivo
aproximado: son las cotas exactas de la búsqueda. El resolutor decide, dentro de ellas, si hay algún modelo
— y si lo hay, cuál (no necesariamente el más grande ni el más pequeño; SAT4J devuelve el primero que
encuentra). **Una clase sin cota propia no tiene un tope escondido**: puede llegar a ser tan grande como el
presupuesto de la búsqueda lo permita — ese presupuesto es el `Total de objetos` máximo si lo defines, o un
valor interno modesto (6) solo cuando la petición no acota nada en absoluto (para que "no pongo ningún
límite" siga dando una búsqueda rápida por defecto). Si subes mucho el total, o el máximo de varias clases a
la vez, la codificación crece con ellas — el número de posibles enlaces entre dos clases es, en el peor
caso, el producto de sus dos cotas — así que puede tardar más o llegar al límite de 20 s; esto es un coste
real de buscar exhaustivamente con SAT, no una cota artificial del generador. Si eso pasa, acota las clases
que no te importen para que la búsqueda tenga menos donde mirar.

## Estructura del repositorio

```
sat-generator/
├── docker-compose.yml
├── use/                         # clon de useocl/use (sin modificar), solo se usa use-core
├── metamodels/                  # tus *.ecore y *.ocl, montada en el backend
├── backend/
│   ├── Dockerfile               # build en dos pasos: use-core, luego el servidor
│   └── server/                  # el servidor HTTP (Java 21, sin frameworks: com.sun.net.httpserver)
│       ├── Cnf.java             # CNF: variables, puertas de Tseitin, contador binario y comparador
│       ├── Ocl2Sat.java         # el subconjunto de OCL, compilado a CNF (no interpretado)
│       ├── MetaModel.java       # el .ecore reducido a clases concretas y relaciones canónicas
│       ├── Vars.java            # registro de variables (existe / enlazado), creadas bajo demanda
│       ├── Encoder.java         # ensambla todo el problema SAT
│       ├── Solver.java          # SAT4J
│       ├── UseModel.java        # el mismo metamodelo, como modelo USE real
│       ├── Runner.java          # orquesta todo lo anterior y decodifica la solución
│       ├── GraphExporter.java   # el modelo encontrado, como grafo para la interfaz
│       ├── Metamodels.java      # carga de *.ecore/*.ocl (mismo criterio de asociación que atlanmod-instantiator)
│       └── Api.java / Json.java / Main.java
└── frontend/                    # Vite + TypeScript, ELK (layout), SVG propio (grafo), CodeMirror (OCL/XMI)
```

## Qué ves

* **Metamodelo**: copia un `.ecore` (y, si quieres, un `.ocl` con `context Clase inv Nombre: ...`) en
  [`metamodels/`](metamodels/); aparece en el desplegable (botón *Actualizar*). Trae `yakindu_simplified.ecore`
  y `yakindu_constraints.ocl` — el ejemplo de statecharts de Yakindu, con 10 invariantes — como los de
  [`atlanmod-instantiator`](../atlanmod-instantiator/metamodels) y
  [`llm-generator`](../llm-generator/mm-ocl-py/examples). Una restricción `.ocl` cuenta para el metamodelo
  cargado si su clase de `context` existe en él (no hace falta que los nombres de archivo coincidan).
* **Restricciones OCL**: se muestran tal cual se leyeron, con resaltado de sintaxis (no son editables desde
  aquí: edítalas en el fichero y pulsa *Actualizar*).
* **Scope**: clase raíz y cotas por metaclase (ver arriba). *Generate* lanza la búsqueda.
* **Resultado**: si es SAT, el modelo como grafo (los objetos que incumplen algo, si USE encuentra alguno,
  salen en rojo) y, abajo, **Resumen** (SAT/UNSAT, variables, cláusulas, tiempo, objetos, diagnóstico de
  USE), **Restricciones OCL** (cada invariante: si se tradujo a SAT, cuántas instancias se comprobaron y
  cuántas la incumplen según USE, con ejemplos), **Diagnóstico USE** (el registro literal de
  `checkState()`), **Código SAT** (la fórmula CNF de verdad, en formato DIMACS, con las variables `existe(...)`
  y `enlace(...)` listadas como comentario — el resto son auxiliares de las puertas de Tseitin) y **XMI**
  (descargable). El código SAT también se enseña cuando el resultado es UNSAT, para poder inspeccionar
  exactamente qué se le pidió al resolutor.

## Límites y cosas a saber

* **No hay atributos**: igual que el resto de generadores de este repositorio los dejan fuera de la parte
  "producto", aquí tampoco entran en la codificación SAT — un objeto existe o no, y está enlazado o no.
* El subconjunto de OCL es el mismo de siempre (ver arriba); lo que quede fuera no impide generar, solo se
  comprueba después con USE y se marca como "no traducida a SAT" en la interfaz.
* Nada tiene una cota que no hayas puesto tú, salvo el presupuesto interno (6) que se usa solo si no acotas
  nada en absoluto — y un techo de seguridad de 500 en el total, solo para proteger el servidor de una
  petición desmedida, no una decisión de modelado. Una petición sin resolver en 20 s se aborta con un
  mensaje claro (no se confunde con "no existe modelo": es "no me ha dado tiempo a decidirlo").
* Los ficheros `.ecore` de ejemplo tal como están no tienen invariante alguna que fuerce que las
  restricciones sí se cumplan generando al azar (por eso los otros generadores de este repo casi siempre
  las incumplen); aquí, si SAT dice que sí hay modelo, **por construcción** las cumple todas las que pudo
  traducir — y USE, después, confirma que también cumple las demás.
* Código de USE: EPL 1.0/GPL2 según el módulo, © University of Bremen & University of Applied Sciences
  Hamburg — ver [`use/COPYING`](use/COPYING). No se ha modificado.

## Probado

A mano: con el ejemplo de Yakindu, `Region` 1..1 y `State` 2..3 da un modelo SAT válido (comprobado también
con `curl` contra `/api/generate`, sin pasar por la interfaz) donde las 10 restricciones se traducen a SAT y
USE confirma que se cumplen todas (`checkState()` sin fallos); una petición contradictoria (`State` fijo a 5
con un total máximo de 3) da UNSAT correctamente. También se probó a subir el total bastante (varias
docenas de objetos): con pocas clases sin cota va bien, pero acotar el total sin acotar ninguna clase acaba
con muchas clases compitiendo por un presupuesto grande a la vez, y eso sí puede llegar al límite de 20 s —
es el coste esperado de la búsqueda exhaustiva, explicado arriba. La interfaz se probó en el navegador
(carga del metamodelo, scope, grafo, las cinco pestañas del resultado incluido el código SAT, exportar XMI)
sin errores de consola. No hay todavía una batería de tests automatizados (a diferencia de `llm-generator`,
que sí la tiene) — es la parte más nueva de este generador y la que más se beneficiaría de tests si vas a
seguir tocando el codificador SAT.

## Desarrollo

* API: `curl localhost:8121/api/health`, `GET /api/metamodels`,
  `POST /api/generate {"metamodel": "yakindu_simplified.ecore", "rootClass": "Statechart", "classBounds": {"Region": {"min":1,"max":1}, "State": {"min":2,"max":3}}}`.
* Front con recarga en caliente: `cd frontend && npm install && npm run dev` (proxy a `localhost:8121`).
* Reconstruir solo un servicio: `docker compose up -d --build backend`.
* Para compilar el backend fuera de Docker hace falta compilar antes `use/use-core` e instalarlo en el
  repositorio Maven local: `cd use && mvn -q -pl use-core -am install -DskipTests`, y luego
  `cd ../backend && mvn install`.
