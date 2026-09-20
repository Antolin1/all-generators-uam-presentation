// Editores y visores con formato: Python (módulo Pydantic y script del LLM), XML (XMI) y OCL.
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { python, pythonLanguage } from '@codemirror/lang-python';
import { xml } from '@codemirror/lang-xml';
import { HighlightStyle, StreamLanguage, bracketMatching, syntaxHighlighting } from '@codemirror/language';
import { EditorState, RangeSetBuilder, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view';
import { highlightCode, tagHighlighter, tags as t } from '@lezer/highlight';

// ---------- OCL ----------

const OCL_KEYWORDS = new Set(['context', 'inv', 'pre', 'post', 'def', 'if', 'then', 'else', 'endif', 'let', 'in', 'and', 'or', 'xor', 'not', 'implies']);
const OCL_ATOMS = new Set(['true', 'false', 'null', 'invalid']);

const ocl = StreamLanguage.define<{ afterArrow: boolean }>({
  name: 'ocl',
  startState: () => ({ afterArrow: false }),
  token(stream, state) {
    if (stream.eatSpace()) return null;
    if (stream.match('--')) {
      stream.skipToEnd();
      return 'comment';
    }
    if (stream.match(/^'(?:[^'\\]|\\.)*'?/)) return 'string';
    if (stream.match(/^\d+(?:\.\d+)?/)) return 'number';
    if (stream.match('->')) {
      state.afterArrow = true;
      return 'operator';
    }
    if (stream.match(/^(?:<>|<=|>=|\.\.|::|[-+*/<>=|])/)) return 'operator';
    if (stream.match(/^[A-Za-z_][\w]*/)) {
      const word = stream.current();
      const wasArrow = state.afterArrow;
      state.afterArrow = false;
      if (wasArrow) return 'special'; // a collection operation: forAll, select, size...
      if (OCL_KEYWORDS.has(word)) return 'keyword';
      if (OCL_ATOMS.has(word)) return 'atom';
      if (word === 'self') return 'self';
      return /^[A-Z]/.test(word) ? 'typeName' : 'variableName';
    }
    state.afterArrow = false;
    stream.next();
    return null;
  },
  tokenTable: { special: t.function(t.variableName), self: t.self },
});

// ---------- highlight: colors come from the page's CSS variables (light and dark) ----------

const style = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.definitionKeyword, t.operatorKeyword], color: 'var(--syn-keyword)', fontWeight: '600' },
  { tag: [t.atom, t.bool, t.null, t.self], color: 'var(--syn-atom)' },
  { tag: t.number, color: 'var(--syn-number)' },
  { tag: [t.string, t.special(t.string), t.attributeValue], color: 'var(--syn-string)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.operator, t.punctuation, t.angleBracket], color: 'var(--syn-operator)' },
  { tag: [t.className, t.typeName, t.definition(t.className)], color: 'var(--syn-type)' },
  { tag: [t.function(t.variableName), t.function(t.definition(t.variableName)), t.definition(t.function(t.variableName))], color: 'var(--syn-func)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--syn-prop)' },
  { tag: [t.meta, t.tagName], color: 'var(--syn-tag)' },
  { tag: t.processingInstruction, color: 'var(--syn-comment)' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--surface)', color: 'var(--text)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', fontSize: '12.5px', lineHeight: '1.6', overflow: 'auto' },
  '.cm-content': { caretColor: 'var(--accent)', padding: '8px 0' },
  '.cm-gutters': { backgroundColor: 'var(--surface)', color: 'var(--text-faint)', border: 'none', borderRight: '1px solid var(--border)' },
  '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--active-line)', color: 'var(--text)' },
  '&.cm-focused': { outline: 'none' },
  '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--accent)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--selection) !important' },
  '.cm-issue-line': { backgroundColor: 'var(--issue-line)', boxShadow: 'inset 3px 0 0 var(--danger)' },
  '.cm-focus-line': { backgroundColor: 'var(--hl-item)' },
});

// ---------- line marks (issues and the line that was just jumped to) ----------

interface Marks {
  issues: number[];
  focus: number | null;
}
const setMarks = StateEffect.define<Marks>();

