import './style.css';
import { api, ApiError, type Attempt, type Category, type Example, type GeneratePayload, type Issue, type Job, type Prompt, type Setup } from './api';
import { CodeView, createOclEditor, highlightPython } from './code';
import { GraphView, type Direction } from './graph';

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

/** Text with `code` spans rendered as code. */
function inline(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  text.replace(/```(\w*)/g, '`$1`').split('`').forEach((part, index) => {
    if (!part) return;
    fragment.append(index % 2 ? el('code', 'inline', part) : document.createTextNode(part));
  });
  return fragment;
}

const CATEGORY_LABEL: Record<Category, string> = {
  syntax: 'SINTAXIS',
  import: 'IMPORT',
  forbidden: 'PROHIBIDO',
  contract: 'CONTRATO',
  runtime: 'EJECUCIÓN',
  timeout: 'TIEMPO',
  structure: 'ESTRUCTURA',
  constraint: 'REGLA',
  scope: 'SCOPE',
};
const LABEL_CATEGORY = Object.fromEntries(Object.entries(CATEGORY_LABEL).map(([category, label]) => [label, category])) as Record<string, Category>;

const GROUPS: [string, Category[]][] = [
  ['Fallos del código', ['syntax', 'import', 'forbidden', 'contract', 'runtime', 'timeout']],
  ['Estructura de los objetos', ['structure']],
  ['Reglas de validez', ['constraint']],
  ['Scope', ['scope']],
];
const CODE_CATEGORIES: Category[] = ['syntax', 'import', 'forbidden', 'runtime'];

// ---------- settings ----------

interface ScopeForm {
  root: string;
  bounds: Record<string, { min?: number; max?: number }>;
  totalMin: number | null;
  totalMax: number | null;
}

interface Settings {
  model: string;
  iterations: number;
  direction: Direction;
  scopes: Record<string, ScopeForm>;
  jobId: string | null;
}

const settings: Settings = { model: '', iterations: 5, direction: 'RIGHT', scopes: {}, jobId: null, ...stored<Partial<Settings>>('llmgen.settings', {}) };
const saveSettings = () => store('llmgen.settings', settings);

// ---------- elements and views ----------

const modelInput = $<HTMLInputElement>('#llm-model');
const iterationsInput = $<HTMLInputElement>('#llm-iterations');
const generateButton = $<HTMLButtonElement>('#generate');
const cancelButton = $<HTMLButtonElement>('#cancel');
const statusPill = $<HTMLSpanElement>('#backend-status');
const exampleSelect = $<HTMLSelectElement>('#example');
const ecoreFile = $<HTMLInputElement>('#ecore-file');
const mmInfo = $<HTMLParagraphElement>('#mm-info');
const oclStatus = $<HTMLParagraphElement>('#ocl-status');
const rootSelect = $<HTMLSelectElement>('#root-class');
const scopeBody = $<HTMLTableSectionElement>('#scope-body');
const totalMin = $<HTMLInputElement>('#total-min');
const totalMax = $<HTMLInputElement>('#total-max');
const formError = $<HTMLParagraphElement>('#form-error');
const attemptsBar = $<HTMLDivElement>('#attempts-bar');
const attemptsBox = $<HTMLDivElement>('#attempts');
const jobStatus = $<HTMLSpanElement>('#job-status');
const graphStats = $<HTMLSpanElement>('#graph-stats');
const nodeInfo = $<HTMLSpanElement>('#node-info');
const exportLink = $<HTMLAnchorElement>('#export');
const problemCount = $<HTMLSpanElement>('#problem-count');

const tabBodies: Record<string, HTMLElement> = {
  problems: $('#tab-problems'),
  prompt: $('#tab-prompt'),
  feedback: $('#tab-feedback'),
  script: $('#tab-script'),
  module: $('#tab-module'),
  scope: $('#tab-scope'),
  xmi: $('#tab-xmi'),
};
const codeViews = {
  script: new CodeView(tabBodies.script, 'python'),
  module: new CodeView(tabBodies.module, 'python'),
  xmi: new CodeView(tabBodies.xmi, 'xml'),
};

