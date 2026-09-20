import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentOnInput } from '@codemirror/language';
import { lintGutter, setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { EditorState, RangeSetBuilder, StateEffect, StateField, type Extension } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  drawSelection,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import type { Issue, Range } from './api';
import { rcoreLanguage } from './rcore-lang';

interface Highlights {
  /** whole rule: tinted lines */
  rule: Range | null;
  /** a feature assignment or alternative inside the rule: marked text */
  items: Range[];
}

const setHighlights = StateEffect.define<Highlights>();

const highlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setHighlights)) return build(tr.state, effect.value);
    }
    // typing invalidates positions computed from the previous analysis
    return tr.docChanged ? Decoration.none : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

function build(state: EditorState, highlights: Highlights): DecorationSet {
  const doc = state.doc;
  const clamp = (n: number) => Math.max(0, Math.min(n, doc.length));
  const decorations: { from: number; to: number; deco: Decoration }[] = [];
  if (highlights.rule) {
    const from = doc.lineAt(clamp(highlights.rule.offset)).number;
    const to = doc.lineAt(clamp(highlights.rule.offset + highlights.rule.length)).number;
    for (let line = from; line <= to; line++) {
      const pos = doc.line(line).from;
      decorations.push({ from: pos, to: pos, deco: Decoration.line({ class: 'cm-rule-line' }) });
    }
  }
  for (const item of highlights.items) {
    const from = clamp(item.offset);
    const to = clamp(item.offset + item.length);
    if (to > from) decorations.push({ from, to, deco: Decoration.mark({ class: 'cm-rule-item' }) });
  }
  decorations.sort((a, b) => a.from - b.from || a.deco.startSide - b.deco.startSide);
  const builder = new RangeSetBuilder<Decoration>();
  for (const d of decorations) builder.add(d.from, d.to, d.deco);
  return builder.finish();
}

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--surface)', color: 'var(--text)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', fontSize: '13px', lineHeight: '1.55' },
  '.cm-content': { caretColor: 'var(--accent)', padding: '8px 0' },
  '.cm-gutters': {
    backgroundColor: 'var(--surface)',
    color: 'var(--text-faint)',
    border: 'none',
    borderRight: '1px solid var(--border)',
  },
  '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--active-line)', color: 'var(--text)' },
  '&.cm-focused': { outline: 'none' },
  '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--accent)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--selection) !important' },
  '.cm-rule-line': { backgroundColor: 'var(--hl-rule)' },
  '.cm-rule-item': { backgroundColor: 'var(--hl-item)', borderRadius: '3px', boxShadow: '0 0 0 1px var(--hl-item-border)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--surface-raised)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: '6px',
  },
  '.cm-diagnostic': { padding: '4px 8px', fontFamily: 'var(--sans)', fontSize: '12.5px' },
});

export interface EditorHandle {
  text(): string;
  setText(text: string): void;
  setIssues(issues: Issue[]): void;
  highlight(rule: Range | null, items: Range[], scroll?: boolean): void;
  clearHighlight(): void;
  goTo(offset: number): void;
}

export function createEditor(
  parent: HTMLElement,
  initial: string,
  handlers: { onChange(): void; onCursor(offset: number): void; onRun(): void },
): EditorHandle {
  const extensions: Extension[] = [
    lineNumbers(),
    history(),
    drawSelection(),
    indentOnInput(),
    bracketMatching(),
    highlightActiveLine(),
    lintGutter(),
    rcoreLanguage,
    highlightField,
    theme,
    keymap.of([
      { key: 'Mod-Enter', run: () => (handlers.onRun(), true) },
      ...defaultKeymap,
      ...historyKeymap,
      indentWithTab,
    ]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) handlers.onChange();
      if (update.selectionSet || update.docChanged) {
        handlers.onCursor(update.state.selection.main.head);
      }
    }),
  ];

  const view = new EditorView({ parent, state: EditorState.create({ doc: initial, extensions }) });

  return {
    text: () => view.state.doc.toString(),
    setText(text) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: 0 } });
    },
    setIssues(issues) {
      const length = view.state.doc.length;
      const diagnostics: Diagnostic[] = issues.map((issue) => {
        const from = Math.min(issue.offset, length);
        const to = Math.min(Math.max(issue.offset + Math.max(issue.length, 1), from + 1), length);
        return { from, to: Math.max(to, from), severity: issue.severity, message: issue.message };
      });
      view.dispatch(setDiagnostics(view.state, diagnostics));
    },
    highlight(rule, items, scroll = true) {
      view.dispatch({ effects: setHighlights.of({ rule, items }) });
      const target = items[0] ?? rule;
      if (scroll && target) {
        const pos = Math.min(target.offset, view.state.doc.length);
        view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
      }
    },
    clearHighlight() {
      view.dispatch({ effects: setHighlights.of({ rule: null, items: [] }) });
    },
    goTo(offset) {
      const pos = Math.min(offset, view.state.doc.length);
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
      view.focus();
    },
  };
}
