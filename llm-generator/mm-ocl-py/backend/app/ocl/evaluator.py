"""Tree-walking evaluator for the OCL subset parsed by parser.py.

Values in this interpreter are plain Python values: numbers, strings, bools,
None, pyecore model objects (anything with an `eClass` attribute), Python
lists (used to represent every flavour of OCL collection - Set/Bag/Sequence/
OrderedSet are not distinguished), and `OclTypeRef` for bare type names used
with `allInstances()`, `oclIsKindOf()`, `oclIsTypeOf()` and `oclAsType()`.
"""
from __future__ import annotations

import itertools
from collections.abc import Collection as ABCCollection
from dataclasses import dataclass, field, replace
from typing import Any

from lark import Token, Tree

from .errors import OclEvalError


@dataclass(frozen=True)
class OclTypeRef:
    name: str


@dataclass
class EvalContext:
    self_obj: Any
    env: dict[str, Any] = field(default_factory=dict)
    all_objects: list[Any] = field(default_factory=list)
    class_registry: dict[str, type] = field(default_factory=dict)

    def with_env(self, updates: dict[str, Any]) -> "EvalContext":
        new_env = dict(self.env)
        new_env.update(updates)
        return replace(self, env=new_env)


def is_model_object(v: Any) -> bool:
    return hasattr(v, "eClass")


def is_collection(v: Any) -> bool:
    if isinstance(v, (list, tuple, set, frozenset)):
        return True
    return isinstance(v, ABCCollection) and not isinstance(v, (str, bytes)) and not is_model_object(v)


def as_list(v: Any) -> list:
    if isinstance(v, list):
        return v
    return list(v)


def evaluate(tree: Tree | Token, ctx: EvalContext) -> Any:
    if isinstance(tree, Token):
        return str(tree)
    handler = _HANDLERS.get(tree.data)
    if handler is None:
        raise OclEvalError(f"Internal error: no evaluator for node '{tree.data}'")
    return handler(tree, ctx)


# ---------------------------------------------------------------------------
# Literals / primaries
# ---------------------------------------------------------------------------

def _self_expr(tree, ctx):
    return ctx.self_obj


def _true_expr(tree, ctx):
    return True


def _false_expr(tree, ctx):
    return False


def _null_expr(tree, ctx):
    return None


def _number_expr(tree, ctx):
    text = str(tree.children[0])
    if "." in text or "e" in text or "E" in text:
        return float(text)
    return int(text)


def _string_expr(tree, ctx):
    text = str(tree.children[0])
    return text[1:-1]


def _name_expr(tree, ctx):
    name = str(tree.children[0])
    if name in ctx.env:
        return ctx.env[name]
    if name in ctx.class_registry:
        return OclTypeRef(name)
    raise OclEvalError(f"Unknown identifier '{name}' (not a bound variable and not a class name)")


def _paren_expr(tree, ctx):
    return evaluate(tree.children[0], ctx)


def _neg_expr(tree, ctx):
    val = evaluate(tree.children[0], ctx)
    if not isinstance(val, (int, float)) or isinstance(val, bool):
        raise OclEvalError(f"Cannot negate non-numeric value {val!r}")
    return -val


def _not_expr(tree, ctx):
    val = evaluate(tree.children[0], ctx)
    if not isinstance(val, bool):
        raise OclEvalError(f"'not' expects a boolean, got {val!r}")
    return not val


def _collection_literal(tree, ctx):
    kind = str(tree.children[0])
    items: list[Any] = []
    for item in tree.children[1:]:
        if item.data == "range_item":
            lo = evaluate(item.children[0], ctx)
            hi = evaluate(item.children[1], ctx)
            items.extend(range(int(lo), int(hi) + 1))
        else:
            items.append(evaluate(item, ctx))
    if kind == "Set":
        items = _dedupe(items)
    return items


def _dedupe(items: list) -> list:
    result = []
    for item in items:
        if item not in result:
            result.append(item)
    return result


# ---------------------------------------------------------------------------
# Boolean / arithmetic chains
# ---------------------------------------------------------------------------

def _if_expr(tree, ctx):
    cond, then_branch, else_branch = tree.children
    cond_val = evaluate(cond, ctx)
    if not isinstance(cond_val, bool):
        raise OclEvalError(f"'if' condition must be boolean, got {cond_val!r}")
    return evaluate(then_branch, ctx) if cond_val else evaluate(else_branch, ctx)