const graph = new GraphView($('#graph'), {
  onSelect(nodeId) {
    graph.select(nodeId);
    const node = nodeId ? currentAttempt()?.graph?.nodes.find((n) => n.id === nodeId) : undefined;
    if (!node) {
      nodeInfo.textContent = '';
      return;
    }
    nodeInfo.textContent = `${node.type}${node.name ? ' · ' + node.name : ''}${node.line ? ` — línea ${node.line}` : ''}${node.problems?.length ? ` — ${node.problems.length} problema(s)` : ''}`;
    if (node.line) codeViews.script.focusLine(node.line);
  },
});
graph.showMessage('Carga un metamodelo, define el scope y pulsa <b>Generate</b>.', 'empty');

// ---------- state ----------

let setup: Setup | null = null;
let job: Job | null = null;
let selected: number | null = null;
let pinned = false;
let drawnKey: string | null = null;
let xmiKey: string | null = null;
let saveToken = 0;
let saveTimer = 0;
let pollTimer = 0;
let examples: Example[] = [];

const currentAttempt = (): Attempt | undefined => job?.attempts.find((a) => a.n === selected);

// ---------- backend status ----------

async function pollHealth() {
  try {
    const status = await api.setup();
    setup = status;
    const key = status.canGenerate;
    statusPill.dataset.state = key ? 'ready' : 'warming';
    statusPill.textContent = key ? 'Backend listo · clave de OpenAI' : 'Backend listo · falta OPENAI_API_KEY';
    statusPill.title = key ? '' : 'Define la variable de entorno OPENAI_API_KEY en el servidor';
  } catch {
    statusPill.dataset.state = 'down';
    statusPill.textContent = 'Backend sin conexión';
  }
  updateGenerateButton();
  window.setTimeout(pollHealth, 8000);
}

function updateGenerateButton() {
  const running = job?.status === 'running';
  generateButton.disabled = running || !setup?.canGenerate || !setup?.metamodelLoaded;
  generateButton.title = !setup?.canGenerate ? 'Falta la variable de entorno OPENAI_API_KEY en el servidor' : !setup?.metamodelLoaded ? 'Carga primero un metamodelo' : 'Generar un modelo (Ctrl+Enter)';
  cancelButton.hidden = !running;
}

// ---------- metamodel and constraints ----------

const oclEditor = createOclEditor($('#ocl-editor'), '', () => {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void saveConstraints(), 700);
});

async function saveConstraints(): Promise<boolean> {
  window.clearTimeout(saveTimer);
  const token = ++saveToken;
  if (!setup?.metamodelLoaded) {
    setOclStatus('Carga un metamodelo para que se puedan comprobar las restricciones.', 'warn');
    return true;
  }
  try {
    const result = await api.setConstraints(oclEditor.text());
    if (token !== saveToken) return true;
    const count = result.constraints.length;
    setOclStatus(
      (count ? `${count} restricción(es) válidas.` : 'Sin restricciones.') + (result.warnings.length ? ' ' + result.warnings.join(' ') : ''),
      result.warnings.length ? 'warn' : 'ok',
    );
    await refreshSetup();
    return true;
  } catch (error) {
    if (token === saveToken) setOclStatus(error instanceof Error ? error.message : String(error), 'bad');
    return false;
  }
}

function setOclStatus(text: string, kind: 'ok' | 'bad' | 'warn') {
  oclStatus.textContent = text;
  oclStatus.className = `hint-text ${kind}`;
}

