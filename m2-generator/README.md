# M2 (Model Mime) Playground

Interfaz web para [M2](M2/README.md): un generador de modelos **aprendido**. Una red neuronal (RGCN + GRU) entrenada con un dataset de modelos reales
va construyendo un modelo nuevo desde un objeto raíz, aplicando paso a paso *operaciones de edición de adición* («añadir un `State`», «añadir una
transición»…). A diferencia de los otros generadores, **primero hay que entrenarlo**; los datasets están en [`M2-experiments/data`](M2-experiments/data).

```
docker compose up --build        # la primera vez tarda unos minutos (imagen con PyTorch/CUDA, ~4 GB)
```

Abre <http://localhost:8100>. Se para con `docker compose down` (los modelos entrenados se conservan). Puertos distintos a los de `../randomemf`
(8080) y `../atlanmod-instantiator` (8090): pueden estar los tres en marcha.

| Servicio   | Qué hace | Puerto |
|------------|----------|--------|
| `backend`  | Python 3.8 + PyTorch 1.11 (CUDA 10.2) + PyG 2.0.4, el entorno que pide M2, con el código de M2 sin modificar. Entrena en segundo plano (un subproceso con progreso y cancelación), genera y valida. | `127.0.0.1:8101` (solo para depurar con `curl`) |
| `frontend` | Aplicación web (Vite + TypeScript) servida por nginx, que hace de proxy de `/api`. | `127.0.0.1:8100` |

**GPU.** El backend reserva tu GPU NVIDIA (`deploy.resources` del compose; hace falta el driver y Docker con soporte de GPU, como en Docker Desktop +
WSL2). El entrenamiento la usa; la generación corre en CPU, como en M2, y tarda menos de un segundo. Sin GPU, borra el bloque `deploy` del compose:
M2 cae solo a la CPU (bastante más lento).

## Qué ves

* **Generar** (cabecera): elige un modelo, un tamaño máximo (objetos) y una semilla (por defecto, una nueva en cada *Generate*; con el candado, la misma
  da siempre el mismo modelo) y pulsa *Generate*. Vienen listos dos modelos **preentrenados por los autores de M2** (Yakindu ejercicio y Ecore GitHub).
* **Modelo generado**: el grafo de sus objetos (un nodo por objeto, con su tipo; aristas de contención y de referencia). Debajo del título hay un
  **reproductor**: mueve el control o pulsa ▶ para ver la generación paso a paso; en cada paso se marcan en verde los nodos y aristas que añadió la red.
* **Operaciones aplicadas**: la secuencia completa de operaciones de edición que eligió la red (equivale a las «reglas aplicadas» de RandomEMF); clic en
  una fila para saltar a ese paso.
* **Resumen**: objetos, aristas, pasos, intentos fallidos y por qué paró (tamaño máximo / la red decidió terminar / sin operaciones aplicables);
  si el modelo **cumple las restricciones del dominio** que usa M2 para juzgar la consistencia (solo Yakindu y Ecore, una a una); si es **nuevo** o
  idéntico (isomorfo) a algún modelo del entrenamiento; recuento de operaciones y de objetos por tipo (clic en un tipo lo resalta en el grafo).
* **XMI**: el modelo serializado, con descarga. M2 modela solo la **estructura** (tipos y referencias): no genera valores de atributo.

## Entrenar un modelo

Pestaña *Entrenar* del panel izquierdo: dataset, nombre e hiperparámetros (los de `main.py --train`), y *Entrenar*. Se ve el progreso en tiempo real (fase,
descomposición Monte Carlo, épocas, curva de pérdida y registro) y se puede **cancelar**. Al terminar el modelo aparece en el desplegable y en la pestaña
*Modelos* (con su curva de pérdida; los entrenados aquí se pueden borrar). Se guardan en [`trained-models/`](trained-models/) y sobreviven a reiniciar Docker.
Solo se entrena uno a la vez.

| Dataset (`M2-experiments/data/…`) | Entrenamiento / prueba | Metamodelo (simplificado) | Raíz | Operaciones complejas | Restricciones |
|---|---|---|---|---|---|
| `yakindu-exercise` | 164 / 110 | `M2/data/yakindu_simplified.ecore` | `Statechart` | sí | sí |
| `yakindu-github` | 77 / 52 | ídem | `Statechart` | sí | sí |
| `ecore-github` | 168 / 113 | `M2/data/ecore_simplified.ecore` | `EPackage` | sí | sí |
| `rds-genmymodel` | 241 / 161 | `M2-experiments/data/metamodels/rdsSimplified.ecore` | `Database` | no | no |