def _implies_expr(tree, ctx):
    values = [evaluate(c, ctx) for c in tree.children]
    result = values[0]
    for v in values[1:]:
        result = (not result) or v
    return result


def _or_expr(tree, ctx):
    result = evaluate(tree.children[0], ctx)
    idx = 1
    while idx < len(tree.children):
        op = str(tree.children[idx])
        rhs = evaluate(tree.children[idx + 1], ctx)
        result = (result != rhs) if op == "xor" else (result or rhs)
        idx += 2
    return result


def _and_expr(tree, ctx):
    result = evaluate(tree.children[0], ctx)
    for c in tree.children[1:]:
        result = result and evaluate(c, ctx)
    return result


def _equality_expr(tree, ctx):
    result = evaluate(tree.children[0], ctx)
    idx = 1
    while idx < len(tree.children):
        op = str(tree.children[idx])
        rhs = evaluate(tree.children[idx + 1], ctx)
        result = (result == rhs) if op == "=" else (result != rhs)
        idx += 2
    return result


_REL_OPS = {
    "<": lambda a, b: a < b,
    ">": lambda a, b: a > b,
    "<=": lambda a, b: a <= b,
    ">=": lambda a, b: a >= b,
}


def _relational_expr(tree, ctx):
    result = evaluate(tree.children[0], ctx)
    idx = 1
    while idx < len(tree.children):
        op = str(tree.children[idx])
        rhs = evaluate(tree.children[idx + 1], ctx)
        result = _REL_OPS[op](result, rhs)
        idx += 2
    return result


def _additive_expr(tree, ctx):
    result = evaluate(tree.children[0], ctx)
    idx = 1
    while idx < len(tree.children):
        op = str(tree.children[idx])
        rhs = evaluate(tree.children[idx + 1], ctx)
        result = result + rhs if op == "+" else result - rhs
        idx += 2
    return result


def _mult_expr(tree, ctx):
    result = evaluate(tree.children[0], ctx)
    idx = 1
    while idx < len(tree.children):
        op = str(tree.children[idx])
        rhs = evaluate(tree.children[idx + 1], ctx)
        if op == "*":
            result = result * rhs
        elif op == "/":
            result = result / rhs
        elif op == "div":
            result = int(result) // int(rhs)
        elif op == "mod":
            result = int(result) % int(rhs)
        idx += 2
    return result


# ---------------------------------------------------------------------------
# let
# ---------------------------------------------------------------------------

def _let_expr(tree, ctx):
    *let_vars, body = tree.children
    for lv in let_vars:
        name = str(lv.children[0])
        # optional type annotation token may sit before the expr; the expr is always last
        value_expr = lv.children[-1]
        ctx = ctx.with_env({name: evaluate(value_expr, ctx)})
    return evaluate(body, ctx)


# ---------------------------------------------------------------------------
# postfix / navigation
# ---------------------------------------------------------------------------

def _postfix_expr(tree, ctx):
    value = evaluate(tree.children[0], ctx)
    for trailer in tree.children[1:]:
        value = _apply_trailer(value, trailer, ctx)
    return value


def _apply_trailer(base, trailer: Tree, ctx: EvalContext):
    # children: [DOT|ARROW token, NAME token, call_args?]
    name = str(trailer.children[1])
    call_args = trailer.children[2] if len(trailer.children) > 2 else None
    if call_args is None:
        return _navigate_property(base, name, ctx)
    arg_nodes = list(call_args.children)
    return _call_operation(base, name, arg_nodes, ctx)


def _navigate_property(base, name: str, ctx: EvalContext):
    if is_collection(base):
        results = []
        for item in as_list(base):
            r = _navigate_property(item, name, ctx)
            if is_collection(r):
                results.extend(as_list(r))
            else:
                results.append(r)
        return results
    if base is None:
        raise OclEvalError(f"Cannot navigate '.{name}' on an undefined (null) value")
    if is_model_object(base):
        if not hasattr(base, name):
            raise OclEvalError(f"'{name}' is not a feature of class '{base.eClass.name}'")
        val = getattr(base, name)
        if is_collection(val):
            return as_list(val)
        return val
    raise OclEvalError(f"Cannot navigate '.{name}' on value {base!r}")


