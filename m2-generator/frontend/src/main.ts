import './style.css';
import { api, type Dataset, type GenerateOk, type Job, type ModelInfo, type TrainParams } from './api';
import { GraphView, typeColor, type Direction } from './graph';

// ---------- helpers ----------

const $ = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Falta ${selector} en el HTML`);
  return element;
};

function stored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function store(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode or full storage: settings just won't persist */
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', content?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined) element.textContent = content;
  return element;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function fmtTime(seconds: number): string {
  const s = Math.round(seconds);
  return s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const ICON_LOCKED =
  '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M8 1a3.5 3.5 0 0 0-3.5 3.5V6H4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1h-.5V4.5A3.5 3.5 0 0 0 8 1Zm-2 3.5a2 2 0 1 1 4 0V6H6V4.5Z"/></svg>';
const ICON_UNLOCKED =
  '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M8 1a3.5 3.5 0 0 0-3.5 3.5V6H4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1H6V4.5a2 2 0 0 1 3.9-.6.75.75 0 1 0 1.44-.4A3.5 3.5 0 0 0 8 1Z"/></svg>';

/** A small SVG line chart of the training loss. */
function lossChart(losses: number[], big: boolean): string {
  const w = 300;
  const h = big ? 96 : 34;
  if (losses.length < 2) return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"></svg>`;
  const min = Math.min(...losses);
  const max = Math.max(...losses);
  const span = max - min || 1;
  const padX = big ? 34 : 2;
  const padY = big ? 12 : 4;
  const x = (i: number) => padX + (i / (losses.length - 1)) * (w - padX - 6);
  const y = (v: number) => padY + (1 - (v - min) / span) * (h - padY * 2);
  const path = losses.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const axes = big
    ? `<line class="grid" x1="${padX}" x2="${w - 6}" y1="${padY}" y2="${padY}" /><line class="grid" x1="${padX}" x2="${w - 6}" y1="${h - padY}" y2="${h - padY}" />` +
      `<text x="2" y="${padY + 3}">${max.toFixed(3)}</text><text x="2" y="${h - padY + 3}">${min.toFixed(3)}</text>`
    : '';
  return `<svg class="chart${big ? '' : ' mini'}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${axes}<path d="${path}" vector-effect="non-scaling-stroke" /></svg>`;
}

// ---------- settings ----------

interface TrainForm {
  dataset: string;
  name: string;
  epochs: number;
  k: number;
  hidden_dim: number;
  lr: number;
  batch_size: number;
  patience: number;
  seed: number;
  complex: boolean;
}

interface Settings {
  model: string | null;
  maxSize: number;
  seed: number | null;
  seedLocked: boolean;
  direction: Direction;
  train: Partial<TrainForm>;
}

const settings: Settings = {
  model: null,
  maxSize: 40,
  seed: null,
  seedLocked: false,
  direction: 'RIGHT',
  train: {},
  ...stored<Partial<Settings>>('m2.settings', {}),
};
const saveSettings = () => store('m2.settings', settings);

// ---------- elements ----------

const modelSelect = $<HTMLSelectElement>('#model');
const maxSizeInput = $<HTMLInputElement>('#max-size');
const seedInput = $<HTMLInputElement>('#seed');
const seedLock = $<HTMLButtonElement>('#seed-lock');
const generateButton = $<HTMLButtonElement>('#generate');
const statusPill = $<HTMLSpanElement>('#backend-status');
const graphModel = $<HTMLSpanElement>('#graph-model');
const graphStats = $<HTMLSpanElement>('#graph-stats');
const stepper = $<HTMLDivElement>('#stepper');
const stepRange = $<HTMLInputElement>('#step-range');
const stepLabel = $<HTMLSpanElement>('#step-label');
const stepPlay = $<HTMLButtonElement>('#step-play');
const downloadButton = $<HTMLButtonElement>('#download');
const tabBodies: Record<string, HTMLElement> = { steps: $('#tab-steps'), summary: $('#tab-summary'), xmi: $('#tab-xmi') };
const sideBodies: Record<string, HTMLElement> = { train: $('#side-train'), models: $('#side-models') };

