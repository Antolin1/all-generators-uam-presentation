import './style.css';
import { api, type AnalyzeResponse, type Example, type MetamodelList, type GenerateOk, type Issue, type RuleInfo, type Trace, type TraceNode } from './api';
import { createEditor, type EditorHandle } from './editor';
import { GraphView, type Direction } from './graph';
import { RulesPanel } from './rules-panel';

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

const ICON_LOCKED =
  '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M8 1a3.5 3.5 0 0 0-3.5 3.5V6H4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1h-.5V4.5A3.5 3.5 0 0 0 8 1Zm-2 3.5a2 2 0 1 1 4 0V6H6V4.5Z"/></svg>';
const ICON_UNLOCKED =
  '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M8 1a3.5 3.5 0 0 0-3.5 3.5V6H4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1H6V4.5a2 2 0 0 1 3.9-.6.75.75 0 1 0 1.44-.4A3.5 3.5 0 0 0 8 1Z"/></svg>';

// ---------- state ----------

interface Settings {
  seed: number | null;
  seedLocked: boolean;
  maxObjects: number;
  direction: Direction;
  showImplicit: boolean;
  cursorHighlight: boolean;
  params: Record<string, string>;
}

const saved = stored<Partial<Settings>>('rmf.settings', {});
const settings: Settings = {
  seed: null,
  seedLocked: false,
  maxObjects: 100,
  direction: 'RIGHT',
  showImplicit: false,
  cursorHighlight: true,
  ...saved,
  params: { ...(saved.params ?? {}) },
};
const saveSettings = () => store('rmf.settings', settings);

let examples: Example[] = [];
let analysis: AnalyzeResponse | null = null;
let result: GenerateOk | null = null;
let analyzeTimer = 0;
let analyzeCounter = 0;
let busy = false;
/** trace node id -> id of the graph object it concerns (rule: its own object; feature: the owner; alt: the produced one) */
let objectOf = new Map<string, string | null>();

// ---------- elements ----------

const exampleSelect = $<HTMLSelectElement>('#example');
const seedInput = $<HTMLInputElement>('#seed');
const seedLock = $<HTMLButtonElement>('#seed-lock');
const maxObjectsInput = $<HTMLInputElement>('#max-objects');
const paramsBox = $<HTMLDivElement>('#params');
const generateButton = $<HTMLButtonElement>('#generate');
const statusPill = $<HTMLSpanElement>('#backend-status');
const metamodelLabel = $<HTMLSpanElement>('#metamodel');
const graphStats = $<HTMLSpanElement>('#graph-stats');
const showImplicit = $<HTMLInputElement>('#show-implicit');
const problems = $<HTMLDivElement>('#problems');
const problemsSummary = $<HTMLSpanElement>('#problems-summary');
const problemsList = $<HTMLUListElement>('#problems-list');

// ---------- editor, graph, rules ----------

const editor: EditorHandle = createEditor($('#editor'), stored<string>('rmf.source', ''), {
  onChange() {
    store('rmf.source', editor.text());
    updateExampleSelection();
    scheduleAnalysis();
  },
  onCursor(offset) {
    if (!settings.cursorHighlight || !result || !analysis) return;
    const rule = analysis.rules.find((r) => r.range && offset >= r.range.offset && offset <= r.range.offset + r.range.length);
    graph.highlightRule(rule?.name ?? null);
    panel.selectRuleInSummary(rule?.name ?? null);
  },
  onRun: generate,
});

const graph = new GraphView($('#graph'), {
  onSelect(nodeId) {
    graph.select(nodeId);
    const node = nodeId && result ? result.graph.nodes.find((n) => n.id === nodeId) : undefined;
    panel.selectApp(node?.app ?? null);
    const rule = node?.rule ? ruleByName(node.rule) : undefined;
    if (rule?.range) editor.highlight(rule.range, [], true);
    else editor.clearHighlight();
  },
});

const panel = new RulesPanel($('.rules-panel'), {
  onSelectApp(app) {
    const rule = ruleByName(app.rule);
    graph.highlightRule(null);
    if (app.object) graph.select(app.object, true);
    editor.highlight(rule?.range ?? null, [], true);
  },
  onSelectItem(app, item, rule) {
    const object = objectOf.get(app.id);
    if (object) graph.select(object, true);
    editor.highlight(rule?.range ?? null, item?.range ? [item.range] : [], true);
  },
  onSelectRule(name) {
    graph.select(null);
    graph.highlightRule(name);
    const rule = name ? ruleByName(name) : undefined;
    if (name) {
      const ids = graph.nodesOfRule(name);
      if (ids.length) graph.centerOn(ids);
    }
    if (rule?.range) editor.highlight(rule.range, [], true);
    else editor.clearHighlight();
  },
});

