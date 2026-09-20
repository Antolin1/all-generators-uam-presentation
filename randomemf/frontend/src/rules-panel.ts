import type { Graph, GraphNode, RuleInfo, RuleItem, Trace, TraceNode } from './api';
import { typeColor } from './graph';

interface Callbacks {
  /** a rule application was chosen: show its object and the rule in the editor */
  onSelectApp(app: TraceNode): void;
  /** a feature assignment or chosen alternative was chosen */
  onSelectItem(app: TraceNode, item: RuleItem | undefined, rule: RuleInfo | undefined): void;
  /** a rule was chosen in the summary */
  onSelectRule(rule: string | null): void;
}

type Child = Node | string | null | false;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { class?: string; title?: string; text?: string; style?: string; data?: Record<string, string> } = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (props.class) element.className = props.class;
  if (props.title) element.title = props.title;
  if (props.text !== undefined) element.textContent = props.text;
  if (props.style) element.setAttribute('style', props.style);
  for (const [key, value] of Object.entries(props.data ?? {})) element.dataset[key] = value;
  for (const child of children) if (child) element.append(child);
  return element;
}

function put(parent: HTMLElement, ...children: Child[]) {
  for (const child of children) if (child) parent.append(child);
}

export class RulesPanel {
  private readonly tree: HTMLElement;
  private readonly summary: HTMLElement;
  private readonly java: HTMLElement;
  private readonly stats: HTMLElement;
  private readonly tabs: HTMLButtonElement[];
  private rules = new Map<string, RuleInfo>();
  private nodes = new Map<string, GraphNode>();
  private rows = new Map<string, HTMLElement>();
  private selectedRow: HTMLElement | null = null;
  private selectedRule: string | null = null;

  constructor(root: HTMLElement, private readonly callbacks: Callbacks) {
    this.tree = root.querySelector('#tab-tree')!;
    this.summary = root.querySelector('#tab-summary')!;
    this.java = root.querySelector('#tab-java')!;
    this.stats = root.querySelector('#rules-stats')!;
    this.tabs = [...root.querySelectorAll<HTMLButtonElement>('[role=tab]')];
    for (const tab of this.tabs) tab.addEventListener('click', () => this.showTab(tab.dataset.tab!));
    this.clear();
  }

  showTab(name: string) {
    for (const tab of this.tabs) tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
    this.tree.hidden = name !== 'tree';
    this.summary.hidden = name !== 'summary';
    this.java.hidden = name !== 'java';
  }

  clear() {
    this.rows.clear();
    this.selectedRow = null;
    this.stats.textContent = '';
    const empty = (text: string) => h('p', { class: 'empty', text });
    this.tree.replaceChildren(empty('Aquí verás, como un árbol, qué regla creó cada objeto, qué asignaciones hizo y qué alternativa eligió.'));
    this.summary.replaceChildren(empty('Aquí verás cuántas veces se aplicó cada regla.'));
    this.java.replaceChildren(empty('Aquí verás el Java que RandomEMF genera a partir de las reglas.'));
  }

  setData(trace: Trace, rules: RuleInfo[], graph: Graph, java: string) {
    this.rules = new Map(rules.map((r) => [r.name, r]));
    this.nodes = new Map(graph.nodes.map((n) => [n.id, n]));
    this.rows.clear();
    this.selectedRow = null;
    this.selectedRule = null;

    const counts = countApplications(trace.roots);
    const total = [...counts.values()].reduce((a, b) => a + b.applied, 0);
    this.stats.textContent = `${total} aplicaciones · ${[...counts.values()].filter((c) => c.applied > 0).length}/${rules.length} reglas usadas`;

    this.renderTree(trace, total);
    this.renderSummary(rules, counts, graph);
    this.java.replaceChildren(h('pre', { class: 'java', text: java }));
  }

  /** Highlights the row of an application (called when a node is selected in the graph). */
  selectApp(id: string | null, scroll = true) {
    this.selectedRow?.classList.remove('selected');
    this.selectedRow = null;
    if (!id) return;
    const row = this.rows.get(id);
    if (!row) return;
    for (let parent = row.parentElement; parent && parent !== this.tree; parent = parent.parentElement) {
      if (parent.classList.contains('tn')) parent.classList.remove('collapsed');
    }
    row.classList.add('selected');
    this.selectedRow = row;
    this.showTab('tree');
    if (scroll) row.scrollIntoView({ block: 'nearest' });
  }