const graph = new GraphView($('#graph'), {
  onSelect(nodeId) {
    graph.select(nodeId);
    const node = nodeId && result ? result.graph.nodes.find((n) => n.id === nodeId) : undefined;
    highlightType(node?.type ?? null, false);
    if (node?.step !== undefined) markStepRow(node.step, true);
  },
});
graph.showMessage('Elige un modelo y pulsa <b>Generate</b> para generar un modelo con la red entrenada.', 'empty');

// ---------- state ----------

let datasets: Dataset[] = [];
let defaults: TrainParams | null = null;
let models: ModelInfo[] = [];
let job: Job | null = null;
let result: GenerateOk | null = null;
let busy = false;
let highlighted: string | null = null;
let currentStep = 0;
let playTimer = 0;

const datasetLabel = (id: string) => datasets.find((d) => d.id === id)?.label ?? id;

// ---------- backend status ----------

let loadedOnce = false;

async function pollHealth() {
  try {
    const health = await api.health();
    statusPill.dataset.state = health.ready ? 'ready' : 'warming';
    statusPill.textContent = health.ready ? `Backend listo · ${health.device === 'cuda' ? 'GPU ' + (health.gpu ?? '').replace('NVIDIA GeForce ', '') : 'CPU'}` : 'Backend calentando…';
    if (health.ready && !loadedOnce) {
      loadedOnce = true;
      await Promise.all([loadDatasets(), loadModels(), refreshJob()]);
    }
  } catch {
    statusPill.dataset.state = 'down';
    statusPill.textContent = 'Backend sin conexión';
  }
  window.setTimeout(pollHealth, statusPill.dataset.state === 'ready' ? 10000 : 1500);
}

// ---------- side panel tabs ----------

for (const tab of document.querySelectorAll<HTMLButtonElement>('[data-side]')) {
  tab.addEventListener('click', () => {
    for (const other of document.querySelectorAll<HTMLButtonElement>('[data-side]')) other.setAttribute('aria-selected', String(other === tab));
    for (const [key, body] of Object.entries(sideBodies)) body.hidden = key !== tab.dataset.side;
  });
}

// ---------- datasets & training form ----------

const form = {
  dataset: $<HTMLSelectElement>('#t-dataset'),
  name: $<HTMLInputElement>('#t-name'),
  epochs: $<HTMLInputElement>('#t-epochs'),
  k: $<HTMLInputElement>('#t-k'),
  hidden: $<HTMLInputElement>('#t-hidden'),
  lr: $<HTMLInputElement>('#t-lr'),
  batch: $<HTMLInputElement>('#t-batch'),
  patience: $<HTMLInputElement>('#t-patience'),
  seed: $<HTMLInputElement>('#t-seed'),
  complex: $<HTMLInputElement>('#t-complex'),
};
const startButton = $<HTMLButtonElement>('#t-start');
const cancelButton = $<HTMLButtonElement>('#t-cancel');

function currentDataset(): Dataset | undefined {
  return datasets.find((d) => d.id === form.dataset.value);
}

async function loadDatasets() {
  const response = await api.datasets();
  datasets = response.datasets;
  defaults = response.defaults;
  form.dataset.replaceChildren(...datasets.map((d) => new Option(`${d.label}${d.available ? '' : ' (no disponible)'}`, d.id)));
  const saved = settings.train;
  form.dataset.value = datasets.some((d) => d.id === saved.dataset) ? saved.dataset! : datasets[0]?.id ?? '';
  form.name.value = saved.name ?? 'modelo-1';
  form.epochs.value = String(saved.epochs ?? defaults.epochs);
  form.k.value = String(saved.k ?? defaults.k);
  form.hidden.value = String(saved.hidden_dim ?? defaults.hidden_dim);
  form.lr.value = String(saved.lr ?? defaults.lr);
  form.batch.value = String(saved.batch_size ?? defaults.batch_size);
  form.patience.value = String(saved.patience ?? defaults.patience);
  form.seed.value = String(saved.seed ?? defaults.seed);
  form.complex.checked = saved.complex ?? defaults.complex;
  renderDatasetInfo();
  renderModelViews();
}

