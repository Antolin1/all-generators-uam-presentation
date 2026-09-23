"""Compiles the same OCL parse trees used by ocl/evaluator.py into Python
*source code* (strings), for embedding inside generated Pydantic validators.

This is a second, independent backend for the OCL grammar - the interpreter
in ocl/evaluator.py keeps evaluating expressions live against pyecore
objects for the web validator; this module never runs the expression itself,
it only ever produces Python text. Because there is no metamodel-based type
system on the Python side at codegen time, it does its own light static type
tracking (`SType`) just accurate enough to know when a navigation still
targets a model class (so `.attr` on a to-many reference means an implicit
collect+flatten) versus an opaque/primitive value.

Object identity/equality: generated classes are expected to inherit from a
runtime base (see generator.py's `OclEntity`) that restores plain Python
`is`-based `__eq__`/`__hash__`, matching OCL's reference-equality semantics
for objects, so plain `==`/`!=`/`in`/`set(...)` in the generated code behave
correctly for model objects and stay standard value-equality for primitives.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace

from lark import Tree

from ..ecore_service import Metamodel
from .naming import to_snake_case


class OclCompileError(Exception):
    pass


@dataclass(frozen=True)
class SType:
    kind: str  # 'obj' | 'list' | 'prim' | 'typeref' | 'unknown'
    cls: str | None = None  # ecore class name, for 'obj' / 'typeref' / list-element


@dataclass
class CV:
    code: str
    type: SType


@dataclass
class CompileContext:
    metamodel: Metamodel
    self_class: str
    env: dict[str, SType] = field(default_factory=dict)
    _counter: list[int] = field(default_factory=lambda: [0])

    def with_var(self, name: str, stype: SType) -> "CompileContext":
        new_env = dict(self.env)
        new_env[name] = stype
        return replace(self, env=new_env)


def find_reference(metamodel: Metamodel, cls_name: str | None, ref_name: str):
    if cls_name is None:
        return None
    seen: set[str] = set()
    stack = [cls_name]
    while stack:
        c = stack.pop()
        if c in seen:
            continue
        seen.add(c)
        info = metamodel.classes.get(c)
        if info is None:
            continue
        for r in info.references:
            if r.name == ref_name:
                return r
        stack.extend(info.super_types)
    return None


def compile_constraint_body(tree: Tree, metamodel: Metamodel, context_class: str) -> CV:
    ctx = CompileContext(metamodel=metamodel, self_class=context_class)
    cv = compile_expr(tree, ctx)
    if cv.type.kind not in ("prim", "unknown"):
        raise OclCompileError(
            f"La expresión no parece evaluar a un booleano (tipo inferido: {cv.type.kind})."
        )
    return cv


def compile_expr(tree: Tree, ctx: CompileContext) -> CV:
    handler = _HANDLERS.get(tree.data)
    if handler is None:
        raise OclCompileError(f"No se sabe compilar el nodo OCL '{tree.data}'")
    return handler(tree, ctx)


# ---------------------------------------------------------------------------
# Literals / primaries
# ---------------------------------------------------------------------------

def _self_expr(tree, ctx):
    return CV("self", SType("obj", ctx.self_class))


def _true_expr(tree, ctx):
    return CV("True", SType("prim"))


def _false_expr(tree, ctx):
    return CV("False", SType("prim"))


def _null_expr(tree, ctx):
    return CV("None", SType("prim"))


def _number_expr(tree, ctx):
    return CV(str(tree.children[0]), SType("prim"))


def _string_expr(tree, ctx):
    text = str(tree.children[0])[1:-1]
    return CV(repr(text), SType("prim"))


def _name_expr(tree, ctx):
    name = str(tree.children[0])
    if name in ctx.env:
        return CV(name, ctx.env[name])
    if name in ctx.metamodel.classes:
        return CV(name, SType("typeref", name))
    raise OclCompileError(f"Identificador desconocido '{name}' (ni variable ligada ni nombre de clase)")


def _paren_expr(tree, ctx):
    inner = compile_expr(tree.children[0], ctx)
    return CV(f"({inner.code})", inner.type)


def _neg_expr(tree, ctx):
    inner = compile_expr(tree.children[0], ctx)
    return CV(f"(-{inner.code})", SType("prim"))


def _not_expr(tree, ctx):
    inner = compile_expr(tree.children[0], ctx)
    return CV(f"(not {inner.code})", SType("prim"))


def _collection_literal(tree, ctx):
    kind = str(tree.children[0])
    parts: list[str] = []
    elem_cls: str | None = None
    for item in tree.children[1:]:
        if item.data == "range_item":
            lo = compile_expr(item.children[0], ctx)
            hi = compile_expr(item.children[1], ctx)
            parts.append(f"list(range(int({lo.code}), int({hi.code}) + 1))")
        else:
            v = compile_expr(item, ctx)
            if elem_cls is None and v.type.cls:
                elem_cls = v.type.cls
            parts.append(f"[{v.code}]")
    code = " + ".join(parts) if parts else "[]"
    if kind == "Set":
        code = f"list(dict.fromkeys({code}))"
    return CV(code, SType("list", elem_cls))


# ---------------------------------------------------------------------------
# Boolean / arithmetic chains
# ---------------------------------------------------------------------------

def _if_expr(tree, ctx):
    cond, then_b, else_b = (compile_expr(c, ctx) for c in tree.children)
    return CV(f"(({then_b.code}) if ({cond.code}) else ({else_b.code}))", then_b.type)


def _implies_expr(tree, ctx):
    values = [compile_expr(c, ctx) for c in tree.children]
    if len(values) == 1:
        return values[0]
    acc = values[0].code
    for v in values[1:]:
        acc = f"((not ({acc})) or ({v.code}))"
    return CV(acc, SType("prim"))


def _or_expr(tree, ctx):
    first = compile_expr(tree.children[0], ctx)
    if len(tree.children) == 1:
        return first
    acc = first.code
    idx = 1
    while idx < len(tree.children):
        op = str(tree.children[idx])
        rhs = compile_expr(tree.children[idx + 1], ctx).code
        acc = f"(bool({acc}) != bool({rhs}))" if op == "xor" else f"(({acc}) or ({rhs}))"
        idx += 2
    return CV(acc, SType("prim"))


def _and_expr(tree, ctx):
    parts = [compile_expr(c, ctx) for c in tree.children]
    if len(parts) == 1:
        return parts[0]
    return CV(" and ".join(f"({p.code})" for p in parts), SType("prim"))


def _equality_expr(tree, ctx):
    first = compile_expr(tree.children[0], ctx)
    if len(tree.children) == 1:
        return first
    acc = first.code
    idx = 1
    while idx < len(tree.children):
        op = "==" if str(tree.children[idx]) == "=" else "!="
        rhs = compile_expr(tree.children[idx + 1], ctx).code
        acc = f"(({acc}) {op} ({rhs}))"
        idx += 2
    return CV(acc, SType("prim"))


def _relational_expr(tree, ctx):
    first = compile_expr(tree.children[0], ctx)
    if len(tree.children) == 1:
        return first
    acc = first.code
    idx = 1
    while idx < len(tree.children):
        op = str(tree.children[idx])
        rhs = compile_expr(tree.children[idx + 1], ctx).code
        acc = f"(({acc}) {op} ({rhs}))"
        idx += 2
    return CV(acc, SType("prim"))


def _additive_expr(tree, ctx):
    first = compile_expr(tree.children[0], ctx)
    if len(tree.children) == 1:
        return first
    acc = first.code
    idx = 1
    while idx < len(tree.children):
        op = str(tree.children[idx])
        rhs = compile_expr(tree.children[idx + 1], ctx).code
        acc = f"(({acc}) {op} ({rhs}))"
        idx += 2
    return CV(acc, SType("prim"))


def _mult_expr(tree, ctx):
    first = compile_expr(tree.children[0], ctx)
    if len(tree.children) == 1:
        return first
    acc = first.code
    idx = 1
    while idx < len(tree.children):
        op = str(tree.children[idx])
        rhs = compile_expr(tree.children[idx + 1], ctx).code
        if op == "mod":
            acc = f"(int({acc}) % int({rhs}))"
        elif op == "div":
            acc = f"(int({acc}) // int({rhs}))"
        else:
            acc = f"(({acc}) {op} ({rhs}))"
        idx += 2
    return CV(acc, SType("prim"))


# ---------------------------------------------------------------------------
# let
# ---------------------------------------------------------------------------

def _let_expr(tree, ctx):
    *let_vars, body = tree.children
    bindings: list[tuple[str, CV]] = []
    cur_ctx = ctx
    for lv in let_vars:
        name = str(lv.children[0])
        value_expr = lv.children[-1]
        val_cv = compile_expr(value_expr, cur_ctx)
        bindings.append((name, val_cv))
        cur_ctx = cur_ctx.with_var(name, val_cv.type)
    body_cv = compile_expr(body, cur_ctx)
    code = body_cv.code
    for name, val_cv in reversed(bindings):
        code = f"(lambda {name}=({val_cv.code}): ({code}))()"
    return CV(code, body_cv.type)


# ---------------------------------------------------------------------------
# postfix / navigation
# ---------------------------------------------------------------------------

def _postfix_expr(tree, ctx):
    cv = compile_expr(tree.children[0], ctx)
    for trailer in tree.children[1:]:
        cv = _compile_trailer(cv, trailer, ctx)
    return cv


def _compile_trailer(base_cv: CV, trailer: Tree, ctx: CompileContext) -> CV:
    name = str(trailer.children[1])
    call_args = trailer.children[2] if len(trailer.children) > 2 else None
    if call_args is None:
        return _compile_navigate(base_cv, name, ctx)
    return _compile_operation(base_cv, name, list(call_args.children), ctx)


def _compile_navigate(base_cv: CV, name: str, ctx: CompileContext) -> CV:
    py_name = to_snake_case(name)
    if base_cv.type.kind == "list":
        elem_cls = base_cv.type.cls
        ref = find_reference(ctx.metamodel, elem_cls, name)
        var = "_n"
        if ref is not None and ref.upper != 1:
            code = f"_flatten([{var}.{py_name} for {var} in ({base_cv.code})])"
            return CV(code, SType("list", ref.target))
        result_cls = ref.target if ref is not None else None
        code = f"[{var}.{py_name} for {var} in ({base_cv.code})]"
        return CV(code, SType("list", result_cls))
    if base_cv.type.kind in ("obj", "unknown"):
        cls = base_cv.type.cls
        ref = find_reference(ctx.metamodel, cls, name)
        code = f"{base_cv.code}.{py_name}"
        if ref is not None:
            return CV(code, SType("list", ref.target) if ref.upper != 1 else SType("obj", ref.target))
        return CV(code, SType("prim"))
    raise OclCompileError(f"No se puede navegar '.{name}' sobre un valor de tipo {base_cv.type.kind}")


def _prep_lambda(base_cv: CV, arg_tree: Tree, ctx: CompileContext) -> tuple[list[str], CV]:
    *varname_toks, body = arg_tree.children
    varnames = [str(t) for t in varname_toks]
    elem_type = SType("obj", base_cv.type.cls) if base_cv.type.cls else SType("unknown")
    cur_ctx = ctx
    for v in varnames:
        cur_ctx = cur_ctx.with_var(v, elem_type)
    body_cv = compile_expr(body, cur_ctx)
    return varnames, body_cv


def _single_var(varnames: list[str]) -> str:
    if len(varnames) != 1:
        raise OclCompileError(
            "Esta operación solo se puede traducir con una única variable de iteración"
        )
    return varnames[0]


def _op_forAll_cg(base_cv, arg_tree, ctx):
    varnames, body_cv = _prep_lambda(base_cv, arg_tree, ctx)
    clauses = " ".join(f"for {v} in ({base_cv.code})" for v in varnames)
    return CV(f"all({body_cv.code} {clauses})", SType("prim"))


def _op_exists_cg(base_cv, arg_tree, ctx):
    varnames, body_cv = _prep_lambda(base_cv, arg_tree, ctx)
    clauses = " ".join(f"for {v} in ({base_cv.code})" for v in varnames)
    return CV(f"any({body_cv.code} {clauses})", SType("prim"))


def _op_one_cg(base_cv, arg_tree, ctx):
    varnames, body_cv = _prep_lambda(base_cv, arg_tree, ctx)
    v = _single_var(varnames)
    return CV(f"(sum(1 for {v} in ({base_cv.code}) if {body_cv.code}) == 1)", SType("prim"))


def _op_isUnique_cg(base_cv, arg_tree, ctx):
    varnames, body_cv = _prep_lambda(base_cv, arg_tree, ctx)
    v = _single_var(varnames)
    code = (
        f"(lambda _vals=[{body_cv.code} for {v} in ({base_cv.code})]: "
        f"len(set(_vals)) == len(_vals))()"
    )
    return CV(code, SType("prim"))


def _op_select_cg(base_cv, arg_tree, ctx):
    varnames, body_cv = _prep_lambda(base_cv, arg_tree, ctx)
    v = _single_var(varnames)
    return CV(f"[{v} for {v} in ({base_cv.code}) if {body_cv.code}]", SType("list", base_cv.type.cls))


def _op_reject_cg(base_cv, arg_tree, ctx):
    varnames, body_cv = _prep_lambda(base_cv, arg_tree, ctx)
    v = _single_var(varnames)
    return CV(
        f"[{v} for {v} in ({base_cv.code}) if not ({body_cv.code})]", SType("list", base_cv.type.cls)
    )


def _op_collect_cg(base_cv, arg_tree, ctx):
    varnames, body_cv = _prep_lambda(base_cv, arg_tree, ctx)
    v = _single_var(varnames)
    if body_cv.type.kind == "list":
        code = f"_flatten([{body_cv.code} for {v} in ({base_cv.code})])"
    else:
        code = f"[{body_cv.code} for {v} in ({base_cv.code})]"
    return CV(code, SType("list", body_cv.type.cls))


def _op_sortedBy_cg(base_cv, arg_tree, ctx):
    varnames, body_cv = _prep_lambda(base_cv, arg_tree, ctx)
    v = _single_var(varnames)
    return CV(f"sorted(({base_cv.code}), key=lambda {v}: {body_cv.code})", SType("list", base_cv.type.cls))


def _op_any_cg(base_cv, arg_tree, ctx):
    varnames, body_cv = _prep_lambda(base_cv, arg_tree, ctx)
    v = _single_var(varnames)
    result_type = SType("obj", base_cv.type.cls) if base_cv.type.cls else SType("unknown")
    return CV(f"next(({v} for {v} in ({base_cv.code}) if {body_cv.code}), None)", result_type)


_LAMBDA_OPS_CODEGEN = {
    "forAll": _op_forAll_cg,
    "exists": _op_exists_cg,
    "one": _op_one_cg,
    "isUnique": _op_isUnique_cg,
    "select": _op_select_cg,
    "reject": _op_reject_cg,
    "collect": _op_collect_cg,
    "sortedBy": _op_sortedBy_cg,
    "any": _op_any_cg,
}


def _compile_operation(base_cv: CV, name: str, arg_nodes: list, ctx: CompileContext) -> CV:
    if name in ("oclIsKindOf", "oclIsTypeOf", "oclAsType"):
        if not arg_nodes:
            raise OclCompileError(f"{name}() requiere el nombre de una clase")
        arg_cv = compile_expr(arg_nodes[0], ctx)
        if arg_cv.type.kind != "typeref":
            raise OclCompileError(f"{name}() espera el nombre de una clase, no una expresión")
        target = arg_cv.type.cls
        if name == "oclIsKindOf":
            return CV(f"isinstance({base_cv.code}, {target})", SType("prim"))
        if name == "oclIsTypeOf":
            return CV(f"(type({base_cv.code}) is {target})", SType("prim"))
        return CV(base_cv.code, SType("obj", target))

    if name == "allInstances":
        raise OclCompileError(
            "Clase.allInstances() no se puede traducir a un post-validator de Pydantic: "
            "un objeto aislado no tiene acceso a 'todas las instancias del modelo'."
        )

    if name == "oclIsUndefined":
        return CV(f"({base_cv.code} is None)", SType("prim"))
    if name == "oclIsInvalid":
        return CV("False", SType("prim"))

    if name in _LAMBDA_OPS_CODEGEN:
        if base_cv.type.kind != "list":
            raise OclCompileError(f"->{name}() espera una colección")
        if not arg_nodes:
            raise OclCompileError(f"->{name}() requiere un argumento lambda, p.ej. (x | expr)")
        return _LAMBDA_OPS_CODEGEN[name](base_cv, arg_nodes[0], ctx)

    arg_codes = [compile_expr(a, ctx).code for a in arg_nodes]

    if base_cv.type.kind == "list":
        return _collection_op_codegen(base_cv, name, arg_codes)
    return _value_op_codegen(base_cv, name, arg_codes)


def _collection_op_codegen(base_cv: CV, name: str, arg_codes: list[str]) -> CV:
    c = base_cv.code
    elem_type = SType("obj", base_cv.type.cls) if base_cv.type.cls else SType("unknown")
    if name == "size":
        return CV(f"len({c})", SType("prim"))
    if name == "isEmpty":
        return CV(f"(len({c}) == 0)", SType("prim"))
    if name == "notEmpty":
        return CV(f"(len({c}) != 0)", SType("prim"))
    if name == "includes":
        return CV(f"({arg_codes[0]} in ({c}))", SType("prim"))
    if name == "excludes":
        return CV(f"({arg_codes[0]} not in ({c}))", SType("prim"))
    if name == "includesAll":
        return CV(f"all(_x in ({c}) for _x in ({arg_codes[0]}))", SType("prim"))
    if name == "excludesAll":
        return CV(f"all(_x not in ({c}) for _x in ({arg_codes[0]}))", SType("prim"))
    if name == "count":
        return CV(f"({c}).count({arg_codes[0]})", SType("prim"))
    if name == "sum":
        return CV(f"sum({c})", SType("prim"))
    if name == "max":
        return CV(f"max({c})", SType("prim"))
    if name == "min":
        return CV(f"min({c})", SType("prim"))
    if name == "first":
        return CV(f"({c})[0]", elem_type)
    if name == "last":
        return CV(f"({c})[-1]", elem_type)
    if name == "at":
        return CV(f"({c})[int({arg_codes[0]}) - 1]", elem_type)
    if name in ("asSet", "asOrderedSet"):
        return CV(f"list(dict.fromkeys({c}))", base_cv.type)
    if name in ("asBag", "asSequence"):
        return CV(f"list({c})", base_cv.type)
    if name == "flatten":
        return CV(f"_flatten({c})", base_cv.type)
    if name == "union":
        return CV(f"list(dict.fromkeys(list({c}) + list({arg_codes[0]})))", base_cv.type)
    if name == "intersection":
        return CV(f"[_x for _x in ({c}) if _x in ({arg_codes[0]})]", base_cv.type)
    if name == "including":
        return CV(f"(list({c}) + [{arg_codes[0]}])", base_cv.type)
    if name == "excluding":
        return CV(f"[_x for _x in ({c}) if _x != {arg_codes[0]}]", base_cv.type)
    if name == "toString":
        return CV(f"str({c})", SType("prim"))
    raise OclCompileError(f"Operación de colección desconocida '->{name}()'")


def _value_op_codegen(base_cv: CV, name: str, arg_codes: list[str]) -> CV:
    c = base_cv.code
    zero_arg = {
        "toUpperCase": f"({c}).upper()",
        "toLowerCase": f"({c}).lower()",
        "toInteger": f"int({c})",
        "toReal": f"float({c})",
        "toString": f"str({c})",
        "isEmpty": f"(len({c}) == 0)",
        "notEmpty": f"(len({c}) != 0)",
        "size": f"len({c})",
        "abs": f"abs({c})",
        "round": f"round({c})",
        "floor": f"math.floor({c})",
    }
    if not arg_codes and name in zero_arg:
        return CV(zero_arg[name], SType("prim"))
    if name == "concat":
        return CV(f"(({c}) + str({arg_codes[0]}))", SType("prim"))
    if name == "substring":
        return CV(f"({c})[int({arg_codes[0]}) - 1:int({arg_codes[1]})]", SType("prim"))
    if name == "indexOf":
        return CV(f"(({c}).find(str({arg_codes[0]})) + 1)", SType("prim"))
    if name in ("max", "min") and arg_codes:
        return CV(f"{name}({c}, {arg_codes[0]})", SType("prim"))
    raise OclCompileError(f"Operación desconocida '.{name}()' sobre un valor no-colección")


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