def _eval_lambda(arg_tree: Tree, elements: list, ctx: EvalContext) -> list:
    """Evaluate a `lambda_arg` node over `elements`, returning (combo, result) pairs."""
    *varname_toks, body = arg_tree.children
    varnames = [str(t) for t in varname_toks]
    results = []
    if len(varnames) <= 1:
        combos = [(e,) for e in elements]
    else:
        combos = list(itertools.product(elements, repeat=len(varnames)))
    for combo in combos:
        local_ctx = ctx.with_env(dict(zip(varnames, combo)))
        results.append((combo, evaluate(body, local_ctx)))
    return results


def _call_operation(base, name: str, arg_nodes: list, ctx: EvalContext) -> Any:
    if name in ("oclIsKindOf", "oclIsTypeOf", "oclAsType"):
        type_val = evaluate(arg_nodes[0], ctx)
        if not isinstance(type_val, OclTypeRef):
            raise OclEvalError(f"{name}() expects a class name, got {type_val!r}")
        target = ctx.class_registry.get(type_val.name)
        if target is None:
            raise OclEvalError(f"Unknown class '{type_val.name}'")
        if name == "oclIsKindOf":
            return is_model_object(base) and isinstance(base, target)
        if name == "oclIsTypeOf":
            return is_model_object(base) and type(base) is target
        # oclAsType: a checked cast; just validate and pass the object through
        if not (is_model_object(base) and isinstance(base, target)):
            raise OclEvalError(f"oclAsType({type_val.name}): value is not a kind of {type_val.name}")
        return base

    if name == "allInstances":
        if not isinstance(base, OclTypeRef):
            raise OclEvalError("allInstances() must be called on a class name, e.g. Person.allInstances()")
        target = ctx.class_registry.get(base.name)
        if target is None:
            raise OclEvalError(f"Unknown class '{base.name}'")
        return [o for o in ctx.all_objects if isinstance(o, target)]

    if name == "oclIsUndefined":
        return base is None
    if name == "oclIsInvalid":
        return False

    if name in _LAMBDA_OPS:
        if not is_collection(base):
            raise OclEvalError(f"->{name}() expects a collection, got {base!r}")
        if not arg_nodes:
            raise OclEvalError(f"->{name}() requires a lambda argument, e.g. ({name.lower()} | expr)")
        return _LAMBDA_OPS[name](as_list(base), arg_nodes[0], ctx)

    args = [evaluate(a, ctx) for a in arg_nodes]

    if is_collection(base):
        return _collection_op(as_list(base), name, args)

    if isinstance(base, str):
        return _string_op(base, name, args)

    if isinstance(base, (int, float)) and not isinstance(base, bool):
        return _numeric_op(base, name, args)

    raise OclEvalError(f"Unknown operation '{name}' on value {base!r}")


def _op_forAll(elements, arg_tree, ctx):
    return all(r for _, r in _eval_lambda(arg_tree, elements, ctx))


def _op_exists(elements, arg_tree, ctx):
    return any(r for _, r in _eval_lambda(arg_tree, elements, ctx))


def _op_one(elements, arg_tree, ctx):
    return sum(1 for _, r in _eval_lambda(arg_tree, elements, ctx) if r) == 1


def _op_isUnique(elements, arg_tree, ctx):
    values = [r for _, r in _eval_lambda(arg_tree, elements, ctx)]
    try:
        return len(set(values)) == len(values)
    except TypeError:
        return all(values[i] != values[j] for i in range(len(values)) for j in range(i + 1, len(values)))


def _op_select(elements, arg_tree, ctx):
    return [combo[0] for combo, r in _eval_lambda(arg_tree, elements, ctx) if r]


def _op_reject(elements, arg_tree, ctx):
    return [combo[0] for combo, r in _eval_lambda(arg_tree, elements, ctx) if not r]


def _op_collect(elements, arg_tree, ctx):
    result = []
    for _, r in _eval_lambda(arg_tree, elements, ctx):
        if is_collection(r):
            result.extend(as_list(r))
        else:
            result.append(r)
    return result


def _op_sortedBy(elements, arg_tree, ctx):
    keyed = _eval_lambda(arg_tree, elements, ctx)
    keyed.sort(key=lambda pair: pair[1])
    return [combo[0] for combo, _ in keyed]