function readForm(): TrainForm {
  return {
    dataset: form.dataset.value,
    name: form.name.value.trim(),
    epochs: Number(form.epochs.value),
    k: Number(form.k.value),
    hidden_dim: Number(form.hidden.value),
    lr: Number(form.lr.value),
    batch_size: Number(form.batch.value),
    patience: Number(form.patience.value),
    seed: Number(form.seed.value),
    complex: form.complex.checked,
  };
}

function renderDatasetInfo() {
  const d = currentDataset();
  const info = $('#t-dataset-info');
  const complexLabel = $('#t-complex-label');
  if (!d) {
    info.textContent = '';
    return;
  }
  info.textContent = `${d.description} ${d.train} modelos de entrenamiento y ${d.test} de prueba · raíz «${d.root}».`;
  form.complex.disabled = !d.complex;
  complexLabel.classList.toggle('disabled', !d.complex);
  if (!d.complex) form.complex.checked = false;
  renderEstimate();
}

function renderEstimate() {
  const d = currentDataset();
  const f = readForm();
  const estimate = $('#t-estimate');
  if (!d || !Number.isFinite(f.k) || !Number.isFinite(f.epochs)) {
    estimate.textContent = '';
    return;
  }
  // measured on an RTX 2060 with the Yakindu dataset (the one with the largest models): ~0.3 s per model and k for the
  // Monte Carlo decomposition (CPU), ~0.04 s per model and k for each epoch (GPU)
  const decomposition = f.k * d.train * 0.3;
  const training = f.epochs * f.k * d.train * 0.04;
  estimate.textContent = `Tiempo orientativo (como máximo): ${fmtTime(decomposition + training)} — ${fmtTime(decomposition)} de descomposición Monte Carlo en CPU y ${fmtTime(training)} de épocas en GPU. La parada temprana puede acortarlo.`;
}

function persistForm() {
  settings.train = readForm();
  saveSettings();
  renderEstimate();
}
for (const input of Object.values(form)) input.addEventListener('input', persistForm);
form.dataset.addEventListener('change', () => {
  renderDatasetInfo();
  persistForm();
});

startButton.addEventListener('click', async () => {
  const f = readForm();
  startButton.disabled = true;
  try {
    const response = await api.train({
      name: f.name,
      dataset: f.dataset,
      epochs: f.epochs,
      k: f.k,
      hidden_dim: f.hidden_dim,
      lr: f.lr,
      batch_size: f.batch_size,
      patience: f.patience,
      seed: f.seed,
      complex: f.complex,
    });
    if (!response.ok) {
      alert(response.error ?? 'No se pudo empezar el entrenamiento');
      return;
    }
    await refreshJob();
    await loadModels();
  } catch (error) {
    alert(error instanceof Error ? error.message : String(error));
  } finally {
    renderJob();
  }
});

cancelButton.addEventListener('click', async () => {
  cancelButton.disabled = true;
  try {
    await api.cancel();
  } finally {
    await refreshJob();
  }
});

// ---------- training job ----------

const jobBox = $<HTMLDivElement>('#job');
let jobTimer = 0;

const isRunning = (j: Job | null) => j !== null && (j.status === 'running' || j.status === 'cancelling');

async function refreshJob() {
  try {
    const previous = job;
    job = (await api.job()).job;
    if (previous && isRunning(previous) && !isRunning(job)) await loadModels();
  } catch {
    /* the status pill tells when the backend is unreachable */
  }
  renderJob();
  window.clearTimeout(jobTimer);
  if (isRunning(job)) jobTimer = window.setTimeout(refreshJob, 2000);
}

