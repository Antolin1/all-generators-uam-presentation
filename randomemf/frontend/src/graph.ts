import ELK from 'elkjs/lib/elk-api.js';
import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api.js';
import ElkWorker from 'elkjs/lib/elk-worker.min.js?worker';
import type { Graph, GraphEdge, GraphNode } from './api';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Stable hue per metamodel class, so the graph and the rule list share colors. */
export function typeColor(type: string): string {
  let hash = 0;
  for (let i = 0; i < type.length; i++) hash = (hash * 31 + type.charCodeAt(i)) >>> 0;
  const hue = (hash * 137.508) % 360;
  return `hsl(${hue.toFixed(0)} 52% 40%)`;
}

export type Direction = 'DOWN' | 'RIGHT';

interface Callbacks {
  onSelect(nodeId: string | null): void;
}

interface Laid {
  node: GraphNode;
  x: number;
  y: number;
  width: number;
  height: number;
}

const HEADER_H = 24;
const TITLE_H = 20;
const ROW_H = 17;
const PAD_X = 10;
const BODY_PAD = 6;
const MIN_W = 116;
const MAX_TEXT_W = 300;

function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
  ...children: (SVGElement | string)[]
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  for (const child of children) element.append(child);
  return element;
}

export class GraphView {
  private readonly svg: SVGSVGElement;
  private readonly viewport: SVGGElement;
  private readonly edgeLayer: SVGGElement;
  private readonly nodeLayer: SVGGElement;
  private readonly overlay: HTMLDivElement;
  private readonly elk = new ELK({ workerFactory: () => new ElkWorker() as unknown as Worker });
  private readonly measure = document.createElement('canvas').getContext('2d')!;

  private graph: Graph | null = null;
  private direction: Direction = 'DOWN';
  private showImplicit = false;
  private token = 0;
  private laid = new Map<string, Laid>();
  private nodeEls = new Map<string, SVGGElement>();
  private edgeEls: { edge: GraphEdge; el: SVGGElement }[] = [];
  private bounds = { width: 0, height: 0 };
  private view = { x: 0, y: 0, k: 1 };
  private selected: string | null = null;
  private ruleFilter: string | null = null;

  constructor(private readonly container: HTMLElement, private readonly callbacks: Callbacks) {
    this.svg = el('svg', { class: 'graph-svg', width: '100%', height: '100%' });
    const defs = el('defs');
    defs.innerHTML = `
      <marker id="m-diamond" markerWidth="12" markerHeight="10" refX="0" refY="5" orient="auto" markerUnits="userSpaceOnUse">
        <path d="M0 5 L6 1.5 L12 5 L6 8.5 Z" class="marker-containment" />
      </marker>
      <marker id="m-arrow" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto" markerUnits="userSpaceOnUse">
        <path d="M0 0.5 L9.5 5 L0 9.5 Z" class="marker-reference" />
      </marker>`;
    this.viewport = el('g', { class: 'viewport' });
    this.edgeLayer = el('g', { class: 'edges' });
    this.nodeLayer = el('g', { class: 'nodes' });
    this.viewport.append(this.edgeLayer, this.nodeLayer);
    this.svg.append(defs, this.viewport);

    this.overlay = document.createElement('div');
    this.overlay.className = 'graph-overlay';
    container.append(this.svg, this.overlay);

    this.bindInteraction();
    new ResizeObserver(() => this.applyView()).observe(container);
    this.showMessage('Pulsa <b>Generate</b> para crear un modelo con las reglas del editor.', 'empty');
  }

  // --- public API ---

  showMessage(html: string, kind: 'empty' | 'error' | 'busy' | 'none') {
    this.overlay.dataset.kind = kind;
    this.overlay.innerHTML = kind === 'none' ? '' : `<div class="overlay-card">${html}</div>`;
    this.overlay.hidden = kind === 'none';
  }