def _op_any(elements, arg_tree, ctx):
    for combo, r in _eval_lambda(arg_tree, elements, ctx):
        if r:
            return combo[0]
    return None


_LAMBDA_OPS = {
    "forAll": _op_forAll,
    "exists": _op_exists,
    "one": _op_one,
    "isUnique": _op_isUnique,
    "select": _op_select,
    "reject": _op_reject,
    "collect": _op_collect,
    "sortedBy": _op_sortedBy,
    "any": _op_any,
}


def _collection_op(elements: list, name: str, args: list) -> Any:
    if name == "size":
        return len(elements)
    if name == "isEmpty":
        return len(elements) == 0
    if name == "notEmpty":
        return len(elements) != 0
    if name == "includes":
        return args[0] in elements
    if name == "excludes":
        return args[0] not in elements
    if name == "includesAll":
        return all(a in elements for a in as_list(args[0]))
    if name == "excludesAll":
        return all(a not in elements for a in as_list(args[0]))
    if name == "count":
        return elements.count(args[0])
    if name == "sum":
        return sum(elements)
    if name in ("max",):
        return max(elements)
    if name in ("min",):
        return min(elements)
    if name == "first":
        return elements[0]
    if name == "last":
        return elements[-1]
    if name == "at":
        return elements[int(args[0]) - 1]
    if name == "asSet":
        return _dedupe(elements)
    if name in ("asBag", "asSequence"):
        return list(elements)
    if name == "asOrderedSet":
        return _dedupe(elements)
    if name == "flatten":
        flat = []
        for e in elements:
            flat.extend(as_list(e)) if is_collection(e) else flat.append(e)
        return flat
    if name == "union":
        return _dedupe(elements + as_list(args[0]))
    if name == "intersection":
        other = as_list(args[0])
        return [e for e in elements if e in other]
    if name == "including":
        return elements + [args[0]]
    if name == "excluding":
        return [e for e in elements if e != args[0]]
    if name == "toString":
        return str(elements)
    raise OclEvalError(f"Unknown collection operation '->{name}()'")


def _string_op(value: str, name: str, args: list) -> Any:
    if name == "size":
        return len(value)
    if name == "toUpperCase":
        return value.upper()
    if name == "toLowerCase":
        return value.lower()
    if name == "concat":
        return value + str(args[0])
    if name == "toInteger":
        return int(value)
    if name == "toReal":
        return float(value)
    if name == "toString":
        return value
    if name == "substring":
        return value[int(args[0]) - 1 : int(args[1])]
    if name == "isEmpty":
        return len(value) == 0
    if name == "notEmpty":
        return len(value) != 0
    if name == "indexOf":
        return value.find(str(args[0])) + 1
    raise OclEvalError(f"Unknown string operation '{name}()'")


def _numeric_op(value, name: str, args: list) -> Any:
    if name == "abs":
        return abs(value)
    if name == "toString":
        return str(value)
    if name == "max":
        return max(value, args[0])
    if name == "min":
        return min(value, args[0])
    if name == "round":
        return round(value)
    if name == "floor":
        import math

        return math.floor(value)
    if name == "toInteger":
        return int(value)
    if name == "toReal":
        return float(value)
    raise OclEvalError(f"Unknown numeric operation '{name}()'")


_HANDLERS = {
    "self_expr": _self_expr,
    "true_expr": _true_expr,
    "false_expr": _false_expr,
    "null_expr": _null_expr,
    "number_expr": _number_expr,
    "string_expr": _string_expr,
    "name_expr": _name_expr,
    "paren_expr": _paren_expr,
    "neg_expr": _neg_expr,
    "not_expr": _not_expr,
    "collection_literal": _collection_literal,
    "if_expr": _if_expr,
    "implies_expr": _implies_expr,
    "or_expr": _or_expr,
    "and_expr": _and_expr,
    "equality_expr": _equality_expr,
    "relational_expr": _relational_expr,
    "additive_expr": _additive_expr,
    "mult_expr": _mult_expr,
    "let_expr": _let_expr,
    "postfix_expr": _postfix_expr,
}


def evaluate_on(body_tree: Tree, self_obj: Any, all_objects: list, class_registry: dict[str, type]) -> Any:
    ctx = EvalContext(self_obj=self_obj, all_objects=all_objects, class_registry=class_registry)
    return evaluate(body_tree, ctx)