  selectRuleInSummary(rule: string | null) {
    this.selectedRule = rule;
    for (const row of this.summary.querySelectorAll<HTMLElement>('tr[data-rule]')) {
      row.classList.toggle('selected', row.dataset.rule === rule);
    }
  }

  // --- tree ---

  private renderTree(trace: Trace, total: number) {
    const toolbar = h(
      'div',
      { class: 'tree-tools' },
      this.button('Expandir todo', () => this.setCollapsed(false)),
      this.button('Colapsar', () => this.setCollapsed(true)),
      h('span', { class: 'muted', text: 'Haz clic en una fila para verla en el grafo y en el editor.' }),
    );
    const body = h('div', { class: 'tree' });
    // big runs start collapsed below the first levels
    const collapseFrom = total > 250 ? 2 : Infinity;
    for (const root of trace.roots) body.append(this.treeNode(root, 0, collapseFrom));

    const children: Child[] = [toolbar, body];
    if (trace.resolutions.length) {
      const list = h('div', { class: 'resolutions' }, h('h3', { text: 'Referencias diferidas resueltas @(…)' }));
      for (const r of trace.resolutions) {
        const item = this.rules.get(r.rule)?.items[r.index];
        list.append(
          h(
            'div',
            { class: 'row' },
            h('b', { text: r.rule }),
            h('span', { class: 'feat', text: item?.feature ?? '' }),
            h('span', { class: 'obj', text: `${this.label(r.source)} → ${this.label(r.target)}` }),
          ),
        );
      }
      children.push(list);
    }
    this.tree.replaceChildren(...(children.filter(Boolean) as Node[]));
  }

  private treeNode(node: TraceNode, depth: number, collapseFrom: number): HTMLElement {
    const container = h('div', { class: 'tn', data: { kind: node.kind } });
    if (depth >= collapseFrom && node.children.length) container.classList.add('collapsed');

    const row = h('div', { class: `row ${node.kind}`, data: { id: node.id } });
    const caret = h('button', { class: 'caret', title: 'Plegar / desplegar' });
    if (!node.children.length) caret.classList.add('leaf');
    caret.addEventListener('click', (event) => {
      event.stopPropagation();
      container.classList.toggle('collapsed');
    });
    put(row, caret);

    const rule = this.rules.get(node.rule);
    if (node.kind === 'rule') {
      const object = node.object ? this.nodes.get(node.object) : undefined;
      put(row, 
        h('span', { class: 'dot', style: `background:${typeColor(object?.type ?? node.rule)}` }),
        h('b', { class: 'name', text: node.rule }),
        h('span', { class: 'arrow', text: '→' }),
        h('span', { class: 'chip', text: object?.type ?? rule?.eClass ?? '?' }),
        object?.name ? h('span', { class: 'obj', text: `“${object.name}”` }) : null,
        node.params && node.params.length ? h('span', { class: 'params', text: `(${node.params.join(', ')})` }) : null,
      );
    } else if (node.kind === 'feature') {
      const item = rule?.items[node.index ?? -1];
      put(row, 
        h('span', { class: 'feat', text: item?.feature ?? '?' }),
        h('span', { class: 'op', text: item?.op ?? '' }),
        h('code', { class: 'expr', title: item?.value ?? '', text: `${item?.ref ? '@(' : ''}${item?.value ?? ''}${item?.ref ? ')' : ''}${item?.times ? ' # ' + item.times : ''}` }),
        item?.op === '+=' ? h('span', { class: `count${node.count === 0 ? ' zero' : ''}`, text: `×${node.count}` }) : null,
      );
    } else {
      const item = rule?.items[node.index ?? -1];
      put(row, 
        h('span', { class: 'alt-tag', text: 'alter' }),
        h('b', { class: 'name', text: node.rule }),
        h('span', { class: 'arrow', text: '→' }),
        h('span', { class: 'muted', text: `alternativa ${(node.index ?? 0) + 1}/${rule?.items.length ?? '?'}` }),
        h('code', { class: 'expr', title: item?.value ?? '', text: `${item?.value ?? ''}${item?.priority ? ' # ' + item.priority : ''}` }),
      );
    }

    row.addEventListener('click', () => {
      this.selectedRow?.classList.remove('selected');
      row.classList.add('selected');
      this.selectedRow = row;
      if (node.kind === 'rule') this.callbacks.onSelectApp(node);
      else this.callbacks.onSelectItem(node, rule?.items[node.index ?? -1], rule);
    });
    this.rows.set(node.id, row);
    container.append(row);

    if (node.children.length) {
      const kids = h('div', { class: 'kids' });
      for (const child of node.children) kids.append(this.treeNode(child, depth + 1, collapseFrom));
      container.append(kids);
    }
    return container;
  }