  clear() {
    this.graph = null;
    this.laid.clear();
    this.nodeEls.clear();
    this.edgeEls = [];
    this.edgeLayer.replaceChildren();
    this.nodeLayer.replaceChildren();
    this.selected = null;
  }

  async setData(graph: Graph, options: { direction: Direction; showImplicit: boolean }) {
    this.graph = graph;
    this.direction = options.direction;
    this.showImplicit = options.showImplicit;
    this.selected = null;
    await this.relayout(true);
  }

  async setOptions(options: { direction?: Direction; showImplicit?: boolean }) {
    if (options.direction) this.direction = options.direction;
    if (options.showImplicit !== undefined) this.showImplicit = options.showImplicit;
    if (this.graph) await this.relayout(true);
  }

  select(nodeId: string | null, center = false) {
    this.selected = nodeId && this.nodeEls.has(nodeId) ? nodeId : null;
    const neighbors = new Set<string>();
    for (const { edge, el } of this.edgeEls) {
      const touches = this.selected !== null && (edge.source === this.selected || edge.target === this.selected);
      el.classList.toggle('connected', touches);
      if (touches) neighbors.add(edge.source === this.selected ? edge.target : edge.source);
    }
    for (const [id, element] of this.nodeEls) {
      element.classList.toggle('selected', id === this.selected);
      element.classList.toggle('neighbor', neighbors.has(id) && id !== this.selected);
    }
    this.svg.classList.toggle('has-selection', this.selected !== null);
    if (center && this.selected) this.centerOn([this.selected]);
  }

  /** Emphasize the nodes created by a rule and dim the rest; null clears. */
  highlightRule(rule: string | null) {
    this.ruleFilter = rule;
    for (const [id, element] of this.nodeEls) {
      const hit = rule !== null && this.laid.get(id)?.node.rule === rule;
      element.classList.toggle('rule-hit', hit);
      element.classList.toggle('dim', rule !== null && !hit);
    }
    for (const { edge, el } of this.edgeEls) {
      const a = this.laid.get(edge.source)?.node.rule === rule;
      const b = this.laid.get(edge.target)?.node.rule === rule;
      el.classList.toggle('dim', rule !== null && !(a || b));
    }
  }

  nodesOfRule(rule: string): string[] {
    return [...this.laid.values()].filter((l) => l.node.rule === rule).map((l) => l.node.id);
  }

  fit() {
    this.fitTo(0, 0, this.bounds.width, this.bounds.height, true);
  }

  centerOn(ids: string[]) {
    const boxes = ids.map((id) => this.laid.get(id)).filter((b): b is Laid => !!b);
    if (!boxes.length) return;
    const x0 = Math.min(...boxes.map((b) => b.x));
    const y0 = Math.min(...boxes.map((b) => b.y));
    const x1 = Math.max(...boxes.map((b) => b.x + b.width));
    const y1 = Math.max(...boxes.map((b) => b.y + b.height));
    if (boxes.length === 1) {
      // keep the current zoom (unless the node is barely visible) and just bring it to the middle
      const { width, height } = this.container.getBoundingClientRect();
      const k = Math.max(this.view.k, 0.6);
      this.view = { k, x: width / 2 - ((x0 + x1) / 2) * k, y: height / 2 - ((y0 + y1) / 2) * k };
      this.applyView(true);
    } else {
      this.fitTo(x0, y0, x1 - x0, y1 - y0, true);
    }
  }

  // --- layout ---