const marksField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setMarks)) {
        const doc = tr.state.doc;
        const lines = new Map<number, string>();
        for (const n of effect.value.issues) if (n >= 1 && n <= doc.lines) lines.set(n, 'cm-issue-line');
        const focus = effect.value.focus;
        if (focus !== null && focus >= 1 && focus <= doc.lines) lines.set(focus, `${lines.get(focus) ?? ''} cm-focus-line`.trim());
        const builder = new RangeSetBuilder<Decoration>();
        for (const n of [...lines.keys()].sort((a, b) => a - b)) builder.add(doc.line(n).from, doc.line(n).from, Decoration.line({ class: lines.get(n)! }));
        return builder.finish();
      }
    }
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

// ---------- viewers ----------

export type Language = 'python' | 'xml' | 'ocl' | 'text';

function languageExtension(language: Language): Extension {
  return language === 'python' ? python() : language === 'xml' ? xml() : language === 'ocl' ? ocl : [];
}

function baseExtensions(language: Language): Extension[] {
  return [lineNumbers(), drawSelection(), bracketMatching(), languageExtension(language), syntaxHighlighting(style), marksField, theme];
}

/** A read-only, syntax-highlighted view of some code with line numbers, where lines can be marked and jumped to. */
export class CodeView {
  private readonly view: EditorView;
  private issues: number[] = [];

  constructor(parent: HTMLElement, language: Language) {
    this.view = new EditorView({
      parent,
      state: EditorState.create({ doc: '', extensions: [...baseExtensions(language), EditorState.readOnly.of(true), EditorView.editable.of(false)] }),
    });
  }

  setText(text: string) {
    if (this.view.state.doc.toString() === text) return;
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: text } });
  }

  /** Lines to tint red (the failing ones). */
  setIssueLines(lines: number[]) {
    this.issues = lines;
    this.view.dispatch({ effects: setMarks.of({ issues: lines, focus: null }) });
  }

  focusLine(line: number) {
    if (line < 1 || line > this.view.state.doc.lines) return;
    this.view.dispatch({ effects: [setMarks.of({ issues: this.issues, focus: line }), EditorView.scrollIntoView(this.view.state.doc.line(line).from, { y: 'center' })] });
  }

  /** The editor needs a re-measure when it was created while hidden. */
  refresh() {
    this.view.requestMeasure();
  }
}

/** The OCL constraints editor. */
export function createOclEditor(parent: HTMLElement, initial: string, onChange: (text: string) => void): { text(): string; setText(text: string): void } {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: initial,
      extensions: [
        ...baseExtensions('ocl'),
        history(),
        highlightActiveLine(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChange(update.state.doc.toString());
        }),
      ],
    }),
  });
  return {
    text: () => view.state.doc.toString(),
    setText(text) {
      if (view.state.doc.toString() === text) return;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    },
  };
}

// ---------- static highlighted text (for code shown inside other content, e.g. the prompts) ----------

const staticHighlighter = tagHighlighter([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.definitionKeyword, t.operatorKeyword], class: 'tok-keyword' },
  { tag: [t.atom, t.bool, t.null, t.self], class: 'tok-atom' },
  { tag: t.number, class: 'tok-number' },
  { tag: [t.string, t.special(t.string)], class: 'tok-string' },
  { tag: [t.comment, t.lineComment, t.blockComment], class: 'tok-comment' },
  { tag: [t.operator, t.punctuation], class: 'tok-operator' },
  { tag: [t.className, t.typeName, t.definition(t.className)], class: 'tok-type' },
  { tag: [t.function(t.variableName), t.function(t.definition(t.variableName)), t.definition(t.function(t.variableName))], class: 'tok-func' },
  { tag: [t.propertyName, t.attributeName], class: 'tok-prop' },
]);

/** Python source as highlighted DOM nodes (spans with `tok-*` classes), without creating an editor. */
export function highlightPython(code: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const put = (text: string, classes: string) => {
    if (!classes) fragment.append(text);
    else {
      const span = document.createElement('span');
      span.className = classes;
      span.textContent = text;
      fragment.append(span);
    }
  };
  highlightCode(code, pythonLanguage.parser.parse(code), staticHighlighter, put, () => fragment.append('\n'));
  return fragment;
}