function ruleByName(name: string): RuleInfo | undefined {
  return (result?.rules ?? analysis?.rules)?.find((r) => r.name === name);
}

function indexTrace(trace: Trace) {
  objectOf = new Map();
  const visit = (node: TraceNode, owner: string | null) => {
    if (node.kind === 'rule') {
      objectOf.set(node.id, node.object ?? null);
      node.children.forEach((child) => visit(child, node.object ?? null));
    } else if (node.kind === 'feature') {
      objectOf.set(node.id, owner);
      node.children.forEach((child) => visit(child, owner));
    } else {
      // an alternative rule creates whatever its chosen alternative creates
      const produced = node.children.find((c) => c.kind === 'rule');
      objectOf.set(node.id, produced?.object ?? owner);
      node.children.forEach((child) => visit(child, owner));
    }
  };
  trace.roots.forEach((root) => visit(root, null));
}

// ---------- analysis (as you type) ----------

function scheduleAnalysis(delay = 500) {
  window.clearTimeout(analyzeTimer);
  analyzeTimer = window.setTimeout(runAnalysis, delay);
}

async function runAnalysis() {
  const ticket = ++analyzeCounter;
  const source = editor.text();
  if (!source.trim()) {
    analysis = null;
    showIssues([]);
    renderParams(null);
    metamodelLabel.textContent = '';
    return;
  }
  try {
    const response = await api.analyze(source);
    if (ticket !== analyzeCounter) return; // the text changed while waiting
    analysis = response;
    showIssues(response.issues);
    renderParams(response.generator?.params ?? null);
    metamodelLabel.textContent = response.generator?.metamodel ?? '';
    metamodelLabel.title = response.generator?.metamodel ?? '';
  } catch {
    /* the status pill already tells when the backend is unreachable */
  }
}

function showIssues(issues: Issue[]) {
  editor.setIssues(issues);
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;
  problems.dataset.empty = String(issues.length === 0);
  problems.dataset.errors = String(errors > 0);
  problemsSummary.textContent = issues.length
    ? [errors ? `${errors} ${errors === 1 ? 'error' : 'errores'}` : '', warnings ? `${warnings} ${warnings === 1 ? 'advertencia' : 'advertencias'}` : ''].filter(Boolean).join(' · ') || `${issues.length} avisos`
    : 'Sin problemas';
  problemsList.replaceChildren(
    ...issues.map((issue) => {
      const item = document.createElement('li');
      item.className = issue.severity;
      const where = document.createElement('span');
      where.className = 'where';
      where.textContent = `${issue.line}:${issue.column}`;
      const message = document.createElement('span');
      message.textContent = issue.message;
      item.append(where, message);
      item.addEventListener('click', () => editor.goTo(issue.offset));
      return item;
    }),
  );
}

$('#problems-toggle').addEventListener('click', (event) => {
  const button = event.currentTarget as HTMLButtonElement;
  const open = button.getAttribute('aria-expanded') !== 'true';
  button.setAttribute('aria-expanded', String(open));
  problems.classList.toggle('collapsed', !open);
});

// ---------- generator parameters ----------

let paramSignature = '';

function renderParams(params: { name: string; type: string }[] | null) {
  const signature = JSON.stringify(params ?? []);
  if (signature === paramSignature) return;
  paramSignature = signature;
  paramsBox.replaceChildren();
  for (const param of params ?? []) {
    const label = document.createElement('label');
    label.className = 'field param';
    const caption = document.createElement('span');
    caption.textContent = param.name;
    const type = document.createElement('small');
    type.textContent = param.type;
    caption.append(type);
    let input: HTMLInputElement | HTMLSelectElement;
    if (/^(boolean|Boolean)$/.test(param.type)) {
      const select = document.createElement('select');
      select.append(new Option('false', 'false'), new Option('true', 'true'));
      select.value = settings.params[param.name] === 'true' ? 'true' : 'false';
      settings.params[param.name] = select.value;
      input = select;
    } else {
      const text = document.createElement('input');
      text.type = /^(int|long|short|byte|double|float|Integer|Long|Double|Float)$/.test(param.type) ? 'number' : 'text';
      if (text.type === 'number') text.step = /double|float|Double|Float/.test(param.type) ? 'any' : '1';
      text.value = settings.params[param.name] ?? '';
      text.placeholder = param.type;
      input = text;
    }
    input.dataset.param = param.name;
    input.addEventListener('input', () => {
      settings.params[param.name] = input.value;
      saveSettings();
    });
    label.append(caption, input);
    paramsBox.append(label);
  }
}

// ---------- generate ----------

