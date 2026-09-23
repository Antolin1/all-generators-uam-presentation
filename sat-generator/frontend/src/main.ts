import './style.css';
import { api, type GenerateOk, type GenerateRequest, type MetamodelInfo, type OclResultItem } from './api';
import { CodeView } from './code';
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

function el(tag: string, className = ''): HTMLElement {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

// ---------- settings ----------

interface ScopeForm {
  root: string;
  bounds: Record<string, { min?: number; max?: number }>;
  totalMin: number | null;
  totalMax: number | null;
}

interface Settings {
  metamodel: string | null;
  direction: Direction;
  scopes: Record<string, ScopeForm>;
}

const settings: Settings = {
  metamodel: null,
  direction: 'RIGHT',
  scopes: {},
  ...stored<Partial<Settings>>('satgen.settings', {}),
};
const saveSettings = () => store('satgen.settings', settings);

// ---------- elements ----------

const metamodelSelect = $<HTMLSelectElement>('#metamodel');
const generateButton = $<HTMLButtonElement>('#generate');
const statusPill = $<HTMLSpanElement>('#backend-status');
const mmInfo = $<HTMLParagraphElement>('#mm-info');
const mmProblems = $<HTMLDivElement>('#mm-problems');
const oclSourceCount = $<HTMLSpanElement>('#ocl-source-count');
const rootSelect = $<HTMLSelectElement>('#root-class');
const scopeBody = $<HTMLTableSectionElement>('#scope-body');
const totalMin = $<HTMLInputElement>('#total-min');
const totalMax = $<HTMLInputElement>('#total-max');
const formError = $<HTMLParagraphElement>('#form-error');
const classesBody = $<HTMLTableSectionElement>('#classes tbody');
const classCount = $<HTMLSpanElement>('#class-count');
const graphStats = $<HTMLSpanElement>('#graph-stats');
const downloadButton = $<HTMLButtonElement>('#download');
const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role=tab]')];
const tabBodies: Record<string, HTMLElement> = { summary: $('#tab-summary'), ocl: $('#tab-ocl'), log: $('#tab-log'), cnf: $('#tab-cnf'), xmi: $('#tab-xmi') };
const oclCount = $<HTMLSpanElement>('#ocl-count');

const oclViewer = new CodeView($('#ocl-viewer'), 'ocl');
const xmiView = new CodeView(tabBodies.xmi, 'xml');

const graph = new GraphView($('#graph'), {
  onSelect(nodeId) {
    graph.select(nodeId);
    const node = nodeId && result?.sat ? result.graph.nodes.find((n) => n.id === nodeId) : undefined;
    highlightClass(node?.type ?? null, false);
  },
});
graph.showMessage('Elige un metamodelo, define el scope y pulsa <b>Generate</b> para buscar un modelo.', 'empty');

// ---------- state ----------

let infos: MetamodelInfo[] = [];
let infosSignature = '';
let current: MetamodelInfo | null = null;
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
  renderClasses();
  renderMetamodelHeader();
  renderOclViewer();
  renderScopeForm(true);
  void keepState;
}

function renderMetamodelHeader() {
  mmProblems.hidden = true;
  mmProblems.classList.remove('warn');
  if (!current) {
    mmInfo.textContent = '';
    return;
  }
  mmInfo.textContent = `${current.file} · ${current.classes.length} clases · ${current.constraints.length} restricción(es)`;
  mmInfo.className = 'hint-text ok';
  const errors = [...current.errors];
  if (errors.length) {
    mmProblems.hidden = false;
    mmProblems.textContent =
      (current.status === 'error' ? 'No se pudo leer el metamodelo:\n' : 'El metamodelo tiene errores de validación y no se puede usar hasta corregirlos:\n') +
      errors.slice(0, 8).map((m) => `• ${m}`).join('\n') +
      (errors.length > 8 ? `\n… y ${errors.length - 8} más` : '');
    return;
  }
  const notes: string[] = [];
  if (current.warnings.length) notes.push(`${current.warnings.length} aviso(s) de validación del metamodelo.`);
  if (current.oclErrors.length) notes.push(`No se pudieron leer algunas restricciones OCL: ${current.oclErrors.join(' ')}`);
  if (notes.length) {
    mmProblems.hidden = false;
    mmProblems.classList.add('warn');
    mmProblems.textContent = notes.join(' ');
  }
}