function progressRow(label: string, done: number, total: number, active: boolean): HTMLElement {
  const row = el('div', `progress-row${active ? ' active' : ''}`);
  const bar = el('span', 'bar');
  const fill = document.createElement('i');
  fill.style.width = `${total ? Math.min(100, (done / total) * 100) : 0}%`;
  bar.append(fill);
  row.append(el('span', '', label), bar, el('span', 'n', `${done} / ${total}`));
  return row;
}

function renderJob() {
  const running = isRunning(job);
  startButton.disabled = running;
  cancelButton.hidden = !running;
  cancelButton.disabled = job?.status === 'cancelling';
  jobBox.hidden = job === null;
  if (!job) return;

  const statusText: Record<Job['status'], [string, string]> = {
    running: ['entrenando', ''],
    cancelling: ['cancelando…', 'warn'],
    done: ['terminado', 'ok'],
    failed: ['con errores', 'bad'],
    cancelled: ['cancelado', 'warn'],
  };
  const phaseText: Record<Job['phase'], string> = {
    starting: 'Arrancando…',
    loading: 'Leyendo el dataset…',
    decomposition: 'Descomposición Monte Carlo (CPU)',
    training: 'Entrenando la red',
    done: 'Terminado',
  };
  const top = el('div', 'job-top');
  top.append(el('b', '', job.name), el('span', `badge ${statusText[job.status][1]}`, statusText[job.status][0]));
  if (job.device_name) top.append(el('span', 'badge', job.device === 'cuda' ? `GPU · ${job.device_name.replace('NVIDIA GeForce ', '')}` : 'CPU'));

  const children: Node[] = [top];
  if (isRunning(job)) children.push(el('div', 'job-meta', `${phaseText[job.phase]} · transcurrido ${fmtTime(job.elapsed)}`));
  children.push(
    progressRow('Monte Carlo (k)', job.mc_done, job.k, job.phase === 'decomposition'),
    progressRow('Épocas', job.epoch, job.epochs, job.phase === 'training'),
  );
  const chart = document.createElement('div');
  chart.innerHTML = job.losses.length >= 2 ? lossChart(job.losses, true) : '';
  if (job.losses.length) chart.append(el('div', 'job-meta', `Pérdida: ${job.losses[job.losses.length - 1].toFixed(4)} (mejor ${Math.min(...job.losses).toFixed(4)})`));
  children.push(chart);
  const meta: string[] = [];
  if (job.graphs !== null) meta.push(`${job.graphs} modelos leídos${job.skipped ? `, ${job.skipped} omitidos por no poder leerse` : ''}`);
  if (!isRunning(job)) meta.push(`duración ${fmtTime(job.elapsed)}`);
  if (meta.length) children.push(el('div', 'job-meta', meta.join(' · ')));
  if (job.error) children.push(el('pre', 'job-error', job.error));
  if (job.log.length) {
    const details = document.createElement('details');
    details.append(el('summary', '', 'Registro'), el('pre', 'tail', job.log.slice(-40).join('\n')));
    children.push(details);
  }
  jobBox.replaceChildren(...children);
}

// ---------- models ----------

async function loadModels() {
  models = (await api.models()).models;
  renderModelViews();
}

const modelList = $<HTMLUListElement>('#model-list');

function statusBadge(model: ModelInfo): HTMLElement {
  const map: Record<ModelInfo['status'], [string, string]> = {
    done: ['listo', 'ok'],
    training: ['entrenando', ''],
    failed: ['con errores', 'bad'],
    cancelled: ['cancelado', 'warn'],
    interrupted: ['interrumpido', 'warn'],
  };
  return el('span', `badge ${map[model.status][1]}`, map[model.status][0]);
}