async function generate() {
  if (busy) return;
  busy = true;
  generateButton.disabled = true;
  generateButton.dataset.busy = 'true';
  graph.showMessage('Generando…', 'busy');

  const args: Record<string, string> = {};
  for (const input of paramsBox.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-param]')) args[input.dataset.param!] = input.value;
  const seed = settings.seedLocked && Number.isFinite(settings.seed) && settings.seed !== null ? settings.seed : undefined;

  try {
    const response = await api.generate({ source: editor.text(), seed, maxObjects: settings.maxObjects, args });
    if (!response.ok) {
      showIssues(response.issues);
      if (response.rules?.length) analysis = { ok: false, issues: response.issues, generator: response.generator, rules: response.rules };
      const label = { validation: 'Errores en el generador', compile: 'El Java generado no compila', run: 'Falló la generación', server: 'Error del servidor' }[response.phase] ?? 'Error';
      graph.showMessage(`<h3>${label}</h3><pre>${escapeHtml(response.error)}</pre>`, 'error');
      return;
    }
    result = response;
    analysis = { ok: true, issues: response.issues, generator: response.generator, rules: response.rules };
    showIssues(response.issues);
    if (!settings.seedLocked) {
      settings.seed = response.seed;
      seedInput.value = String(response.seed);
    }
    indexTrace(response.trace);
    await graph.setData(response.graph, { direction: settings.direction, showImplicit: settings.showImplicit });
    panel.setData(response.trace, response.rules, response.graph, response.java);
    editor.clearHighlight();
    const s = response.graph.stats;
    graphStats.textContent = `${s.objects} objetos · ${s.edges} aristas · semilla ${response.seed} · ${response.millis.prepare + response.millis.generate} ms`;
  } catch (error) {
    graph.showMessage(`<h3>Sin conexión</h3><p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`, 'error');
  } finally {
    busy = false;
    generateButton.disabled = false;
    delete generateButton.dataset.busy;
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

generateButton.addEventListener('click', generate);

// ---------- toolbar controls ----------

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

seedLock.innerHTML = ICON_UNLOCKED;
seedLock.addEventListener('click', () => {
  settings.seedLocked = !settings.seedLocked;
  if (settings.seedLocked && settings.seed === null) settings.seed = Math.floor(Math.random() * 1_000_000);
  saveSettings();
  renderSeedControls();
});
seedInput.addEventListener('input', () => {
  // typing a seed means you want that one
  const value = Number.parseInt(seedInput.value, 10);
  settings.seed = Number.isFinite(value) ? Math.max(0, value) : null;
  settings.seedLocked = settings.seed !== null;
  saveSettings();
  seedLock.setAttribute('aria-pressed', String(settings.seedLocked));
  seedLock.innerHTML = settings.seedLocked ? ICON_LOCKED : ICON_UNLOCKED;
  seedInput.classList.toggle('auto', !settings.seedLocked);
});

maxObjectsInput.value = String(settings.maxObjects);
maxObjectsInput.addEventListener('input', () => {
  const value = Number.parseInt(maxObjectsInput.value, 10);
  if (Number.isFinite(value) && value > 0) {
    settings.maxObjects = value;
    saveSettings();
  }
});

showImplicit.checked = settings.showImplicit;
showImplicit.addEventListener('change', () => {
  settings.showImplicit = showImplicit.checked;
  saveSettings();
  void graph.setOptions({ showImplicit: settings.showImplicit });
});

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

// ---------- examples ----------

function updateExampleSelection() {
  const text = editor.text();
  const match = examples.find((e) => e.source === text);
  exampleSelect.value = match ? match.id : '';
}

/** Replaces the editor's text (asking first if it holds something of your own) and clears the previous result. */
function loadSource(source: string): boolean {
  const current = editor.text();
  if (current.trim() && current !== source && !examples.some((e) => e.source === current) && !confirm('Se reemplazará el contenido del editor. ¿Continuar?')) {
    return false;
  }
  editor.setText(source);
  result = null;
  graph.clear();
  graph.showMessage('Pulsa <b>Generate</b> para crear un modelo con las reglas del editor.', 'empty');
  panel.clear();
  graphStats.textContent = '';
  scheduleAnalysis(0);
  return true;
}

exampleSelect.addEventListener('change', () => {
  const example = examples.find((e) => e.id === exampleSelect.value);
  if (!example) return;
  if (!loadSource(example.source)) updateExampleSelection();
});

async function loadExamples() {
  try {
    examples = await api.examples();
  } catch {
    return; // backend not up yet; retried by the health poll
  }
  const options = [new Option('— mi generador —', '')].concat(examples.map((e) => new Option(e.title, e.id)));
  exampleSelect.replaceChildren(...options);
  if (!editor.text().trim() && examples.length) editor.setText(examples[0].source);
  updateExampleSelection();
  scheduleAnalysis(0);
}

// ---------- metamodels ----------

const mmDialog = $<HTMLDialogElement>('#metamodels-dialog');
const mmList = $<HTMLUListElement>('#mm-list');

function renderMetamodels(list: MetamodelList) {
  $('#mm-dir').textContent = list.directory === '/metamodels' ? 'metamodels/' : list.directory;
  mmList.replaceChildren(
    ...list.items.map((item) => {
      const li = document.createElement('li');
      li.className = 'mm-item';
      li.dataset.status = item.status;

      const top = document.createElement('div');
      top.className = 'mm-top';
      const name = document.createElement('b');
      name.textContent = item.file;
      const badge = document.createElement('span');
      badge.className = 'mm-badge';
      badge.textContent = item.status === 'error' ? 'con errores' : item.builtin ? 'incluido' : 'listo';
      top.append(name, badge);
      li.append(top);

      if (item.status === 'ok') {
        const meta = document.createElement('div');
        meta.className = 'mm-meta';
        meta.textContent = `paquete ${item.packages.map((p) => p.name).join(', ')} · ${item.classes} clases · nsURI ${item.packages.map((p) => p.nsURI).join(', ')}`;
        li.append(meta);

        const uri = document.createElement('div');
        uri.className = 'mm-uri';
        const code = document.createElement('code');
        const snippet = `for ${item.packages[0]?.name ?? '…'} in "${item.uri}"`;
        code.textContent = snippet;
        code.title = snippet;
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'ghost small';
        copy.textContent = 'Copiar';
        copy.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(snippet);
            copy.textContent = 'Copiado';
          } catch {
            copy.textContent = 'No se pudo';
          }
          window.setTimeout(() => (copy.textContent = 'Copiar'), 1200);
        });
        uri.append(code, copy);
        li.append(uri);

        if (!item.builtin) {
          const actions = document.createElement('div');
          actions.className = 'mm-actions';
          const create = document.createElement('button');
          create.type = 'button';
          create.className = 'ghost';
          create.textContent = 'Nuevo generador para este metamodelo';
          create.title = 'Escribe en el editor un generador inicial: una regla por clase, atributos con valores aleatorios y contención acotada';
          create.addEventListener('click', async () => {
            create.disabled = true;
            try {
              const response = await api.template(item.file);
              if (!response.ok || !response.source) {
                alert(response.error ?? 'No se pudo crear la plantilla');
              } else if (loadSource(response.source)) {
                mmDialog.close();
              }
            } catch (error) {
              alert(error instanceof Error ? error.message : String(error));
            } finally {
              create.disabled = false;
            }
          });
          actions.append(create);
          li.append(actions);
        }
      } else {
        const error = document.createElement('pre');
        error.className = 'mm-error';
        error.textContent = item.error ?? 'Error desconocido';
        li.append(error);
      }
      return li;
    }),
  );
}

