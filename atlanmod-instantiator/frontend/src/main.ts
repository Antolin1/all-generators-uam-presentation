import './style.css';
import { api, type GenerateOk, type GenerateRequest, type MetamodelInfo } from './api';
import { GraphView, typeColor, type Direction } from './graph';

// ---------- small helpers ----------

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

function text<K extends keyof HTMLElementTagNameMap>(tag: K, content: string, className?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.textContent = content;
  if (className) element.className = className;
  return element;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

const ICON_LOCKED =
  '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M8 1a3.5 3.5 0 0 0-3.5 3.5V6H4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1h-.5V4.5A3.5 3.5 0 0 0 8 1Zm-2 3.5a2 2 0 1 1 4 0V6H6V4.5Z"/></svg>';
const ICON_UNLOCKED =
  '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M8 1a3.5 3.5 0 0 0-3.5 3.5V6H4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1H6V4.5a2 2 0 0 1 3.9-.6.75.75 0 1 0 1.44-.4A3.5 3.5 0 0 0 8 1Z"/></svg>';

// ---------- settings ----------

interface Settings {
  metamodel: string | null;
  seed: number | null;
  seedLocked: boolean;
  size: number;
  degree: number;
  /** +/- tolerance around size and degree, as a percentage (10 = ±10 %). */
  sizeVariation: number;
  degreeVariation: number;
  direction: Direction;
}

const settings: Settings = {
  metamodel: null,
  seed: null,
  seedLocked: false,
  size: 20,
  degree: 2,
  sizeVariation: 10,
  degreeVariation: 10,
  direction: 'RIGHT',
  ...stored<Partial<Settings>>('inst.settings', {}),
};
const saveSettings = () => store('inst.settings', settings);

// ---------- elements ----------

const metamodelSelect = $<HTMLSelectElement>('#metamodel');
const seedInput = $<HTMLInputElement>('#seed');
const seedLock = $<HTMLButtonElement>('#seed-lock');
const generateButton = $<HTMLButtonElement>('#generate');
const statusPill = $<HTMLSpanElement>('#backend-status');
const mmInfo = $<HTMLSpanElement>('#mm-info');
const mmProblems = $<HTMLDivElement>('#mm-problems');
const classesBody = $<HTMLTableSectionElement>('#classes tbody');
const classCount = $<HTMLSpanElement>('#class-count');
const graphStats = $<HTMLSpanElement>('#graph-stats');
const downloadButton = $<HTMLButtonElement>('#download');
const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role=tab]')];
const tabBodies: Record<string, HTMLElement> = { summary: $('#tab-summary'), ocl: $('#tab-ocl'), log: $('#tab-log'), xmi: $('#tab-xmi') };
const oclCount = $<HTMLSpanElement>('#ocl-count');

const numericInputs: { input: HTMLInputElement; key: 'size' | 'degree' | 'sizeVariation' | 'degreeVariation' }[] = [
  { input: $('#p-size'), key: 'size' },
  { input: $('#p-degree'), key: 'degree' },
  { input: $('#p-size-tol'), key: 'sizeVariation' },
  { input: $('#p-degree-tol'), key: 'degreeVariation' },
];

const graph = new GraphView($('#graph'), {
  onSelect(nodeId) {
    graph.select(nodeId);
    const node = nodeId && result?.graph ? result.graph.nodes.find((n) => n.id === nodeId) : undefined;
    highlightClass(node?.type ?? null, false);
  },
});
graph.showMessage('Elige un metamodelo y pulsa <b>Generate</b> para crear un modelo aleatorio.', 'empty');

// ---------- state ----------

interface ClassState {
  use: boolean;
  root: boolean;
}

let infos: MetamodelInfo[] = [];
let infosSignature = '';
let current: MetamodelInfo | null = null;
let classState = new Map<string, ClassState>();
let result: GenerateOk | null = null;
let busy = false;
let highlighted: string | null = null;

// ---------- metamodels ----------

function renderMetamodelSelect() {
  metamodelSelect.replaceChildren(
    ...infos.map((info) => new Option(info.status === 'ok' ? info.file : `${info.file}  (${info.status === 'invalid' ? 'con errores' : 'error'})`, info.file)),
  );
  if (!infos.length) metamodelSelect.append(new Option('— no hay .ecore en la carpeta metamodels/ —', ''));
  if (current) metamodelSelect.value = current.file;
}