function renderOclViewer() {
  const items = current?.constraints ?? [];
  oclSourceCount.textContent = items.length ? `(${items.length})` : '';
  oclViewer.setText(
    items.length
      ? items.map((c) => `context ${c.context} inv ${c.name}:\n  ${c.expression}`).join('\n\n')
      : current
        ? `-- No hay restricciones OCL para ${current.file}: añade un fichero .ocl a metamodels/ con reglas\n-- "context Clase inv Nombre: ..." sobre alguna de sus metaclases.`
        : '',
  );
}

function renderClasses() {
  const classes = current?.classes ?? [];
  classCount.textContent = classes.length ? `(${classes.length})` : '';
  classesBody.replaceChildren(
    ...classes.map((c) => {
      const row = document.createElement('tr');
      row.dataset.class = c.name;
      row.classList.toggle('abstract', c.abstract);

      const nameCell = document.createElement('td');
      nameCell.className = 'name';
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = typeColor(c.name);
      dot.style.marginRight = '6px';
      nameCell.append(dot, text('b', c.name));
      if (c.abstract) nameCell.append(text('small', 'abstracta'));
      if (c.supertypes.length) nameCell.append(text('small', `↑ ${c.supertypes.join(', ')}`));
      nameCell.addEventListener('click', () => highlightClass(highlighted === c.name ? null : c.name, true));

      row.append(nameCell, text('td', c.rootCandidate ? '✓' : '', 'center'));
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
  graph.showMessage('Pulsa <b>Generate</b> para buscar un modelo.', 'empty');
  graphStats.textContent = '';
  clearResults();
});
$('#refresh').addEventListener('click', () => void refreshMetamodels());
window.addEventListener('focus', () => void refreshMetamodels());

// ---------- scope form ----------

let scopeFor: string | null = null;

function scopeKey(): string {
  return current?.file ?? '';
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
}

function renderScopeForm(force: boolean) {
  const classes = current?.classes ?? [];
  const key = scopeKey();
  if (!force && scopeFor === key && rootSelect.options.length) return;
  scopeFor = key;
  const previous = settings.scopes[key];
  const candidates = classes.filter((c) => c.rootCandidate).map((c) => c.name);
  const concrete = classes.filter((c) => !c.abstract).map((c) => c.name);
  const ordered = [...candidates, ...concrete.filter((name) => !candidates.includes(name))];
  rootSelect.replaceChildren(...ordered.map((name) => new Option(candidates.includes(name) ? `${name} (raíz natural)` : name, name)));
  rootSelect.value = previous && ordered.includes(previous.root) ? previous.root : (ordered[0] ?? '');

  scopeBody.replaceChildren(
    ...classes.map((c) => {
      const row = document.createElement('tr');
      const nameCell = el('td', c.abstract ? 'abstract' : '');
      nameCell.textContent = c.abstract ? `${c.name} (abstracta)` : c.name;
      row.append(nameCell);
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

function showFormError(message: string | null) {
  formError.textContent = message ?? '';
  formError.hidden = !message;
}

function buildRequest(): GenerateRequest | null {
  if (!current) return null;
  const scope = readScope();
  if (!scope.root) return null;
  return { metamodel: current.file, rootClass: scope.root, classBounds: scope.bounds, totalMin: scope.totalMin, totalMax: scope.totalMax };
}

async function generate() {
  if (busy) return;
  showFormError(null);
  const request = buildRequest();
  if (!request) {
    graph.showMessage('No hay ningún metamodelo. Copia un <b>.ecore</b> (y, si quieres, un <b>.ocl</b>) en la carpeta <b>metamodels/</b>.', 'error');
    return;
  }
  busy = true;
  generateButton.disabled = true;
  generateButton.dataset.busy = 'true';
  graph.showMessage('Buscando un modelo que cumpla el metamodelo y las restricciones…', 'busy');

  try {
    const response = await api.generate(request);
    if (!response.ok) {
      const label = { params: 'Parámetros no válidos', metamodel: 'Problema con el metamodelo', run: 'Falló la búsqueda', server: 'Error del servidor' }[response.phase] ?? 'Error';
      graph.showMessage(`<h3>${label}</h3><pre>${escapeHtml(response.error)}</pre>`, 'error');
      return;
    }
    result = response;
    highlighted = null;
    if (!response.sat) {
      graph.clear();
      graph.showMessage(
        '<h3>No existe ningún modelo</h3><p>Dentro de estas cotas no hay ninguna forma de cumplir el metamodelo' +
          (response.translatedConstraints.length ? ' y las restricciones OCL traducidas a SAT' : '') +
          '. Prueba a ampliar el scope, o revisa si dos restricciones se contradicen.</p>',
        'empty',
      );
      graphStats.textContent = '';
    } else {
      await graph.setData(response.graph, { direction: settings.direction, showImplicit: false });
      graphStats.textContent = `${response.objects} objetos · ${response.graph.stats.edges} aristas · ${response.satStats.millis} ms de SAT`;
    }
    markHighlightedRow();
    renderResults(response);
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
  downloadButton.hidden = name !== 'xmi' || !(result?.sat);
  if (name === 'xmi') xmiView.refresh();
  if (name === 'ocl' && document.getElementById('ocl-editor-refresh')) void 0;
}
for (const tab of tabs) tab.addEventListener('click', () => showTab(tab.dataset.tab!));

function clearResults() {
  tabBodies.summary.replaceChildren(text('p', 'Aquí verás si existe un modelo dentro de este scope (SAT/UNSAT) y su resumen.', 'empty'));
  tabBodies.ocl.replaceChildren(text('p', 'Aquí verás, restricción a restricción, cuántas instancias se comprobaron y cuántas la incumplen.', 'empty'));
  tabBodies.log.replaceChildren(text('p', 'Aquí verás el registro de la comprobación estructural y de invariantes de USE.', 'empty'));
  tabBodies.cnf.replaceChildren(text('p', 'Aquí verás el código SAT (CNF en formato DIMACS) que se le pasó al resolutor.', 'empty'));
  xmiView.setText('');
  downloadButton.hidden = true;
  oclCount.textContent = '';
  oclCount.classList.remove('bad');
}

function kpi(label: string, value: string, kind = ''): HTMLElement {
  const box = document.createElement('div');
  box.className = `kpi ${kind}`;
  box.append(text('small', label), text('b', value));
  return box;
}

function renderResults(r: GenerateOk) {
  const kpis = document.createElement('div');
  kpis.className = 'kpis';
  kpis.append(kpi('SAT', r.sat ? 'sí, hay modelo' : 'no hay modelo', r.sat ? 'good' : 'bad'));
  kpis.append(kpi('Variables', String(r.satStats.variables)));
  kpis.append(kpi('Cláusulas', String(r.satStats.clauses)));
  kpis.append(kpi('Tiempo de SAT', `${r.satStats.millis} ms`));
  if (r.sat) {
    kpis.append(kpi('Objetos encontrados', String(r.objects)));
    kpis.append(kpi('Diagnóstico USE', r.diagnosis.ok ? 'OK' : 'con errores', r.diagnosis.ok ? 'good' : 'bad'));
    if (r.ocl.constraints.length) {
      const violating = r.ocl.constraints.filter((c) => c.violations > 0 || c.error).length;
      kpis.append(kpi('Restricciones OCL', r.ocl.ok ? 'OK' : `${violating}/${r.ocl.constraints.length} incumplidas`, r.ocl.ok ? 'good' : 'bad'));
    }
  }

  const children: Node[] = [kpis];
  if (r.sat) {
    const entries = Object.entries(r.byClass).sort((a, b) => b[1] - a[1]);
    if (entries.length) {
      children.push(text('h3', 'Objetos por metaclase', 'result-h'));
      const bars = document.createElement('div');
      bars.className = 'bars';
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
      children.push(bars);
    }
  } else {
    children.push(
      text(
        'p',
        'No existe ningún modelo dentro de estas cotas. Prueba a ampliar el scope de alguna clase o el total, o revisa si dos restricciones se contradicen.',
        'empty',
      ),
    );
  }

  if (r.untranslatedConstraints.length) {
    children.push(text('h3', 'Restricciones que no se pudieron traducir a SAT', 'result-h'));
    const list = document.createElement('ul');
    list.className = 'diag-list-neutral';
    for (const u of r.untranslatedConstraints) list.append(text('li', u));
    children.push(list);
  }
  const fileErrors = r.sat ? r.ocl.fileErrors : r.oclFileErrors;
  if (fileErrors.length) {
    children.push(text('h3', 'Ficheros .ocl con errores', 'result-h'));
    const list = document.createElement('ul');
    list.className = 'diag-list';
    for (const e of fileErrors) list.append(text('li', e));
    children.push(list);
  }
  tabBodies.summary.replaceChildren(...children);

  renderOclResultsTab(r);
  tabBodies.log.replaceChildren(text('pre', r.sat ? r.diagnosis.log || '(sin salida)' : 'No se llegó a comprobar con USE: no hay ningún modelo que reproducir.', 'java'));
  tabBodies.cnf.replaceChildren(text('pre', r.cnf || '(sin datos)', 'java'));
  xmiView.setText(r.sat ? r.xmi : '');
  downloadButton.hidden = !r.sat;

  const active = tabs.find((t) => t.getAttribute('aria-selected') === 'true')?.dataset.tab ?? 'summary';
  showTab(active);
}

function renderOclResultsTab(r: GenerateOk) {
  const definitions = current?.constraints ?? [];
  if (!definitions.length) {
    tabBodies.ocl.replaceChildren(text('p', current ? `No hay restricciones OCL para ${current.file}.` : 'Elige un metamodelo.', 'ocl-empty'));
    oclCount.textContent = '';
    oclCount.classList.remove('bad');
    return;
  }

  const checked = r.sat ? r.ocl.constraints : null;
  const byKey = new Map<string, OclResultItem>((checked ?? []).map((c) => [`${c.context}::${c.name}`, c]));
  const translated = new Set(r.translatedConstraints);

  const table = document.createElement('table');
  table.className = 'ocl';
  const head = document.createElement('thead');
  head.innerHTML = checked
    ? '<tr><th>Restricción</th><th>Traducida a SAT</th><th class="num">Instancias</th><th class="num">Incumplen</th><th>Estado (según USE)</th></tr>'
    : '<tr><th>Restricción</th><th>Traducida a SAT</th></tr>';
  table.append(head);
  const body = document.createElement('tbody');
  let violating = 0;

  for (const def of definitions) {
    const key = `${def.context}::${def.name}`;
    const isTranslated = translated.has(key);
    const row = document.createElement('tr');
    const ruleCell = document.createElement('td');
    ruleCell.className = 'rule';
    ruleCell.append(text('b', `${def.context}::${def.name}`), text('small', def.expression));
    row.append(ruleCell);
    row.append(text('td', isTranslated ? '✓ sí' : 'no — solo la comprueba USE', isTranslated ? 'status ok' : 'status'));

    if (checked) {
      const c = byKey.get(key);
      row.append(text('td', String(c?.instances ?? 0), 'num'), text('td', String(c?.violations ?? 0), 'num'));
      const status = document.createElement('td');
      if (!c) {
        status.append(text('span', 'no comprobada', 'status'));
      } else if (c.error) {
        violating++;
        status.append(text('span', 'ERROR: ' + c.error, 'status error'));
      } else if (c.violations > 0) {
        violating++;
        status.append(text('span', `✗ ${c.violations} incumplimiento(s)`, 'status bad'));
        if (c.examples.length) {
          const ul = document.createElement('ul');
          ul.className = 'ocl-examples';
          for (const example of c.examples) ul.append(text('li', example));
          status.append(ul);
        }
      } else {
        status.append(text('span', '✓ se cumple', 'status ok'));
      }
      row.append(status);
    }
    body.append(row);
  }
  table.append(body);
  tabBodies.ocl.replaceChildren(table);

  if (checked) {
    oclCount.textContent = String(violating);
    oclCount.classList.toggle('bad', violating > 0);
  } else {
    oclCount.textContent = String(definitions.length);
    oclCount.classList.remove('bad');
  }
}

downloadButton.addEventListener('click', () => {
  if (!result?.sat) return;
  const blob = new Blob([result.xmi], { type: 'application/xml' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${(current?.file ?? 'model').replace(/\.ecore$/, '')}.xmi`;
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
bindSplitter($('#split-v'), 'x', '--left', 'satgen.left', [340, 380]);
bindSplitter($('#split-h'), 'y', '--rules-h', 'satgen.rules', [140, 200]);

// ---------- go ----------

clearResults();
void pollHealth();