**Cuánto tarda.** Con la RTX 2060, Yakindu ejercicio (los modelos más grandes, ~100 objetos): la *descomposición Monte Carlo* de cada `k` cuesta ~50 s **en
CPU** (no se acelera con GPU) y cada época ~6 s × `k` en GPU (con CPU, ~15 s × `k`). Un entrenamiento corto (`k=1`, 3 épocas) tarda ~1,5 min; los valores
por defecto de la interfaz (`k=3`, 10 épocas), ~6 min; los de M2 (`k=10`, 25 épocas), en torno a media hora. Un modelo poco entrenado genera modelos poco
realistas: es normal. El formulario muestra una estimación (un máximo, calculada con el dataset más pesado).

**Cómo se leen los datasets.** `main.py --train` lee todo con el único metamodelo de `--metamodel`, lo que solo sirve si los modelos ya lo cumplen. Los
datasets de M2-experiments son modelos reales de metamodelos más grandes (`sgraph` de Yakindu, RDS de GenMyModel, el propio Ecore), así que aquí cada
dataset declara con qué metamodelos completos se **leen** los modelos ([`datasets.py`](backend/app/datasets.py)) y después M2 los reduce al simplificado
(`remove_out_of_scope`), como hace él. Los modelos que pyecore no consigue leer se omiten (8 de los 168 de `ecore-github`). El resto del entrenamiento es
el `train_generator` de M2 tal cual ([`train_job.py`](backend/app/train_job.py)).

## Cómo está construido

```
m2-generator/
├── docker-compose.yml
├── M2/                 # tu clon de Antolin1/M2 (sin modificar): el generador
├── M2-experiments/     # tu clon de Antolin1/M2-experiments (sin modificar): se monta solo `data/`, en solo lectura
├── trained-models/     # los modelos que entrenes aquí (fuera de git)
├── backend/app/        # servidor HTTP (Python), entrenamiento en subproceso, generación con registro de pasos
└── frontend/           # Vite + TypeScript, ELK (layout) y SVG propio (grafo)
```

Los baselines de M2-experiments (RandomEMF, VIATRA, Random Instantiator) no se usan. Los modelos preentrenados de `M2/models` se montan como solo
lectura y aparecen como *M2 preentrenado*.

**Reproducir la generación paso a paso.** `Pallete.apply_edit` de M2 renumera todos los nodos en cada paso, así que no se puede saber qué añadió cada
operación mirando los identificadores. La generación se muestrea con `sample_graph` de M2 sobre una copia de la paleta ([`generator.py`](backend/app/generator.py))
que marca cada nodo con un identificador propio y anota lo que añade cada operación aplicada con éxito.

## Límites y cosas a saber

* Los modelos generados pueden no cumplir las restricciones del dominio (lo evalúa M2 con `constraints/`); con poco entrenamiento es lo habitual.
* «Operaciones complejas» solo existe para Yakindu y Ecore. Un modelo entrenado con ellas hay que usarlo con ellas (lo recuerda el modelo): el
  preentrenado de Yakindu las necesita. M2 decide qué operaciones complejas añadir mirando si la ruta del metamodelo contiene `yakindu` o `ecore`, y
  toda ruta `*.ecore` contiene `ecore`; por eso no se ofrecen para RDS.
* Tamaño máximo de generación: 500 objetos. Las restricciones y la novedad se calculan al vuelo (la primera vez que se usa un dataset, unos segundos
  mientras se leen sus modelos de entrenamiento).
* Si el servidor se para durante un entrenamiento, ese modelo queda como *interrumpido* y no se puede usar (bórralo y vuelve a entrenar).
* Los puertos solo escuchan en `127.0.0.1`.

## Desarrollo

* API: `curl localhost:8101/api/health`, `GET /api/datasets`, `GET /api/models`, `POST /api/train {"name": "x", "dataset": "yakindu-exercise", "epochs": 10, "k": 3}`,
  `GET /api/train` (progreso), `POST /api/train/cancel`, `POST /api/generate {"model": "pretrained:yakindu_exercise", "max_size": 40, "seed": 1}`.
* Front con recarga en caliente: `cd frontend && npm install && npm run dev` (proxy a `localhost:8101`).
* Reconstruir solo un servicio: `docker compose up -d --build backend`.