  private setCollapsed(collapsed: boolean) {
    for (const node of this.tree.querySelectorAll<HTMLElement>('.tn')) {
      if (node.querySelector(':scope > .kids')) node.classList.toggle('collapsed', collapsed);
    }
    // keep the top level open so the tree never looks empty
    if (collapsed) this.tree.querySelector('.tree > .tn')?.classList.remove('collapsed');
  }

  private label(id: string | null): string {
    const node = id ? this.nodes.get(id) : undefined;
    return node ? `${node.type}${node.name ? ' “' + node.name + '”' : ''}` : '∅';
  }

  // --- summary ---

  private renderSummary(rules: RuleInfo[], counts: Map<string, Counts>, graph: Graph) {
    const table = h('table', { class: 'summary' });
    table.append(
      h('thead', {}, h('tr', {}, h('th', { text: 'Regla' }), h('th', { text: 'Crea' }), h('th', { class: 'num', text: 'Aplicada' }), h('th', { text: 'Reparto de alternativas' }))),
    );
    const body = h('tbody');
    for (const rule of rules) {
      const c = counts.get(rule.name) ?? { applied: 0, chosen: [] };
      const row = h('tr', { data: { rule: rule.name }, class: c.applied === 0 ? 'unused' : '' });
      row.append(
        h('td', {}, h('b', { text: rule.name }), rule.kind === 'alter' ? h('span', { class: 'alt-tag', text: 'alter' }) : null, rule.entry ? h('span', { class: 'entry-tag', text: 'raíz' }) : null),
        h('td', {}, h('span', { class: 'chip', text: rule.eClass ?? '?' })),
        h('td', { class: 'num', text: String(c.applied) }),
        h('td', {}, rule.kind === 'alter' ? this.alternatives(rule, c) : null),
      );
      row.addEventListener('click', () => {
        const next = this.selectedRule === rule.name ? null : rule.name;
        this.selectRuleInSummary(next);
        this.callbacks.onSelectRule(next);
      });
      body.append(row);
    }
    table.append(body);

    const byType = h('div', { class: 'types' }, h('h3', { text: 'Objetos por tipo' }));
    const list = h('div', { class: 'type-list' });
    for (const [type, count] of Object.entries(graph.stats.byType).sort((a, b) => b[1] - a[1])) {
      list.append(h('span', { class: 'type-count' }, h('span', { class: 'dot', style: `background:${typeColor(type)}` }), type, h('b', { text: String(count) })));
    }
    byType.append(list);
    this.summary.replaceChildren(table, byType);
  }

  private alternatives(rule: RuleInfo, counts: Counts): HTMLElement {
    const total = counts.chosen.reduce((a, b) => a + b, 0) || 1;
    const box = h('div', { class: 'alts' });
    rule.items.forEach((item, index) => {
      const n = counts.chosen[index] ?? 0;
      const pct = Math.round((n / total) * 100);
      box.append(
        h(
          'div',
          { class: 'alt-row' },
          h('code', { class: 'expr', title: item.value ?? '', text: `${item.value ?? ''}${item.priority ? ' # ' + item.priority : ''}` }),
          h('span', { class: 'bar' }, h('i', { style: `width:${pct}%` })),
          h('span', { class: 'muted', text: `${n} (${pct}%)` }),
        ),
      );
    });
    return box;
  }

  private button(text: string, onClick: () => void): HTMLButtonElement {
    const button = h('button', { class: 'ghost small', text });
    button.type = 'button';
    button.addEventListener('click', onClick);
    return button;
  }
}

interface Counts {
  applied: number;
  /** how many times each alternative was chosen (alter rules) */
  chosen: number[];
}

function countApplications(roots: TraceNode[]): Map<string, Counts> {
  const counts = new Map<string, Counts>();
  const visit = (node: TraceNode) => {
    if (node.kind !== 'feature') {
      const entry = counts.get(node.rule) ?? { applied: 0, chosen: [] };
      entry.applied++;
      if (node.kind === 'alt' && node.index !== undefined) entry.chosen[node.index] = (entry.chosen[node.index] ?? 0) + 1;
      counts.set(node.rule, entry);
    }
    node.children.forEach(visit);
  };
  roots.forEach(visit);
  return counts;
}
