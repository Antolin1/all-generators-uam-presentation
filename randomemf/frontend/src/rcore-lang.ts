import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

const KEYWORDS = new Set([
  'package', 'import', 'static', 'extension', 'generator', 'for', 'in', 'alter',
  'if', 'else', 'switch', 'case', 'default', 'while', 'do', 'val', 'var', 'new', 'return',
  'throw', 'try', 'catch', 'finally', 'instanceof', 'as', 'typeof', 'synchronized', 'extends', 'super',
]);
const SPECIAL = new Set(['this', 'it', 'self', 'model', 'depth', 'count']);
const ATOMS = new Set(['true', 'false', 'null']);

interface State {
  comment: boolean;
}

// A light tokenizer for rcore: rule syntax on top of Xbase expressions (Java-like).
const rcore = StreamLanguage.define<State>({
  name: 'rcore',
  startState: () => ({ comment: false }),
  token(stream, state) {
    if (state.comment) {
      while (!stream.eol()) {
        if (stream.match('*/')) {
          state.comment = false;
          break;
        }
        stream.next();
      }
      return 'comment';
    }
    if (stream.eatSpace()) return null;
    if (stream.match('//')) {
      stream.skipToEnd();
      return 'comment';
    }
    if (stream.match('/*')) {
      state.comment = true;
      while (!stream.eol()) {
        if (stream.match('*/')) {
          state.comment = false;
          break;
        }
        stream.next();
      }
      return 'comment';
    }
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/) || stream.match(/^'(?:[^'\\]|\\.)*'?/)) return 'string';
    if (stream.match(/^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[lLfFdD]?/)) return 'number';
    if (stream.match(/^(?::=|\+=|->|=>|\.\.|::|\?:|==|!=|<=|>=|&&|\|\||[-+*/%<>=!?:])/)) return 'operator';
    if (stream.match(/^[#@|]/)) return 'meta';
    if (stream.match(/^[A-Za-z_$][\w$]*/)) {
      const word = stream.current();
      if (KEYWORDS.has(word)) return 'keyword';
      if (ATOMS.has(word)) return 'atom';
      if (SPECIAL.has(word)) return 'special';
      return /^[A-Z]/.test(word) ? 'typeName' : 'variableName';
    }
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: '//', block: { open: '/*', close: '*/' } } },
  tokenTable: {
    special: t.special(t.variableName),
  },
});

const style = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--syn-keyword)', fontWeight: '600' },
  { tag: t.atom, color: 'var(--syn-atom)' },
  { tag: t.number, color: 'var(--syn-number)' },
  { tag: t.string, color: 'var(--syn-string)' },
  { tag: t.comment, color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: t.operator, color: 'var(--syn-operator)' },
  { tag: t.meta, color: 'var(--syn-operator)', fontWeight: '700' },
  { tag: t.typeName, color: 'var(--syn-type)' },
  { tag: t.special(t.variableName), color: 'var(--syn-special)' },
]);

export const rcoreLanguage = [rcore, syntaxHighlighting(style)];