function selectMetamodel(file: string | null, keepState = false) {
  current = infos.find((i) => i.file === file) ?? infos[0] ?? null;
  settings.metamodel = current?.file ?? null;
  saveSettings();
  if (current) metamodelSelect.value = current.file;

  const previous = classState;
  classState = new Map();
  for (const c of current?.classes ?? []) {
    const old = keepState ? previous.get(c.id) : undefined;
    classState.set(c.id, old ?? { use: true, root: c.rootCandidate });
  }
  renderClasses();
  renderMetamodelHeader();
  renderOclTab();
}

function renderMetamodelHeader() {
  mmProblems.hidden = true;
  mmProblems.classList.remove('warn');
  if (!current) {
    mmInfo.textContent = '';
    return;
  }
  mmInfo.textContent = current.packages.map((p) => `${p.name} · ${p.nsURI}`).join('  ');
  mmInfo.title = mmInfo.textContent;
  const messages = [...current.errors];
  if (messages.length) {
    mmProblems.hidden = false;
    mmProblems.textContent =
      (current.status === 'error' ? 'No se pudo leer el metamodelo:\n' : 'El metamodelo tiene errores de validación y no se puede usar hasta corregirlos:\n') +
      messages.slice(0, 8).map((m) => `• ${m}`).join('\n') +
      (messages.length > 8 ? `\n… y ${messages.length - 8} más` : '');
  } else if (current.warnings.length) {
    mmProblems.hidden = false;
    mmProblems.classList.add('warn');
    mmProblems.textContent = `${current.warnings.length} aviso(s) de validación; se generará igualmente.`;
  }
}

function renderClasses() {
  const classes = current?.classes ?? [];
  classCount.textContent = classes.length ? `(${classes.length})` : '';
  classesBody.replaceChildren(
    ...classes.map((c) => {
      const state = classState.get(c.id)!;
      const row = document.createElement('tr');
      row.dataset.class = c.name;
      row.classList.toggle('abstract', c.abstract);
      row.classList.toggle('excluded', !c.abstract && !state.use);

      const use = document.createElement('input');
      use.type = 'checkbox';
      use.checked = !c.abstract && state.use;
      use.disabled = c.abstract;
      use.addEventListener('change', () => {
        state.use = use.checked;
        row.classList.toggle('excluded', !state.use);
      });

      const nameCell = document.createElement('td');
      nameCell.className = 'name';
      const bold = text('b', c.name);
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = typeColor(c.name);
      dot.style.marginRight = '6px';
      nameCell.append(dot, bold);
      if (c.abstract) nameCell.append(text('small', 'abstracta'));
      if (c.supertypes.length) nameCell.append(text('small', `↑ ${c.supertypes.join(', ')}`));
      nameCell.addEventListener('click', () => highlightClass(highlighted === c.name ? null : c.name, true));

      const counts = text('td', `${c.attributes} · ${c.references}`, 'num');
      counts.title = `${c.attributes} atributos y ${c.references} referencias (${c.containments} de contención)`;

      const root = document.createElement('input');
      root.type = 'checkbox';
      root.checked = !c.abstract && state.root;
      root.disabled = c.abstract;
      root.addEventListener('change', () => (state.root = root.checked));

      const cell = (child: HTMLElement, className = '') => {
        const td = document.createElement('td');
        td.className = className;
        td.append(child);
        return td;
      };
      row.append(cell(use, 'center'), nameCell, counts, cell(root, 'center'));
      return row;
    }),
  );
  markHighlightedRow();
}

function highlightClass(name: string | null, center: boolean) {
  highlighted = name;
  graph.highlightRule(name);
  if (name && center) {
    const ids = graph.nodesOfRule(name);
    if (ids.length) graph.centerOn(ids);
  }
  markHighlightedRow();
  for (const row of document.querySelectorAll<HTMLElement>('.bar-row')) row.classList.toggle('selected', row.dataset.class === name);
}

function markHighlightedRow() {
  for (const row of classesBody.querySelectorAll<HTMLElement>('tr')) row.classList.toggle('selected', row.dataset.class === highlighted);
}

