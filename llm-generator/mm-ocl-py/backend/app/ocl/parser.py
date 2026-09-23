from dataclasses import dataclass
from pathlib import Path

from lark import Lark, Tree
from lark.exceptions import LarkError, UnexpectedInput

from .errors import OclParseError

_GRAMMAR_PATH = Path(__file__).parent / "grammar.lark"
_parser: Lark | None = None


def _get_parser() -> Lark:
    global _parser
    if _parser is None:
        _parser = Lark(
            _GRAMMAR_PATH.read_text(),
            start="start",
            parser="lalr",
            maybe_placeholders=False,
            propagate_positions=True,
        )
    return _parser


@dataclass
class ParsedConstraint:
    context_class: str
    name: str
    body: Tree
    source: str


def parse_constraints(text: str) -> list[ParsedConstraint]:
    """Parse one or more `context X inv Name: <expr>` blocks from raw OCL text."""
    if not text.strip():
        return []
    parser = _get_parser()
    try:
        tree = parser.parse(text)
    except UnexpectedInput as e:
        raise OclParseError(str(e), getattr(e, "line", None), getattr(e, "column", None)) from e
    except LarkError as e:
        raise OclParseError(str(e)) from e

    constraints: list[ParsedConstraint] = []
    counters: dict[str, int] = {}
    for node in tree.children:
        # node.children: [class_name, inv_name?, body]
        if len(node.children) == 3:
            class_tok, name_tok, body = node.children
            name = str(name_tok)
        else:
            class_tok, body = node.children
            name = None
        class_name = str(class_tok)
        if name is None:
            counters[class_name] = counters.get(class_name, 0) + 1
            name = f"inv{counters[class_name]}"
        start = body.meta.start_pos if hasattr(body, "meta") and not body.meta.empty else None
        end = body.meta.end_pos if hasattr(body, "meta") and not body.meta.empty else None
        source = text[start:end] if start is not None and end is not None else ""
        constraints.append(
            ParsedConstraint(context_class=class_name, name=name, body=body, source=source.strip())
        )
    return constraints


def parse_single_expression(text: str) -> Tree:
    """Parse a bare OCL expression (used for quick syntax checks), wrapping it in a dummy context."""
    wrapped = f"context __Dummy__ inv __check__: {text}"
    parsed = parse_constraints(wrapped)
    return parsed[0].body