async function loadMetamodel(file: File, ocl?: string) {
  try {
    await api.uploadMetamodel(file);
  } catch (error) {
    mmInfo.textContent = error instanceof Error ? error.message : String(error);
    mmInfo.className = 'hint-text bad';
    return;
  }
  if (ocl !== undefined) oclEditor.setText(ocl);
  await refreshSetup(true);
  await saveConstraints();
  job = null;
  selected = null;
  pinned = false;
  renderJob();
}

exampleSelect.addEventListener('change', async () => {
  const example = examples.find((e) => e.id === exampleSelect.value);
  exampleSelect.value = '';
  if (example) await loadMetamodel(new File([example.ecore], example.filename), example.ocl);
});

ecoreFile.addEventListener('change', async () => {
  const file = ecoreFile.files?.[0];
  ecoreFile.value = '';
  if (file) await loadMetamodel(file);
});

async function refreshSetup(force = false) {
  try {
    setup = await api.setup();
  } catch {
    return;
  }
  const suggestions = $<HTMLDataListElement>('#llm-model-list');
  suggestions.replaceChildren(...setup.modelSuggestions.map((name) => new Option(name, name)));
  if (!modelInput.value) modelInput.value = settings.model || setup.defaultModel;

  if (!setup.metamodelLoaded) {
    mmInfo.textContent = 'Aún no hay ningún metamodelo.';
    mmInfo.className = 'hint-text';
  } else {
    mmInfo.textContent = `${setup.metamodelFilename} · ${setup.classes?.length} clases · ${setup.constraintCount ?? 0} restricciones`;
    mmInfo.className = 'hint-text ok';
    renderScopeForm(force);
    codeViews.module.setText(setup.moduleCode ?? '');
    if (setup.interpreterOnly?.length) {
      setOclStatus(`No se pueden traducir a Pydantic y solo se comprueban al terminar: ${setup.interpreterOnly.join(', ')}.`, 'warn');
    }
  }
  updateGenerateButton();
  schedulePreview();
}

// ---------- scope form ----------

let scopeFor: string | null = null;

function scopeKey(): string {
  return setup?.metamodelFilename ?? '';
}

function readScope(): ScopeForm {
  const bounds: ScopeForm['bounds'] = {};
  for (const input of scopeBody.querySelectorAll<HTMLInputElement>('input[data-class]')) {
    if (input.value === '') continue;
    (bounds[input.dataset.class!] ??= {})[input.dataset.bound as 'min' | 'max'] = Number(input.value);
  }
  return { root: rootSelect.value, bounds, totalMin: totalMin.value === '' ? null : Number(totalMin.value), totalMax: totalMax.value === '' ? null : Number(totalMax.value) };
}

function persistScope() {
  if (!scopeKey()) return;
  settings.scopes[scopeKey()] = readScope();
  saveSettings();
  schedulePreview();
}

function renderScopeForm(force: boolean) {
  const classes = setup?.classes ?? [];
  const key = scopeKey();
  if (!force && scopeFor === key && rootSelect.options.length) return;
  scopeFor = key;
  const previous = settings.scopes[key];
  const candidates = setup?.rootCandidates ?? [];
  const concrete = classes.filter((c) => !c.abstract).map((c) => c.name);
  const ordered = [...candidates, ...concrete.filter((name) => !candidates.includes(name))];
  rootSelect.replaceChildren(...ordered.map((name) => new Option(candidates.includes(name) ? `${name} (raíz natural)` : name, name)));
  rootSelect.value = previous && ordered.includes(previous.root) ? previous.root : ordered[0] ?? '';

  scopeBody.replaceChildren(
    ...classes.map((c) => {
      const row = document.createElement('tr');
      row.append(el('td', c.abstract ? 'abstract' : '', c.abstract ? `${c.name} (abstracta)` : c.name));
      for (const bound of ['min', 'max'] as const) {
        const input = document.createElement('input');
        input.type = 'number';
        input.min = '0';
        input.dataset.class = c.name;
        input.dataset.bound = bound;
        const value = previous?.bounds[c.name]?.[bound];
        if (value !== undefined) input.value = String(value);
        input.addEventListener('input', persistScope);
        const cell = document.createElement('td');
        cell.append(input);
        row.append(cell);
      }
      return row;
    }),
  );
  totalMin.value = previous?.totalMin != null ? String(previous.totalMin) : '';
  totalMax.value = previous?.totalMax != null ? String(previous.totalMax) : '';
}
for (const input of [rootSelect, totalMin, totalMax]) input.addEventListener('input', persistScope);