async function refreshMetamodels(initial = false) {
  try {
    const response = await api.metamodels();
    const signature = JSON.stringify(response.items);
    if (signature === infosSignature) return;
    infosSignature = signature;
    infos = response.items;
    const keep = current?.file ?? settings.metamodel;
    renderMetamodelSelect();
    selectMetamodel(keep, !initial);
  } catch {
    /* the status pill already tells when the backend is unreachable */
  }
}

metamodelSelect.addEventListener('change', () => {
  selectMetamodel(metamodelSelect.value);
  result = null;
  graph.clear();
  graph.showMessage('Pulsa <b>Generate</b> para crear un modelo aleatorio.', 'empty');
  graphStats.textContent = '';
  clearResults();
});
$('#refresh').addEventListener('click', () => void refreshMetamodels());
window.addEventListener('focus', () => void refreshMetamodels());

// ---------- parameters ----------

for (const { input, key } of numericInputs) {
  input.value = String(settings[key]);
  input.addEventListener('input', () => {
    const value = Number(input.value);
    if (input.value !== '' && Number.isFinite(value)) {
      settings[key] = value;
      saveSettings();
    }
  });
}

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

// ---------- generate ----------

function buildRequest(): GenerateRequest | null {
  if (!current) return null;
  const excluded: string[] = [];
  const roots: string[] = [];
  for (const c of current.classes) {
    const state = classState.get(c.id)!;
    if (c.abstract) continue;
    if (!state.use) excluded.push(c.id);
    if (state.root) roots.push(c.id);
  }
  return {
    metamodel: current.file,
    size: settings.size,
    degree: settings.degree,
    sizeVariation: settings.sizeVariation / 100,
    degreeVariation: settings.degreeVariation / 100,
    seed: settings.seedLocked && settings.seed !== null ? settings.seed : undefined,
    excluded,
    roots,
  };
}