  private async relayout(fit: boolean) {
    const graph = this.graph;
    if (!graph) return;
    const token = ++this.token;

    const visible = graph.nodes.filter((n) => this.showImplicit || !n.implicit);
    const ids = new Set(visible.map((n) => n.id));
    const edges = graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target));

    const sizes = new Map<string, { width: number; height: number }>();
    for (const node of visible) sizes.set(node.id, this.sizeOf(node));

    const root: ElkNode = {
      id: 'root',
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': this.direction,
        'elk.edgeRouting': 'ORTHOGONAL',
        'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
        'elk.layered.spacing.nodeNodeBetweenLayers': this.direction === 'DOWN' ? '48' : '64',
        'elk.spacing.nodeNode': '26',
        'elk.spacing.edgeNode': '18',
        'elk.spacing.edgeEdge': '12',
        'elk.layered.spacing.edgeNodeBetweenLayers': '18',
        'elk.padding': '[top=24,left=24,bottom=24,right=24]',
      },
      children: visible.map((n) => ({ id: n.id, ...sizes.get(n.id)! })),
      edges: edges.map((e): ElkExtendedEdge => ({ id: e.id, sources: [e.source], targets: [e.target] })),
    };

    this.showMessage('Colocando el grafo…', 'busy');
    let result: ElkNode;
    try {
      result = await this.elk.layout(root);
    } catch (error) {
      if (token === this.token) this.showMessage(`No se pudo calcular el layout: ${String(error)}`, 'error');
      return;
    }
    if (token !== this.token) return; // a newer layout superseded this one

    this.showMessage('', 'none');
    this.render(visible, edges, result);
    this.highlightRule(this.ruleFilter);
    if (fit) this.fit();
  }

  private sizeOf(node: GraphNode): { width: number; height: number } {
    const bold = this.font(true);
    const normal = this.font(false);
    const small = this.font(false, 10.5);
    let width = MIN_W;

    this.measure.font = bold;
    let header = this.measure.measureText(node.type).width;
    if (node.rule) {
      this.measure.font = small;
      header += 18 + this.measure.measureText(node.rule).width;
    }
    width = Math.max(width, header + PAD_X * 2);

    this.measure.font = bold;
    if (node.name) width = Math.max(width, Math.min(this.measure.measureText(node.name).width, MAX_TEXT_W) + PAD_X * 2);

    this.measure.font = normal;
    for (const attribute of node.attributes) {
      if (attribute.name === 'name' && node.name) continue;
      const text = `${attribute.name} = ${attribute.value}`;
      width = Math.max(width, Math.min(this.measure.measureText(text).width, MAX_TEXT_W) + PAD_X * 2);
    }

    const rows = node.attributes.filter((a) => !(a.name === 'name' && node.name)).length;
    const height = HEADER_H + (node.name ? TITLE_H : 0) + (rows ? rows * ROW_H + BODY_PAD * 2 : node.name ? 4 : 10);
    return { width: Math.ceil(width), height };
  }

  private font(bold: boolean, size = 12): string {
    const mono = getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || 'monospace';
    return `${bold ? '600 ' : ''}${size}px ${mono}`;
  }

  private fit_text(text: string, font: string, max: number): string {
    this.measure.font = font;
    if (this.measure.measureText(text).width <= max) return text;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (this.measure.measureText(text.slice(0, mid) + '…').width <= max) lo = mid;
      else hi = mid - 1;
    }
    return text.slice(0, lo) + '…';
  }

  // --- rendering ---

  private render(nodes: GraphNode[], edges: GraphEdge[], layout: ElkNode) {
    this.laid.clear();
    this.nodeEls.clear();
    this.edgeEls = [];
    this.edgeLayer.replaceChildren();
    this.nodeLayer.replaceChildren();

    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (const child of layout.children ?? []) {
      const node = byId.get(child.id);
      if (node) {
        this.laid.set(child.id, { node, x: child.x ?? 0, y: child.y ?? 0, width: child.width ?? MIN_W, height: child.height ?? 40 });
      }
    }
    this.bounds = { width: layout.width ?? 0, height: layout.height ?? 0 };

    const edgeById = new Map(edges.map((e) => [e.id, e]));
    for (const laidEdge of (layout.edges ?? []) as ElkExtendedEdge[]) {
      const edge = edgeById.get(laidEdge.id);
      const section = laidEdge.sections?.[0];
      if (!edge || !section) continue;
      const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
      const group = el('g', { class: `edge ${edge.kind}`, 'data-id': edge.id });
      const title = el('title');
      title.textContent = `${this.laid.get(edge.source)?.node.type} —${edge.name}→ ${this.laid.get(edge.target)?.node.type}`;
      const path = el('path', { d: roundedPath(points, 7), fill: 'none' });
      if (edge.kind === 'containment') path.setAttribute('marker-start', 'url(#m-diamond)');
      else path.setAttribute('marker-end', 'url(#m-arrow)');
      group.append(title, path, this.edgeLabel(edge.name, points));
      this.edgeLayer.append(group);
      this.edgeEls.push({ edge, el: group });
    }

    for (const box of this.laid.values()) {
      const group = this.renderNode(box);
      this.nodeLayer.append(group);
      this.nodeEls.set(box.node.id, group);
    }
    if (this.selected) this.select(this.selected);
  }

  private edgeLabel(text: string, points: { x: number; y: number }[]): SVGGElement {
    const mid = midpoint(points);
    this.measure.font = this.font(false, 10.5);
    const width = this.measure.measureText(text).width + 8;
    const group = el('g', { class: 'edge-label', transform: `translate(${mid.x},${mid.y})` });
    group.append(
      el('rect', { x: -width / 2, y: -8, width, height: 16, rx: 4 }),
      el('text', { 'text-anchor': 'middle', y: 3.5 }, text),
    );
    return group;
  }

  private renderNode(box: Laid): SVGGElement {
    const { node, width, height } = box;
    const classes = ['node'];
    if (node.external) classes.push('external');
    if (node.implicit) classes.push('implicit');
    if (node.abstract) classes.push('abstract');
    const group = el('g', { class: classes.join(' '), 'data-id': node.id, transform: `translate(${box.x},${box.y})` });

    const color = typeColor(node.type);
    group.append(
      el('rect', { class: 'frame', width, height, rx: 7 }),
      el('path', { class: 'head', d: `M0 ${HEADER_H} V7 a7 7 0 0 1 7 -7 H${width - 7} a7 7 0 0 1 7 7 V${HEADER_H} Z`, fill: node.external ? 'var(--ext-head)' : color }),
    );
    const type = el('text', { class: 'type', x: PAD_X, y: HEADER_H / 2 + 4 }, node.type);
    group.append(type);
    if (node.rule) {
      const rule = el('text', { class: 'rule-tag', x: width - PAD_X, y: HEADER_H / 2 + 3.5, 'text-anchor': 'end' }, node.rule);
      group.append(rule);
    }

    let y = HEADER_H;
    if (node.name) {
      const shown = this.fit_text(node.name, this.font(true), width - PAD_X * 2);
      const title = el('text', { class: 'title', x: PAD_X, y: y + TITLE_H / 2 + 4 }, shown);
      if (shown !== node.name) title.append(el('title', {}, node.name));
      group.append(title);
      y += TITLE_H;
    }
    const rows = node.attributes.filter((a) => !(a.name === 'name' && node.name));
    if (rows.length) {
      group.append(el('line', { class: 'sep', x1: 0, x2: width, y1: y, y2: y }));
      y += BODY_PAD;
      for (const attribute of rows) {
        const full = `${attribute.name} = ${attribute.value}`;
        const shown = this.fit_text(full, this.font(false), width - PAD_X * 2);
        const row = el('text', { class: 'attr', x: PAD_X, y: y + ROW_H / 2 + 3.5 });
        if (shown === full) {
          row.append(el('tspan', { class: 'attr-name' }, `${attribute.name} `), el('tspan', { class: 'attr-eq' }, '= '), el('tspan', { class: 'attr-value' }, attribute.value));
        } else {
          row.append(shown, el('title', {}, full));
        }
        group.append(row);
        y += ROW_H;
      }
    }
    return group;
  }

  // --- pan / zoom / selection ---

  private bindInteraction() {
    let drag: { x: number; y: number; vx: number; vy: number; moved: boolean; target: Element } | null = null;

    this.svg.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      // remember what was pressed: with pointer capture the release event targets the svg itself
      drag = { x: event.clientX, y: event.clientY, vx: this.view.x, vy: this.view.y, moved: false, target: event.target as Element };
      this.svg.setPointerCapture(event.pointerId);
    });
    this.svg.addEventListener('pointermove', (event) => {
      if (!drag) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      this.svg.classList.add('panning');
      this.view.x = drag.vx + dx;
      this.view.y = drag.vy + dy;
      this.applyView();
    });
    const end = (event: PointerEvent) => {
      if (!drag) return;
      const { moved, target: pressed } = drag;
      drag = null;
      this.svg.classList.remove('panning');
      if (this.svg.hasPointerCapture(event.pointerId)) this.svg.releasePointerCapture(event.pointerId);
      if (moved) return;
      const id = pressed.closest('.node')?.getAttribute('data-id') ?? null;
      this.callbacks.onSelect(id);
    };
    this.svg.addEventListener('pointerup', end);
    this.svg.addEventListener('pointercancel', end);

    this.svg.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        const rect = this.svg.getBoundingClientRect();
        const px = event.clientX - rect.left;
        const py = event.clientY - rect.top;
        const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0016));
        const k = Math.min(3, Math.max(0.04, this.view.k * factor));
        this.view.x = px - ((px - this.view.x) / this.view.k) * k;
        this.view.y = py - ((py - this.view.y) / this.view.k) * k;
        this.view.k = k;
        this.applyView();
      },
      { passive: false },
    );
  }

  private fitTo(x: number, y: number, width: number, height: number, animate: boolean) {
    const rect = this.container.getBoundingClientRect();
    if (width <= 0 || height <= 0 || rect.width <= 0) return;
    const margin = 32;
    const k = Math.min(1.25, Math.max(0.04, Math.min((rect.width - margin * 2) / width, (rect.height - margin * 2) / height)));
    this.view = {
      k,
      x: (rect.width - width * k) / 2 - x * k,
      y: (rect.height - height * k) / 2 - y * k,
    };
    this.applyView(animate);
  }

  private applyView(animate = false) {
    const { x, y, k } = this.view;
    if (animate) {
      this.viewport.classList.add('animate');
      window.setTimeout(() => this.viewport.classList.remove('animate'), 320);
    }
    this.viewport.setAttribute('transform', `translate(${x},${y}) scale(${k})`);
    this.svg.classList.toggle('zoomed-out', k < 0.5);
  }
}

/** Polyline with rounded corners. */
function roundedPath(points: { x: number; y: number }[], radius: number): string {
  if (points.length < 2) return '';
  let d = `M${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const current = points[i];
    const next = points[i + 1];
    const r = Math.min(radius, dist(prev, current) / 2, dist(current, next) / 2);
    const a = towards(current, prev, r);
    const b = towards(current, next, r);
    d += ` L${a.x} ${a.y} Q${current.x} ${current.y} ${b.x} ${b.y}`;
  }
  const last = points[points.length - 1];
  return `${d} L${last.x} ${last.y}`;
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function towards(from: { x: number; y: number }, to: { x: number; y: number }, by: number) {
  const d = dist(from, to) || 1;
  return { x: from.x + ((to.x - from.x) * by) / d, y: from.y + ((to.y - from.y) * by) / d };
}

/** Point halfway along the polyline. */
function midpoint(points: { x: number; y: number }[]) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += dist(points[i - 1], points[i]);
  let remaining = total / 2;
  for (let i = 1; i < points.length; i++) {
    const segment = dist(points[i - 1], points[i]);
    if (remaining <= segment) return towards(points[i - 1], points[i], remaining);
    remaining -= segment;
  }
  return points[points.length - 1];
}