function renderModelViews() {
  // header select: only models that can generate
  const ready = models.filter((m) => m.ready);
  modelSelect.replaceChildren();
  for (const [label, source] of [['Preentrenados (M2)', 'pretrained'], ['Entrenados aquí', 'trained']] as const) {
    const items = ready.filter((m) => m.source === source);
    if (!items.length) continue;
    const group = document.createElement('optgroup');
    group.label = label;
    group.append(...items.map((m) => new Option(`${m.name} · ${datasetLabel(m.dataset)}`, m.id)));
    modelSelect.append(group);
  }
  if (!ready.length) modelSelect.append(new Option('— entrena un modelo —', ''));
  if (!ready.some((m) => m.id === settings.model)) settings.model = ready[0]?.id ?? null;
  modelSelect.value = settings.model ?? '';
  generateButton.disabled = busy || !settings.model;

  // list
  $('#model-count').textContent = models.length ? String(models.length) : '';
  if (!models.length) {
    modelList.replaceChildren(el('li', 'empty', 'Todavía no hay ningún modelo.'));
    return;
  }
  modelList.replaceChildren(
    ...models.map((m) => {
      const li = el('li', `model-item${m.id === settings.model ? ' selected' : ''}${m.ready ? '' : ' unusable'}`);
      const top = el('div', 'model-top');
      top.append(el('b', '', m.name), m.source === 'pretrained' ? el('span', 'badge pre', 'preentrenado') : statusBadge(m));
      if (m.source === 'trained') {
        const remove = el('button', 'ghost small', 'Borrar');
        remove.type = 'button';
        remove.disabled = m.status === 'training' && isRunning(job);
        remove.addEventListener('click', async (event) => {
          event.stopPropagation();
          if (!confirm(`¿Borrar el modelo «${m.name}»? No se puede deshacer.`)) return;
          const response = await api.deleteModel(m.id);
          if (!response.ok) alert(response.error ?? 'No se pudo borrar');
          await loadModels();
        });
        top.append(remove);
      }
      li.append(top);
      const meta: string[] = [datasetLabel(m.dataset)];
      if (m.complex) meta.push('operaciones complejas');
      if (m.source === 'trained') {
        if (m.losses.length) meta.push(`${m.losses.length} épocas · pérdida ${Math.min(...m.losses).toFixed(4)}`);
        if (m.params.k) meta.push(`k=${m.params.k}`);
        if (m.seconds) meta.push(fmtTime(m.seconds));
      } else {
        meta.push('entrenado por los autores de M2');
      }
      li.append(el('div', 'model-meta', meta.join(' · ')));
      if (m.error) li.append(el('div', 'model-meta', m.error));
      if (m.losses.length >= 2) {
        const chart = document.createElement('div');
        chart.innerHTML = lossChart(m.losses, false);
        li.append(chart);
      }
      if (m.ready) {
        li.addEventListener('click', () => {
          settings.model = m.id;
          saveSettings();
          renderModelViews();
        });
      }
      return li;
    }),
  );
}

modelSelect.addEventListener('change', () => {
  settings.model = modelSelect.value || null;
  saveSettings();
  renderModelViews();
});

// ---------- generate ----------

maxSizeInput.value = String(settings.maxSize);
maxSizeInput.addEventListener('input', () => {
  const value = Number.parseInt(maxSizeInput.value, 10);
  if (Number.isFinite(value) && value >= 2) {
    settings.maxSize = value;
    saveSettings();
  }
});

