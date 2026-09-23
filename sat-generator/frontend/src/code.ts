// Visores de solo lectura con resaltado de sintaxis: OCL (restricciones) y XML (XMI exportado).
import { xml } from '@codemirror/lang-xml';
import { HighlightStyle, StreamLanguage, bracketMatching, syntaxHighlighting } from '@codemirror/language';
import { EditorState, type Extension } from '@codemirror/state';
import { drawSelection, EditorView, lineNumbers } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

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
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--selection) !important' },
  '.cm-issue-line': { backgroundColor: 'var(--issue-line)', boxShadow: 'inset 3px 0 0 var(--danger)' },
  '.cm-focus-line': { backgroundColor: 'var(--hl-item)' },
});

// ---------- viewers ----------

export type Language = 'xml' | 'ocl';

function languageExtension(language: Language): Extension {
  return language === 'xml' ? xml() : ocl;
}

/** A read-only, syntax-highlighted view of some text with line numbers. */
export class CodeView {
  private readonly view: EditorView;

  constructor(parent: HTMLElement, language: Language) {
    this.view = new EditorView({
      parent,
      state: EditorState.create({
        doc: '',
        extensions: [lineNumbers(), drawSelection(), bracketMatching(), languageExtension(language), syntaxHighlighting(style), theme, EditorState.readOnly.of(true), EditorView.editable.of(false)],
      }),
    });
  }

  setText(text: string) {
    if (this.view.state.doc.toString() === text) return;
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: text } });
  }

  /** The editor needs a re-measure when it was created while hidden. */
  refresh() {
    this.view.requestMeasure();
  }
}