// ---------- generate ----------

modelInput.addEventListener('input', () => ((settings.model = modelInput.value), saveSettings()));
iterationsInput.value = String(settings.iterations);
iterationsInput.addEventListener('input', () => {
  const value = Number.parseInt(iterationsInput.value, 10);
  if (Number.isFinite(value)) {
    settings.iterations = Math.max(1, Math.min(10, value));
    saveSettings();
  }
});

function showFormError(message: string | null) {
  formError.textContent = message ?? '';
  formError.hidden = !message;
}

function buildPayload(): GeneratePayload {
  const scope = readScope();
  return {
    rootClass: scope.root,
    classBounds: scope.bounds,
    totalMin: scope.totalMin,
    totalMax: scope.totalMax,
    model: modelInput.value.trim() || null,
    maxIterations: settings.iterations,
  };
}

async function generate() {
  if (generateButton.disabled) return;
  showFormError(null);
  if (!(await saveConstraints())) {
    showFormError('Las restricciones OCL tienen un error de sintaxis: corrígelo antes de generar.');
    return;
  }
  const payload = buildPayload();
  try {
    const { jobId } = await api.generate(payload);
    settings.jobId = jobId;
    saveSettings();
  } catch (error) {
    showFormError(error instanceof ApiError ? error.message : String(error));
    return;
  }
  job = null;
  selected = null;
  pinned = false;
  drawnKey = null;
  xmiKey = null;
  graph.clear();
  graph.showMessage('Esperando al LLM…', 'busy');
  void poll();
}

generateButton.addEventListener('click', () => void generate());
cancelButton.addEventListener('click', async () => {
  if (settings.jobId) await api.cancel(settings.jobId);
});
window.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    void generate();
  }
});

async function poll() {
  window.clearTimeout(pollTimer);
  if (!settings.jobId) return;
  try {
    job = await api.job(settings.jobId);
  } catch (error) {
    if (error instanceof ApiError && !/contactar/.test(error.message)) {
      // the server no longer knows this job (it was restarted)
      settings.jobId = null;
      saveSettings();
      job = null;
      renderJob();
      return;
    }
  }
  renderJob();
  if (!job || job.status === 'running') pollTimer = window.setTimeout(poll, 1000);
}

// ---------- job and attempts ----------