function renderSeedControls() {
  seedLock.setAttribute('aria-pressed', String(settings.seedLocked));
  seedLock.innerHTML = settings.seedLocked ? ICON_LOCKED : ICON_UNLOCKED;
  seedLock.title = settings.seedLocked
    ? 'Semilla fijada: cada Generate produce exactamente el mismo modelo. Pulsa para volver a semillas aleatorias.'
    : 'Semilla aleatoria en cada Generate (la usada se muestra aquí). Pulsa para fijarla.';
  seedInput.classList.toggle('auto', !settings.seedLocked);
  seedInput.placeholder = 'aleatoria';
  seedInput.value = settings.seed === null ? '' : String(settings.seed);
}
seedLock.addEventListener('click', () => {
  settings.seedLocked = !settings.seedLocked;
  if (settings.seedLocked && settings.seed === null) settings.seed = Math.floor(Math.random() * 1_000_000);
  saveSettings();
  renderSeedControls();
});
seedInput.addEventListener('input', () => {
  const value = Number.parseInt(seedInput.value, 10);
  settings.seed = Number.isFinite(value) ? Math.max(0, value) : null;
  settings.seedLocked = settings.seed !== null;
  saveSettings();
  seedLock.setAttribute('aria-pressed', String(settings.seedLocked));
  seedLock.innerHTML = settings.seedLocked ? ICON_LOCKED : ICON_UNLOCKED;
  seedInput.classList.toggle('auto', !settings.seedLocked);
});

async function generate() {
  if (busy || !settings.model) return;
  busy = true;
  generateButton.disabled = true;
  generateButton.dataset.busy = 'true';
  stopPlaying();
  graph.showMessage('Generando…', 'busy');
  try {
    const response = await api.generate({
      model: settings.model,
      max_size: settings.maxSize,
      seed: settings.seedLocked && settings.seed !== null ? settings.seed : undefined,
    });
    if (!response.ok) {
      graph.showMessage(`<h3>No se pudo generar</h3><pre>${escapeHtml(response.error)}</pre>`, 'error');
      return;
    }
    result = response;
    if (!settings.seedLocked) {
      settings.seed = response.seed;
      seedInput.value = String(response.seed);
    }
    highlighted = null;
    await graph.setData(response.graph, { direction: settings.direction, showImplicit: true });
    graphModel.textContent = `${response.model.name} · ${datasetLabel(response.dataset)}`;
    const s = response.graph.stats;
    graphStats.textContent = `${s.objects} objetos · ${s.edges} aristas · ${response.steps.length - 1} pasos · semilla ${response.seed} · ${response.millis} ms`;
    stepper.hidden = false;
    stepRange.max = String(response.steps.length - 1);
    setStep(response.steps.length - 1, false);
    renderResults(response);
  } catch (error) {
    graph.showMessage(`<h3>Sin conexión</h3><p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`, 'error');
  } finally {
    busy = false;
    generateButton.disabled = !settings.model;
    delete generateButton.dataset.busy;
  }
}
generateButton.addEventListener('click', () => void generate());
window.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    void generate();
  }
});

// ---------- step-by-step replay ----------

function setStep(step: number, mark = true) {
  if (!result) return;
  const last = result.steps.length - 1;
  currentStep = Math.max(0, Math.min(step, last));
  stepRange.value = String(currentStep);
  graph.showStep(mark ? currentStep : null);
  const op = result.steps[currentStep];
  stepLabel.textContent = `Paso ${currentStep}/${last} · ${op.op}`;
  markStepRow(currentStep, false);
}

function markStepRow(step: number, scroll: boolean) {
  for (const row of tabBodies.steps.querySelectorAll<HTMLElement>('tr[data-step]')) {
    const n = Number(row.dataset.step);
    row.classList.toggle('current', n === step);
    row.classList.toggle('later', n > currentStep);
    if (n === step && scroll) row.scrollIntoView({ block: 'nearest' });
  }
}

stepRange.addEventListener('input', () => {
  stopPlaying();
  setStep(Number(stepRange.value));
});

function stopPlaying() {
  window.clearInterval(playTimer);
  playTimer = 0;
  stepPlay.textContent = '▶';
  stepPlay.title = 'Reproducir la generación paso a paso';
}