async function generate() {
  if (busy) return;
  const request = buildRequest();
  if (!request) {
    graph.showMessage('No hay ningún metamodelo. Copia un <b>.ecore</b> en la carpeta <b>metamodels/</b>.', 'error');
    return;
  }
  busy = true;
  generateButton.disabled = true;
  generateButton.dataset.busy = 'true';
  graph.showMessage('Generando…', 'busy');

  try {
    const response = await api.generate(request);
    if (!response.ok) {
      const label = { params: 'Parámetros no válidos', metamodel: 'Problema con el metamodelo', run: 'Falló la generación', server: 'Error del servidor' }[response.phase] ?? 'Error';
      graph.showMessage(`<h3>${label}</h3><pre>${escapeHtml(response.error)}</pre>`, 'error');
      return;
    }
    result = response;
    if (!settings.seedLocked) {
      settings.seed = response.seed;
      seedInput.value = String(response.seed);
    }
    highlighted = null;
    if (response.graph) {
      await graph.setData(response.graph, { direction: settings.direction, showImplicit: false });
    } else {
      graph.clear();
      graph.showMessage(escapeHtml(response.graphSkipped ?? 'No se dibuja el grafo.'), 'empty');
    }
    markHighlightedRow();
    renderResults(response);
    graphStats.textContent = `${response.objects} objetos · ${response.graph ? response.graph.stats.edges + ' aristas · ' : ''}semilla ${response.seed} · ${response.millis.total} ms`;
  } catch (error) {
    graph.showMessage(`<h3>Sin conexión</h3><p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`, 'error');
  } finally {
    busy = false;
    generateButton.disabled = false;
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

// ---------- results ----------

function showTab(name: string) {
  for (const tab of tabs) tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
  for (const [key, body] of Object.entries(tabBodies)) body.hidden = key !== name;
  downloadButton.hidden = name !== 'xmi' || !result?.xmi;
}
for (const tab of tabs) tab.addEventListener('click', () => showTab(tab.dataset.tab!));

function clearResults() {
  tabBodies.summary.replaceChildren(text('p', 'Aquí verás la configuración que se aplicó y cuántos objetos hay de cada metaclase.', 'empty'));
  tabBodies.log.replaceChildren(text('p', 'Aquí verás el registro del generador.', 'empty'));
  tabBodies.xmi.replaceChildren(text('p', 'Aquí verás el modelo serializado en XMI.', 'empty'));
  downloadButton.hidden = true;
  renderOclTab();
}

// ---------- OCL results ----------

/**
 * The restrictions that apply to the current metamodel (from every *.ocl file in metamodels/ whose context
 * classes match it): just their definitions before a model exists, and how the last generated model fares
 * against each of them once it does.
 */
function renderOclTab() {
  const info = current;
  const check = result?.ocl ?? null;
  const fileErrors = check?.fileErrors ?? info?.oclErrors ?? [];
  const children: Node[] = [];

  if (fileErrors.length) {
    const pre = document.createElement('pre');
    pre.className = 'ocl-file-errors';
    pre.textContent = `No se pudieron leer algunas restricciones OCL:\n${fileErrors.join('\n')}`;
    children.push(pre);
  }

  const definitions = info?.constraints ?? [];
  if (!definitions.length) {
    children.push(
      text(
        'p',
        info
          ? `No hay restricciones OCL para ${info.file}. Añade un fichero .ocl a la carpeta metamodels/ con reglas «context Clase inv Nombre: ...» sobre alguna de sus metaclases.`
          : 'Elige un metamodelo.',
        'ocl-empty',
      ),
    );
    tabBodies.ocl.replaceChildren(...children);
    oclCount.textContent = '';
    oclCount.classList.remove('bad');
    return;
  }

  const table = document.createElement('table');
  table.className = 'ocl';
  const head = document.createElement('thead');
  head.innerHTML = check ? '<tr><th>Restricción</th><th class="num">Instancias</th><th class="num">Incumplen</th><th>Estado</th></tr>' : '<tr><th>Restricción</th><th>Estado</th></tr>';
  table.append(head);
  const body = document.createElement('tbody');
  const byKey = new Map((check?.constraints ?? []).map((c) => [`${c.context}.${c.name}`, c]));
  let violating = 0;

  for (const def of definitions) {
    const checked = byKey.get(`${def.context}.${def.name}`);
    const row = document.createElement('tr');
    const ruleCell = document.createElement('td');
    ruleCell.className = 'rule';
    ruleCell.append(text('b', `${def.context}::${def.name}`), text('small', def.expression));
    row.append(ruleCell);
    if (check) row.append(text('td', String(checked?.instances ?? 0), 'num'), text('td', String(checked?.violations ?? 0), 'num'));

    const status = document.createElement('td');
    if (!check) {
      status.append(text('span', 'pendiente — genera un modelo', 'status'));
    } else if ((checked?.violations ?? 0) > 0) {
      violating++;
      status.append(text('span', `✗ ${checked!.violations} incumplimiento(s)`, 'status bad'));
      if (checked!.examples.length) {
        const ul = document.createElement('ul');
        ul.className = 'ocl-examples';
        for (const example of checked!.examples) ul.append(text('li', example));
        if (checked!.violations > checked!.examples.length) ul.append(text('li', `… y ${checked!.violations - checked!.examples.length} más`));
        status.append(ul);
      }
    } else {
      status.append(text('span', '✓ se cumple', 'status ok'));
    }
    row.append(status);
    body.append(row);
  }
  table.append(body);
  children.push(table);
  tabBodies.ocl.replaceChildren(...children);

  if (check) {
    oclCount.textContent = String(violating);
    oclCount.classList.toggle('bad', violating > 0 || fileErrors.length > 0);
  } else {
    oclCount.textContent = String(definitions.length);
    oclCount.classList.remove('bad');
  }
}

function kpi(label: string, value: string, kind = ''): HTMLElement {
  const box = document.createElement('div');
  box.className = `kpi ${kind}`;
  box.append(text('small', label), text('b', value));
  return box;
}

function renderResults(r: GenerateOk) {
  // summary
  const kpis = document.createElement('div');
  kpis.className = 'kpis';
  const [min, max] = r.applied.elements;
  kpis.append(
    kpi('Objetos generados', String(r.objects)),
    kpi('Pedidos', `${r.requested} (${min}–${max})`),
    kpi('Semilla', String(r.seed)),
    kpi('Tiempo', `${r.millis.total} ms`),
  );
  if (r.diagnosis) kpis.append(kpi('Diagnóstico EMF', r.diagnosis.ok ? 'OK' : `${r.diagnosis.errors} errores`, r.diagnosis.ok ? 'good' : 'bad'));
  if (r.ocl && r.ocl.constraints.length) {
    const violating = r.ocl.constraints.filter((c) => c.violations > 0).length;
    kpis.append(kpi('Restricciones OCL', r.ocl.ok ? 'OK' : `${violating}/${r.ocl.constraints.length} incumplidas`, r.ocl.ok ? 'good' : 'bad'));
  }

  const applied = document.createElement('table');
  applied.className = 'applied';
  const rows: [string, number[]][] = [
    ['Tamaño del modelo (objetos)', r.applied.elements],
    ['Atributos por objeto', r.applied.properties],
    ['Referencias por objeto', r.applied.references],
    ['Longitud de los valores de texto', r.applied.values],
  ];
  for (const [label, [a, b]] of rows) {
    const tr = document.createElement('tr');
    tr.append(text('td', label), text('td', a === b ? String(a) : `${a} – ${b}`));
    applied.append(tr);
  }

  const bars = document.createElement('div');
  bars.className = 'bars';
  const entries = Object.entries(r.byClass).sort((x, y) => y[1] - x[1]);
  const top = Math.max(1, ...entries.map((e) => e[1]));
  for (const [name, count] of entries) {
    const row = document.createElement('div');
    row.className = 'bar-row';
    row.dataset.class = name;
    const label = document.createElement('span');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = typeColor(name);
    label.append(dot, name);
    const track = document.createElement('span');
    track.className = 'track';
    const fill = document.createElement('i');
    fill.style.width = `${(count / top) * 100}%`;
    track.append(fill);
    row.append(label, track, text('span', String(count), 'n'));
    row.addEventListener('click', () => highlightClass(highlighted === name ? null : name, true));
    bars.append(row);
  }

  const children: Node[] = [kpis, text('h3', 'Configuración aplicada', 'result-h'), applied, text('h3', 'Objetos por metaclase', 'result-h'), bars];
  if (r.diagnosis && !r.diagnosis.ok) {
    const list = document.createElement('ul');
    list.className = 'diag-list';
    for (const m of r.diagnosis.messages) list.append(text('li', m));
    children.push(text('h3', 'Errores del diagnóstico', 'result-h'), list);
  }
  tabBodies.summary.replaceChildren(...children);

  // log
  tabBodies.log.replaceChildren(
    ...r.log.map((line) => {
      const row = document.createElement('div');
      row.className = `log-line ${line.level}`;
      row.append(text('span', line.level, 'lvl'), text('span', line.message, 'msg'));
      return row;
    }),
  );

  // xmi
  if (r.xmi) {
    const pre = text('pre', r.xmi, 'java');
    tabBodies.xmi.replaceChildren(pre);
  } else {
    tabBodies.xmi.replaceChildren(text('p', `El XMI ocupa ${(r.xmiBytes / 1024 / 1024).toFixed(1)} MB: demasiado grande para mostrarlo o descargarlo desde aquí. Reduce el tamaño.`, 'empty'));
  }

  renderOclTab();
  const active = tabs.find((t) => t.getAttribute('aria-selected') === 'true')?.dataset.tab ?? 'summary';
  showTab(active);
}

downloadButton.addEventListener('click', () => {
  if (!result?.xmi) return;
  const blob = new Blob([result.xmi], { type: 'application/xml' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${(current?.file ?? 'model').replace(/\.ecore$/, '')}-seed${result.seed}.xmi`;
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
    void graph.setOptions({ direction: settings.direction });
  });
}
renderDirection();
$('#fit').addEventListener('click', () => graph.fit());

// ---------- backend status ----------

let loadedOnce = false;

async function pollHealth() {
  try {
    const health = await api.health();
    statusPill.dataset.state = health.ready ? 'ready' : 'warming';
    statusPill.textContent = health.ready ? 'Backend listo' : 'Backend calentando…';
    if (!loadedOnce) {
      loadedOnce = true;
      await refreshMetamodels(true);
    }
  } catch {
    statusPill.dataset.state = 'down';
    statusPill.textContent = 'Backend sin conexión';
  }
  window.setTimeout(pollHealth, statusPill.dataset.state === 'ready' ? 8000 : 1500);
}

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
bindSplitter($('#split-v'), 'x', '--left', 'inst.left', [340, 380]);
bindSplitter($('#split-h'), 'y', '--rules-h', 'inst.rules', [140, 200]);

// ---------- go ----------

renderSeedControls();
clearResults();
void pollHealth();