function renderJob() {
  updateGenerateButton();
  attemptsBar.hidden = !job;
  if (!job) {
    attemptsBox.replaceChildren();
    clearDetail();
    return;
  }
  const tokens = job.usage.input_tokens + job.usage.output_tokens;
  jobStatus.textContent = `${job.phase} · ${Math.round(job.seconds)} s · ${job.model}${tokens ? ` · ${tokens} tokens` : ''}`;
  jobStatus.className = `job-status${job.error ? ' bad' : ''}`;
  if (job.error) jobStatus.textContent = job.error;

  if (!pinned && job.attempts.length) selected = job.attempts[job.attempts.length - 1].n;
  attemptsBox.replaceChildren(
    ...job.attempts.map((attempt) => {
      const state = attempt.status === 'ok' ? 'ok' : attempt.status === 'failed' ? 'failed' : 'busy';
      const icon = attempt.status === 'ok' ? '✓ ' : attempt.status === 'failed' ? '✗ ' : '';
      const chip = el('button', `attempt-chip ${state}${attempt.n === selected ? ' selected' : ''}`, `${icon}Intento ${attempt.n}`);
      chip.type = 'button';
      chip.addEventListener('click', () => {
        selected = attempt.n;
        pinned = true;
        renderJob();
      });
      return chip;
    }),
  );
  const attempt = currentAttempt();
  if (attempt) renderAttempt(attempt);
  else {
    renderPrompt(null);
    if (job.error) graph.showMessage(`<h3>No se pudo generar</h3><pre>${escapeHtml(job.error)}</pre>`, 'error');
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function clearDetail() {
  graph.clear();
  graph.showMessage('Carga un metamodelo, define el scope y pulsa <b>Generate</b>.', 'empty');
  graphStats.textContent = '';
  nodeInfo.textContent = '';
  problemCount.textContent = '';
  exportLink.hidden = true;
  const placeholders: Record<string, string> = {
    problems: 'Aquí verás qué regla, qué objeto y qué línea falló en cada intento.',
    feedback: 'Aquí verás el mensaje que se le devuelve al LLM tras cada intento fallido.',
    scope: 'Aquí verás si el modelo respeta el scope pedido.',
  };
  for (const [tab, text] of Object.entries(placeholders)) tabBodies[tab].replaceChildren(el('p', 'empty', text));
  codeViews.script.setText('');
  codeViews.script.setIssueLines([]);
  codeViews.xmi.setText('');
  xmiKey = null;
  drawnKey = null;
  schedulePreview();
}

function renderAttempt(attempt: Attempt) {
  // graph: redrawn only when the attempt or its result changes
  const key = `${settings.jobId}:${attempt.n}:${attempt.status}`;
  if (key !== drawnKey) {
    drawnKey = key;
    if (attempt.graph) {
      void graph.setData(attempt.graph, { direction: settings.direction, showImplicit: true });
      graphStats.textContent = `${attempt.graph.stats.objects} objetos · ${attempt.graph.stats.edges} aristas`;
    } else {
      graph.clear();
      const text =
        attempt.status === 'generating' ? 'Esperando al LLM…' : attempt.status === 'validating' ? 'Validando el script…' : 'Este intento no llegó a producir un modelo: mira «Problemas».';
      graph.showMessage(text, attempt.status === 'failed' ? 'empty' : 'busy');
      graphStats.textContent = '';
    }
    nodeInfo.textContent = '';
  }

  const issues = attempt.issues ?? [];
  problemCount.textContent = attempt.status === 'ok' ? '' : issues.length ? String(issues.length) : '';
  problemCount.classList.toggle('bad', issues.length > 0);
  exportLink.hidden = !attempt.hasXmi;
  if (attempt.hasXmi && settings.jobId) {
    exportLink.href = api.xmiUrl(settings.jobId, attempt.n);
    exportLink.download = `model-${attempt.n}.xmi`;
  }

  renderProblems(attempt, issues);
  renderPrompt(attempt);
  renderFeedback(attempt);
  renderScopeTab(attempt);
  codeViews.script.setText(attempt.code ?? (attempt.raw ? `# El LLM no devolvió un bloque de código. Respuesta:\n# ${attempt.raw.split('\n').join('\n# ')}` : ''));
  codeViews.script.setIssueLines(issues.map((i) => i.line).filter((n): n is number => typeof n === 'number'));
  codeViews.module.setIssueLines(issues.map((i) => i.moduleLine).filter((n): n is number => typeof n === 'number'));
  void loadXmi(attempt);
}

async function loadXmi(attempt: Attempt) {
  if (!attempt.hasXmi || !settings.jobId) {
    codeViews.xmi.setText('');
    xmiKey = null;
    return;
  }
  const key = `${settings.jobId}:${attempt.n}`;
  if (key === xmiKey) return;
  xmiKey = key;
  try {
    codeViews.xmi.setText(await api.xmi(settings.jobId, attempt.n));
  } catch {
    xmiKey = null;
  }
}

// ---------- detail tabs ----------

function renderProblems(attempt: Attempt, issues: Issue[]) {
  const box = tabBodies.problems;
  if (attempt.status === 'generating' || attempt.status === 'validating') {
    box.replaceChildren(el('p', 'empty', attempt.status === 'generating' ? 'Esperando al LLM…' : 'Validando el script…'));
    return;
  }
  if (!issues.length) {
    box.replaceChildren(el('p', 'all-good', '✓ Sin problemas: el modelo es válido y cumple el scope.'));
    return;
  }
  const parts: HTMLElement[] = [];
  for (const [title, categories] of GROUPS) {
    const items = issues.filter((i) => categories.includes(i.category));
    if (!items.length) continue;
    const group = el('div', 'issue-group');
    group.append(el('h4', '', `${title} (${items.length})`));
    const list = el('ul', 'issue-list');
    for (const issue of items) {
      const row = el('li', 'issue');
      row.append(el('span', `cat ${issue.category}`, CATEGORY_LABEL[issue.category]));
      const body = el('div');
      body.append(inline(issue.message));
      if (issue.line && CODE_CATEGORIES.includes(issue.category)) {
        body.append(document.createTextNode(` — línea ${issue.line}`));
        if (issue.code) body.append(document.createTextNode(': '), el('code', 'inline', issue.code));
      }
      row.append(body);
      const links = el('div', 'links');
      if (issue.line) links.append(linkButton(`Ver en el script (línea ${issue.line})`, () => jumpTo('script', issue.line!)));
      if (issue.moduleLine) links.append(linkButton(`Ver la regla en el código Pydantic (línea ${issue.moduleLine})`, () => jumpTo('module', issue.moduleLine!)));
      if (links.childElementCount) row.append(links);
      list.append(row);
    }
    group.append(list);
    parts.push(group);
  }
  if (attempt.stdout) {
    const out = el('div', 'issue-group');
    out.append(el('h4', '', 'Salida del script'), el('pre', 'plain', attempt.stdout));
    parts.push(out);
  }
  box.replaceChildren(...parts);
}

function linkButton(text: string, onClick: () => void): HTMLButtonElement {
  const button = el('button', '', text);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

function jumpTo(tab: 'script' | 'module', line: number) {
  showTab(tab);
  window.setTimeout(() => codeViews[tab].focusLine(line), 30);
}

// ---------- prompt: the messages the LLM receives ----------

type Role = 'system' | 'user' | 'assistant';
const ROLE_LABEL: Record<Role, string> = { system: 'SISTEMA', user: 'USUARIO', assistant: 'ASISTENTE' };
const FENCE = /```(\w*)\n([\s\S]*?)```/g;

/** A message's text: prose as it is, and ```code``` blocks highlighted (Python) and collapsible. */
function messageBody(text: string): HTMLElement {
  const body = el('div', 'msg-body');
  let last = 0;
  const prose = (chunk: string) => {
    if (chunk.trim()) body.append(el('p', 'prose', chunk.trim()));
  };
  for (const match of text.matchAll(FENCE)) {
    prose(text.slice(last, match.index));
    last = match.index! + match[0].length;
    const code = match[2].replace(/\n$/, '');
    const details = el('details');
    details.open = true;
    details.append(el('summary', '', `${match[1] || 'código'} · ${code.split('\n').length} líneas`));
    const pre = el('pre', 'code-block');
    if (match[1] === 'python' || match[1] === 'py') pre.append(highlightPython(code));
    else pre.textContent = code;
    details.append(pre);
    body.append(details);
  }
  prose(text.slice(last));
  return body;
}

function messageBlock(role: Role, title: string, text: string): HTMLElement {
  const block = el('section', 'msg');
  const head = el('div', 'msg-head');
  head.append(el('span', `role ${role}`, ROLE_LABEL[role]), el('span', '', title));
  block.append(head, messageBody(text));
  return block;
}

function promptView(note: string, messages: [Role, string, string][]): HTMLElement {
  const box = el('div', 'prompt');
  box.append(el('p', 'note', note), ...messages.map(([role, title, text]) => messageBlock(role, title, text)));
  return box;
}

/** What the LLM was sent in this attempt: system prompt, user prompt and, after failures, the earlier answers and feedback. */
function renderPrompt(attempt: Attempt | null) {
  if (!job) return; // no job yet: the preview (schedulePreview) fills the tab
  const prompt = job.prompt;
  if (!prompt) {
    // a backend from before the prompts were exposed: say so instead of breaking the rest of the panel
    tabBodies.prompt.replaceChildren(el('p', 'empty', 'El backend no envía el prompt: es una versión anterior. Reconstruye los contenedores con «docker compose up --build» (o reinicia uvicorn).'));
    return;
  }
  const messages: [Role, string, string][] = [
    ['system', 'prompt de sistema', prompt.system],
    ['user', 'prompt de usuario · el módulo y el scope', prompt.task],
  ];
  let note = 'Mensajes que se envían al LLM en el primer intento.';
  if (attempt) {
    note = `Mensajes enviados al LLM en el intento ${attempt.n}`;
    const context = attempt.context ?? [];
    note += context.length ? `, con las respuestas y el feedback de ${context.length === 1 ? 'un intento anterior' : `${context.length} intentos anteriores`}.` : '.';
    for (const n of context) {
      const earlier = job.attempts.find((a) => a.n === n);
      if (!earlier) continue;
      messages.push(['assistant', `respuesta del intento ${n}`, earlier.raw ?? earlier.code ?? '']);
      messages.push(['user', `feedback tras el intento ${n}`, earlier.feedback ?? '']);
    }
  }
  tabBodies.prompt.replaceChildren(promptView(note, messages));
}

let previewTimer = 0;
let previewKey = '';

/** Before generating: the first messages with the scope currently in the form (no LLM call). */
function schedulePreview() {
  window.clearTimeout(previewTimer);
  if (job || activeTab !== 'prompt') return;
  previewTimer = window.setTimeout(async () => {
    if (job) return;
    if (!setup?.metamodelLoaded || !rootSelect.value) {
      previewKey = '';
      tabBodies.prompt.replaceChildren(el('p', 'empty', 'Carga un metamodelo y define el scope para ver los mensajes que recibirá el LLM.'));
      return;
    }
    const payload = buildPayload();
    const key = JSON.stringify([payload.rootClass, payload.classBounds, payload.totalMin, payload.totalMax, setup.moduleCode]);
    if (key === previewKey) return;
    let prompt: Prompt;
    try {
      prompt = await api.prompt(payload);
    } catch (error) {
      previewKey = '';
      tabBodies.prompt.replaceChildren(el('p', 'empty', error instanceof ApiError ? error.message : 'No se pudo calcular el prompt.'));
      return;
    }
    if (job) return;
    previewKey = key;
    tabBodies.prompt.replaceChildren(
      promptView('Así será el primer mensaje con el scope actual. Todavía no se ha llamado al LLM.', [
        ['system', 'prompt de sistema', prompt.system],
        ['user', 'prompt de usuario · el módulo y el scope', prompt.task],
      ]),
    );
  }, 250);
}

/** The feedback that goes back to the LLM, lightly formatted: sections, tagged items and `code`. */
function renderFeedback(attempt: Attempt) {
  const box = tabBodies.feedback;
  const text = attempt.feedback;
  if (!text) {
    box.replaceChildren(el('p', 'empty', attempt.status === 'ok' ? 'El intento es válido: no hace falta feedback.' : attempt.status === 'failed' ? 'Este fue el último intento: no se envió feedback.' : 'Todavía no hay feedback para este intento.'));
    return;
  }
  const container = el('div', 'feedback');
  container.append(el('p', 'caption-inline', 'Mensaje que se le devolvió al LLM tras este intento:'));
  let list: HTMLUListElement | null = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      list = null;
      continue;
    }
    if (line.startsWith('## ')) {
      list = null;
      const heading = el('h4');
      heading.append(inline(line.slice(3)));
      container.append(heading);
    } else if (line.startsWith('- ')) {
      list ??= container.appendChild(el('ul'));
      const item = el('li');
      const tagged = /^- \[([A-ZÁÉÍÓÚ]+)\] (.*)$/.exec(line);
      const message = el('span');
      if (tagged && LABEL_CATEGORY[tagged[1]]) {
        message.append(inline(tagged[2]));
        item.append(el('span', `cat ${LABEL_CATEGORY[tagged[1]]}`, tagged[1]), message);
      } else {
        message.append(inline(line.slice(2)));
        item.append(message);
      }
      list.append(item);
    } else {
      list = null;
      const paragraph = el('p', line.startsWith('El intento') ? 'intro' : '');
      paragraph.append(inline(line));
      container.append(paragraph);
    }
  }
  box.replaceChildren(container);
}

function renderScopeTab(attempt: Attempt) {
  const box = tabBodies.scope;
  const rows = attempt.scope ?? [];
  if (!rows.length) {
    box.replaceChildren(el('p', 'empty', attempt.graph ? 'No se pidió ningún límite: el scope es libre.' : 'El script no llegó a ejecutarse: no se puede comprobar el scope.'));
    return;
  }
  const table = el('table', 'result');
  table.innerHTML = '<thead><tr><th>Clase</th><th>Pedido</th><th>Obtenido</th><th></th></tr></thead>';
  const body = document.createElement('tbody');
  for (const row of rows) {
    const asked = row.min !== null && row.max !== null ? (row.min === row.max ? `${row.min}` : `${row.min}–${row.max}`) : row.min !== null ? `≥ ${row.min}` : `≤ ${row.max}`;
    const tr = document.createElement('tr');
    tr.append(el('td', '', row.class), el('td', '', asked), el('td', '', String(row.actual)), el('td', row.ok ? 'yes' : 'no', row.ok ? '✓' : '✗'));
    body.append(tr);
  }
  table.append(body);
  box.replaceChildren(table);
}

const tabs = [...document.querySelectorAll<HTMLButtonElement>('[data-tab]')];
let activeTab = 'problems';
function showTab(name: string) {
  activeTab = name;
  for (const tab of tabs) tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
  for (const [key, body] of Object.entries(tabBodies)) body.hidden = key !== name;
  if (name in codeViews) codeViews[name as keyof typeof codeViews].refresh();
  if (name === 'prompt') schedulePreview();
}
for (const tab of tabs) tab.addEventListener('click', () => showTab(tab.dataset.tab!));

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
    void graph.setOptions({ direction: settings.direction });
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
bindSplitter($('#split-v'), 'x', '--left', 'llmgen.left', [340, 420]);
bindSplitter($('#split-h'), 'y', '--rules-h', 'llmgen.rules', [160, 200]);

// ---------- go ----------

async function boot() {
  clearDetail();
  try {
    examples = await api.examples();
    exampleSelect.replaceChildren(new Option('— cargar un ejemplo —', ''), ...examples.map((e) => new Option(e.title, e.id)));
  } catch {
    /* the status pill shows when the backend is unreachable */
  }
  try {
    const status = await api.status();
    if (status.constraints.text) oclEditor.setText(status.constraints.text);
  } catch {
    /* idem */
  }
  await refreshSetup(true);
  if (setup?.metamodelLoaded && oclEditor.text()) setOclStatus(`${setup.constraintCount ?? 0} restricción(es) cargadas.`, 'ok');
  if (settings.jobId) void poll();
}

void pollHealth();
void boot();