stepPlay.addEventListener('click', () => {
  if (!result) return;
  if (playTimer) {
    stopPlaying();
    return;
  }
  const last = result.steps.length - 1;
  if (currentStep >= last) setStep(0);
  stepPlay.textContent = '❚❚';
  stepPlay.title = 'Pausar';
  // the whole replay lasts about 10 seconds however long the model is
  const interval = Math.max(60, Math.min(600, 10000 / Math.max(1, last)));
  playTimer = window.setInterval(() => {
    if (!result || currentStep >= result.steps.length - 1) {
      stopPlaying();
      return;
    }
    setStep(currentStep + 1);
  }, interval);
});

// ---------- results ----------

function highlightType(type: string | null, center: boolean) {
  highlighted = type;
  graph.highlightRule(type);
  if (type && center) {
    const ids = graph.nodesOfRule(type);
    if (ids.length) graph.centerOn(ids);
  }
  for (const row of document.querySelectorAll<HTMLElement>('.bar-row[data-type]')) row.classList.toggle('selected', row.dataset.type === type);
}

function kpi(label: string, value: string, kind = ''): HTMLElement {
  const box = el('div', `kpi ${kind}`);
  box.append(el('small', '', label), el('b', '', value));
  return box;
}

function bars(entries: [string, number][], clickable: boolean): HTMLElement {
  const container = el('div', 'bars');
  const top = Math.max(1, ...entries.map((e) => e[1]));
  for (const [name, count] of entries) {
    const row = el('div', 'bar-row');
    if (clickable) row.dataset.type = name;
    const label = el('span');
    if (clickable) {
      const dot = el('span', 'dot');
      dot.style.background = typeColor(name);
      label.append(dot);
    }
    label.append(name);
    const track = el('span', 'track');
    const fill = document.createElement('i');
    fill.style.width = `${(count / top) * 100}%`;
    track.append(fill);
    row.append(label, track, el('span', 'n', String(count)));
    if (clickable) row.addEventListener('click', () => highlightType(highlighted === name ? null : name, true));
    container.append(row);
  }
  return container;
}

function renderResults(r: GenerateOk) {
  // operations timeline
  const table = el('table', 'ops');
  table.innerHTML = '<thead><tr><th>#</th><th>Operación de edición</th><th class="num">+ nodos</th><th class="num">+ aristas</th></tr></thead>';
  const body = document.createElement('tbody');
  for (const step of r.steps) {
    const row = document.createElement('tr');
    row.dataset.step = String(step.index);
    row.append(el('td', 'num', String(step.index)), el('td', '', step.op), el('td', 'num', String(step.nodes.length)), el('td', 'num', String(step.edges.length)));
    row.addEventListener('click', () => {
      stopPlaying();
      setStep(step.index);
    });
    body.append(row);
  }
  table.append(body);
  tabBodies.steps.replaceChildren(table);
  markStepRow(currentStep, false);

  // summary
  const counts = new Map<string, number>();
  for (const step of r.steps.slice(1)) counts.set(step.op, (counts.get(step.op) ?? 0) + 1);
  const stopText = { size: 'tamaño máximo alcanzado', finished: 'la red decidió terminar', stuck: 'sin operaciones aplicables' }[r.stop];
  const kpis = el('div', 'kpis');
  kpis.append(
    kpi('Objetos', String(r.graph.stats.objects)),
    kpi('Aristas', String(r.graph.stats.edges)),
    kpi('Pasos', String(r.steps.length - 1)),
    kpi('Intentos fallidos', String(r.failed_attempts)),
    kpi('Parada', stopText),
    kpi('Tiempo', `${r.millis} ms`),
  );
  if (r.novel !== null) kpis.append(kpi('Novedad', r.novel ? 'distinto al entrenamiento' : 'idéntico a uno del entrenamiento', r.novel ? 'good' : 'bad'));
  const children: Node[] = [kpis];
  if (r.consistency) {
    children.push(el('h3', 'result-h', r.consistency.consistent ? 'Restricciones del dominio: se cumplen todas' : 'Restricciones del dominio: no se cumplen todas'));
    const list = el('ul', 'checklist');
    for (const check of r.consistency.checks) list.append(el('li', check.ok ? '' : 'bad', check.label));
    children.push(list);
  }
  children.push(el('h3', 'result-h', 'Operaciones aplicadas'), bars([...counts.entries()].sort((a, b) => b[1] - a[1]), false));
  children.push(el('h3', 'result-h', 'Objetos por tipo (clic para resaltar)'), bars(Object.entries(r.graph.stats.byType).sort((a, b) => b[1] - a[1]), true));
  tabBodies.summary.replaceChildren(...children);

  // xmi
  if (r.xmi) tabBodies.xmi.replaceChildren(el('pre', 'java', r.xmi));
  else tabBodies.xmi.replaceChildren(el('p', 'empty', 'No se pudo serializar este modelo a XMI.'));
  showTab(currentTab());
}