async function openMetamodels() {
  mmDialog.showModal();
  mmList.replaceChildren();
  try {
    renderMetamodels(await api.metamodels());
  } catch (error) {
    mmList.textContent = error instanceof Error ? error.message : String(error);
  }
}

$('#open-metamodels').addEventListener('click', openMetamodels);
$('#mm-reload').addEventListener('click', async () => {
  const button = $<HTMLButtonElement>('#mm-reload');
  button.disabled = true;
  button.textContent = 'Recargando…';
  try {
    renderMetamodels(await api.reloadMetamodels());
    void loadExamples();
    scheduleAnalysis(0);
  } catch (error) {
    mmList.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    button.disabled = false;
    button.textContent = 'Recargar';
  }
});
mmDialog.addEventListener('click', (event) => {
  if (event.target === mmDialog) mmDialog.close(); // click on the backdrop
});

// ---------- backend status ----------

let examplesLoaded = false;

async function pollHealth() {
  try {
    const health = await api.health();
    statusPill.dataset.state = health.ready ? 'ready' : 'warming';
    statusPill.textContent = health.ready ? 'Backend listo' : 'Backend calentando…';
    if (!examplesLoaded) {
      examplesLoaded = true;
      await loadExamples();
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
bindSplitter($('#split-v'), 'x', '--left', 'rmf.left', [300, 380]);
bindSplitter($('#split-h'), 'y', '--rules-h', 'rmf.rules', [140, 200]);

// ---------- go ----------

renderSeedControls();
const cursorToggle = document.querySelector<HTMLInputElement>('#cursor-highlight');
if (cursorToggle) {
  cursorToggle.checked = settings.cursorHighlight;
  cursorToggle.addEventListener('change', () => {
    settings.cursorHighlight = cursorToggle.checked;
    saveSettings();
    if (!settings.cursorHighlight) graph.highlightRule(null);
  });
}
void pollHealth();