const rightTabs = [...document.querySelectorAll<HTMLButtonElement>('[data-tab]')];
const currentTab = () => rightTabs.find((t) => t.getAttribute('aria-selected') === 'true')?.dataset.tab ?? 'steps';

function showTab(name: string) {
  for (const tab of rightTabs) tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
  for (const [key, body] of Object.entries(tabBodies)) body.hidden = key !== name;
  downloadButton.hidden = name !== 'xmi' || !result?.xmi;
}
for (const tab of rightTabs) tab.addEventListener('click', () => showTab(tab.dataset.tab!));

function clearResults() {
  tabBodies.steps.replaceChildren(el('p', 'empty', 'Aquí verás, paso a paso, qué operaciones de edición fue aplicando la red para construir el modelo.'));
  tabBodies.summary.replaceChildren(el('p', 'empty', 'Aquí verás el resumen del modelo generado y si cumple las restricciones del dominio.'));
  tabBodies.xmi.replaceChildren(el('p', 'empty', 'Aquí verás el modelo serializado en XMI.'));
}

downloadButton.addEventListener('click', () => {
  if (!result?.xmi) return;
  const blob = new Blob([result.xmi], { type: 'application/xml' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${result.model.id.replace(/[^a-z0-9_-]+/gi, '_')}-seed${result.seed}.xmi`;
  link.click();
  URL.revokeObjectURL(link.href);
});

// ---------- graph controls ----------

const directionButtons = [...document.querySelectorAll<HTMLButtonElement>('.seg button')];
function renderDirection() {
  for (const button of directionButtons) button.setAttribute('aria-pressed', String(button.dataset.dir === settings.direction));
}
for (const button of directionButtons) {
  button.addEventListener('click', () => {
    settings.direction = button.dataset.dir as Direction;
    saveSettings();
    renderDirection();
    void graph.setOptions({ direction: settings.direction }).then(() => result && setStep(currentStep, currentStep < result.steps.length - 1));
  });
}
renderDirection();
$('#fit').addEventListener('click', () => graph.fit());

// ---------- splitters ----------

function bindSplitter(handle: HTMLElement, axis: 'x' | 'y', property: string, key: string, limits: [number, number]) {
  const saved = stored<number | null>(key, null);
  if (saved !== null) document.documentElement.style.setProperty(property, `${saved}px`);
  handle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    const parent = handle.parentElement!.getBoundingClientRect();
    const onMove = (move: PointerEvent) => {
      const raw = axis === 'x' ? move.clientX - parent.left : parent.bottom - move.clientY;
      const size = Math.round(Math.min(Math.max(raw, limits[0]), (axis === 'x' ? parent.width : parent.height) - limits[1]));
      document.documentElement.style.setProperty(property, `${size}px`);
      store(key, size);
    };
    const onUp = () => {
      handle.releasePointerCapture(event.pointerId);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  });
}
bindSplitter($('#split-v'), 'x', '--left', 'm2.left', [340, 380]);
bindSplitter($('#split-h'), 'y', '--rules-h', 'm2.rules', [140, 200]);

// ---------- go ----------

renderSeedControls();
clearResults();
generateButton.disabled = true;
void pollHealth();
