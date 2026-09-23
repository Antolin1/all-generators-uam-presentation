package org.satgen.server;


import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.eclipse.emf.ecore.EClass;

/**
 * Compiles a pragmatic subset of OCL invariants (the same one already used elsewhere in this repo's other
 * generators: navigation, {@code select/reject/exists/forAll}, {@code size/isEmpty/notEmpty/includes/excludes},
 * {@code oclIsKindOf/oclIsTypeOf}, boolean logic, numeric comparisons) directly into CNF over a <em>bounded</em>
 * pool of candidate objects per class, instead of evaluating it against real objects. What falls outside the
 * subset (attributes, object identity, {@code allInstances()}, ...) is reported as unsupported and simply not
 * added to the SAT problem — the model USE eventually finds is still checked against it for real, with USE's
 * own OCL engine, once decoded (see {@code Runner}).
 */
public final class Ocl2Sat {

	private Ocl2Sat() {
	}

	public static final class Constraint {
		public final String context;
		public final String name;
		public final String source;
		final Node expr;

		Constraint(String context, String name, String source, Node expr) {
			this.context = context;
			this.name = name;
			this.source = source;
			this.expr = expr;
		}
	}

	/** Thrown for OCL this compiler does not turn into CNF; the caller decides what to do (typically: skip it). */
	public static final class Unsupported extends RuntimeException {
		public Unsupported(String message) {
			super(message);
		}
	}

	// ------------------------------------------------------------ compiling ------------------------------------------------------------

	/** One candidate object: a concrete class and a slot index into its pool. */
	public static final class Obj {
		public final EClass cls;
		public final int slot;

		public Obj(EClass cls, int slot) {
			this.cls = cls;
			this.slot = slot;
		}

		boolean sameAs(Obj other) {
			return other != null && cls == other.cls && slot == other.slot;
		}
	}

	private static final class Item {
		final Obj obj;
		final int incidence; // literal: true iff `obj` is actually part of the collection

		Item(Obj obj, int incidence) {
			this.obj = obj;
			this.incidence = incidence;
		}
	}

	private enum Kind { BOOL, NUM, OBJ, BITS, COLL }

	private static final class Val {
		final Kind kind;
		final int lit;
		final long num;
		final Obj obj;
		final Cnf.Bits bits;
		final List<Item> items;

		private Val(Kind kind, int lit, long num, Obj obj, Cnf.Bits bits, List<Item> items) {
			this.kind = kind;
			this.lit = lit;
			this.num = num;
			this.obj = obj;
			this.bits = bits;
			this.items = items;
		}

		static Val bool(int lit) {
			return new Val(Kind.BOOL, lit, 0, null, null, null);
		}

		static Val num(long n) {
			return new Val(Kind.NUM, 0, n, null, null, null);
		}

		static Val obj(Obj o) {
			return new Val(Kind.OBJ, 0, 0, o, null, null);
		}

		static Val bits(Cnf.Bits b) {
			return new Val(Kind.BITS, 0, 0, null, b, null);
		}

		static Val coll(List<Item> items) {
			return new Val(Kind.COLL, 0, 0, null, null, items);
		}
	}

	/** Per-compilation context: the CNF being built, the variable registry, the metamodel, and the pool sizes. */
	public interface PoolSize {
		int of(EClass concreteClass);
	}

	public static final class Ctx {
		final Cnf cnf;
		final Vars vars;
		final MetaModel mm;
		final PoolSize pools;
		final Map<String, Val> env;

		public Ctx(Cnf cnf, Vars vars, MetaModel mm, PoolSize pools, EClass selfClass, int selfSlot) {
			this.cnf = cnf;
			this.vars = vars;
			this.mm = mm;
			this.pools = pools;
			this.env = new HashMap<>();
			env.put("self", Val.obj(new Obj(selfClass, selfSlot)));
		}
	}

	/** Compiles {@code constraint.expr} with {@code self} already bound (via {@link Ctx}); returns the output literal. */
	public static int compile(Constraint constraint, Ctx ctx) {
		Val v = constraint.expr.compile(ctx);
		return boolOf(v, constraint);
	}

	private static int boolOf(Val v, Constraint c) {
		if (v.kind != Kind.BOOL) throw new Unsupported("«" + c.context + "::" + c.name + "»: la expresión no es booleana.");
		return v.lit;
	}

	private static List<Integer> incidences(List<Item> items) {
		List<Integer> lits = new ArrayList<>(items.size());
		for (Item i : items) lits.add(i.incidence);
		return lits;
	}

	private static Ctx childWith(Ctx ctx, String name, Obj value) {
		Ctx copy = new Ctx(ctx.cnf, ctx.vars, ctx.mm, ctx.pools, value.cls, value.slot);
		copy.env.clear();
		copy.env.putAll(ctx.env);
		copy.env.put(name, Val.obj(value));
		return copy;
	}

	// ------------------------------------------------------------ AST ------------------------------------------------------------

	private interface Node {
		Val compile(Ctx ctx);
	}

	private static final class BoolLit implements Node {
		final boolean value;

		BoolLit(boolean value) {
			this.value = value;
		}

		public Val compile(Ctx ctx) {
			return Val.bool(value ? ctx.cnf.TRUE : ctx.cnf.FALSE);
		}
	}

	private static final class NumLit implements Node {
		final long value;

		NumLit(long value) {
			this.value = value;
		}

		public Val compile(Ctx ctx) {
			return Val.num(value);
		}
	}

	private static final class SelfRef implements Node {
		public Val compile(Ctx ctx) {
			return ctx.env.get("self");
		}
	}

	private static final class VarRef implements Node {
		final String name;

		VarRef(String name) {
			this.name = name;
		}

		public Val compile(Ctx ctx) {
			Val v = ctx.env.get(name);
			if (v == null) throw new Unsupported("Variable «" + name + "» no está ligada aquí.");
			return v;
		}
	}

	private static final class Not implements Node {
		final Node inner;

		Not(Node inner) {
			this.inner = inner;
		}

		public Val compile(Ctx ctx) {
			return Val.bool(ctx.cnf.not(requireBool(inner.compile(ctx))));
		}
	}

	private static int requireBool(Val v) {
		if (v.kind != Kind.BOOL) throw new Unsupported("Se esperaba un booleano.");
		return v.lit;
	}

	private static final class BoolOp implements Node {
		final String op;
		final Node left, right;

		BoolOp(String op, Node left, Node right) {
			this.op = op;
			this.left = left;
			this.right = right;
		}

		public Val compile(Ctx ctx) {
			int l = requireBool(left.compile(ctx));
			int r = requireBool(right.compile(ctx));
			switch (op) {
				case "and": return Val.bool(ctx.cnf.and(l, r));
				case "or": return Val.bool(ctx.cnf.or(l, r));
				case "xor": return Val.bool(ctx.cnf.xor(l, r));
				case "implies": return Val.bool(ctx.cnf.implies(l, r));
				default: throw new IllegalStateException(op);
			}
		}
	}

	private static final class Compare implements Node {
		final String op;
		final Node left, right;

		Compare(String op, Node left, Node right) {
			this.op = op;
			this.left = left;
			this.right = right;
		}

		public Val compile(Ctx ctx) {
			Val l = left.compile(ctx);
			Val r = right.compile(ctx);
			if (l.kind == Kind.BITS && r.kind == Kind.NUM) return Val.bool(ctx.cnf.compare(l.bits, op, r.num));
			if (r.kind == Kind.BITS && l.kind == Kind.NUM) return Val.bool(ctx.cnf.compare(r.bits, flip(op), l.num));
			if (l.kind == Kind.NUM && r.kind == Kind.NUM) {
				boolean result = switch (op) {
					case "=" -> l.num == r.num;
					case "<>" -> l.num != r.num;
					case "<" -> l.num < r.num;
					case ">" -> l.num > r.num;
					case "<=" -> l.num <= r.num;
					default -> l.num >= r.num;
				};
				return Val.bool(result ? ctx.cnf.TRUE : ctx.cnf.FALSE);
			}
			throw new Unsupported("Comparación no soportada en SAT (solo tamaños de colecciones frente a un número).");
		}

		private static String flip(String op) {
			return switch (op) {
				case "<" -> ">";
				case ">" -> "<";
				case "<=" -> ">=";
				case ">=" -> "<=";
				default -> op;
			};
		}
	}

	private static final class Property implements Node {
		final Node target;
		final String name;

		Property(Node target, String name) {
			this.target = target;
			this.name = name;
		}

		public Val compile(Ctx ctx) {
			Val v = target.compile(ctx);
			if (v.kind != Kind.OBJ) throw new Unsupported("Solo se puede navegar «." + name + "» desde un objeto.");
			Obj self = v.obj;
			for (MetaModel.Ref ref : ctx.mm.refs) {
				if (ref.roleFromOwner.equals(name) && ref.owner.isSuperTypeOf(self.cls)) return navigate(ctx, ref, self, true);
				if (name.equals(ref.roleFromTarget) && ref.target.isSuperTypeOf(self.cls)) return navigate(ctx, ref, self, false);
			}
			throw new Unsupported("«" + self.cls.getName() + "» no tiene una referencia «" + name + "» (¿es un atributo? no se codifica en SAT).");
		}

		private Val navigate(Ctx ctx, MetaModel.Ref ref, Obj self, boolean forward) {
			List<EClass> others = ctx.mm.concreteSubtypes(forward ? ref.target : ref.owner);
			List<Item> items = new ArrayList<>();
			for (EClass other : others) {
				int n = ctx.pools.of(other);
				for (int slot = 0; slot < n; slot++) {
					int lit = forward
							? ctx.vars.link(ref.index, self.cls.getName(), self.slot, other.getName(), slot)
							: ctx.vars.link(ref.index, other.getName(), slot, self.cls.getName(), self.slot);
					items.add(new Item(new Obj(other, slot), lit));
				}
			}
			return Val.coll(items);
		}
	}

	private static final class Call implements Node {
		final Node target;
		final boolean arrow;
		final String name;
		final List<Node> args;
		final String lambdaVar;
		final Node lambdaBody;

		Call(Node target, boolean arrow, String name, List<Node> args, String lambdaVar, Node lambdaBody) {
			this.target = target;
			this.arrow = arrow;
			this.name = name;
			this.args = args;
			this.lambdaVar = lambdaVar;
			this.lambdaBody = lambdaBody;
		}

		public Val compile(Ctx ctx) {
			Val recv = target.compile(ctx);
			return arrow ? arrowCall(ctx, recv) : dotCall(ctx, recv);
		}

		private Val dotCall(Ctx ctx, Val recv) {
			if (recv.kind != Kind.OBJ) throw new Unsupported("«." + name + "(...)» necesita un objeto.");
			if (name.equals("oclIsKindOf") || name.equals("oclIsTypeOf")) {
				String typeName = typeNameArg();
				EClass type = ctx.mm.byName.get(typeName);
				if (type == null) throw new Unsupported("Tipo «" + typeName + "» desconocido.");
				boolean result = name.equals("oclIsTypeOf") ? recv.obj.cls == type : type.isSuperTypeOf(recv.obj.cls);
				return Val.bool(result ? ctx.cnf.TRUE : ctx.cnf.FALSE);
			}
			throw new Unsupported("Operación «." + name + "» no soportada en SAT.");
		}

		private String typeNameArg() {
			if (args.size() == 1 && args.get(0) instanceof VarRef vr) return vr.name;
			throw new Unsupported("Se esperaba un nombre de tipo en " + name + "(...)");
		}

		private Val arrowCall(Ctx ctx, Val recv) {
			if (recv.kind != Kind.COLL) throw new Unsupported("«->" + name + "» necesita una colección.");
			List<Item> items = recv.items;
			List<Integer> lits = incidences(items);
			switch (name) {
				case "size":
					return Val.bits(ctx.cnf.popcount(lits));
				case "isEmpty":
					return Val.bool(ctx.cnf.cardinalityCompare(lits, "=", 0));
				case "notEmpty":
					return Val.bool(ctx.cnf.cardinalityCompare(lits, ">", 0));
				case "includes":
				case "excludes": {
					Val arg = args.get(0).compile(ctx);
					if (arg.kind != Kind.OBJ) throw new Unsupported(name + "() necesita un objeto.");
					int lit = ctx.cnf.FALSE;
					for (Item it : items) if (it.obj.sameAs(arg.obj)) lit = it.incidence;
					return Val.bool(name.equals("includes") ? lit : ctx.cnf.not(lit));
				}
				case "select":
				case "reject": {
					List<Item> out = new ArrayList<>(items.size());
					for (Item it : items) {
						int p = requireBool(lambdaBody.compile(childWith(ctx, lambdaVar, it.obj)));
						out.add(new Item(it.obj, ctx.cnf.and(it.incidence, name.equals("select") ? p : ctx.cnf.not(p))));
					}
					return Val.coll(out);
				}
				case "exists": {
					int acc = ctx.cnf.FALSE;
					for (Item it : items) {
						int p = requireBool(lambdaBody.compile(childWith(ctx, lambdaVar, it.obj)));
						acc = ctx.cnf.or(acc, ctx.cnf.and(it.incidence, p));
					}
					return Val.bool(acc);
				}
				case "forAll": {
					int acc = ctx.cnf.TRUE;
					for (Item it : items) {
						int p = requireBool(lambdaBody.compile(childWith(ctx, lambdaVar, it.obj)));
						acc = ctx.cnf.and(acc, ctx.cnf.implies(it.incidence, p));
					}
					return Val.bool(acc);
				}
				default:
					throw new Unsupported("Operación «->" + name + "» no soportada en SAT.");
			}
		}
	}

	// ---------------------------------------------------------- parsing ----------------------------------------------------------

	/** Splits {@code source} into {@code context X inv Name: expr} blocks and parses each expression. */
	public static List<Constraint> parse(String source) {
		List<Constraint> constraints = new ArrayList<>();
		String noComments = stripComments(source);
		Matcher header = Pattern.compile("context\\s+(\\w+)\\s+inv(?:\\s+(\\w+))?\\s*:", Pattern.MULTILINE).matcher(noComments);
		List<int[]> spans = new ArrayList<>();
		List<String[]> heads = new ArrayList<>();
		while (header.find()) {
			spans.add(new int[] { header.start(), header.end() });
			heads.add(new String[] { header.group(1), header.group(2) });
		}
		for (int i = 0; i < spans.size(); i++) {
			int start = spans.get(i)[1];
			int end = i + 1 < spans.size() ? spans.get(i + 1)[0] : noComments.length();
			String body = noComments.substring(start, end).trim();
			String context = heads.get(i)[0];
			String name = heads.get(i)[1] != null ? heads.get(i)[1] : "inv" + (i + 1);
			if (body.isEmpty()) continue;
			Node expr = new Parser(tokenize(body)).parseExpression();
			constraints.add(new Constraint(context, name, body, expr));
		}
		return constraints;
	}

	private static String stripComments(String source) {
		StringBuilder out = new StringBuilder(source.length());
		boolean inString = false;
		for (int i = 0; i < source.length(); i++) {
			char c = source.charAt(i);
			if (c == '\'') inString = !inString;
			if (!inString && c == '-' && i + 1 < source.length() && source.charAt(i + 1) == '-') {
				while (i < source.length() && source.charAt(i) != '\n') i++;
				out.append('\n');
				continue;
			}
			out.append(c);
		}
		return out.toString();
	}

	private record Token(String kind, String text) {
	}

	private static final java.util.Set<String> KEYWORDS = java.util.Set.of("and", "or", "xor", "not", "implies", "true", "false", "self");

	private static List<Token> tokenize(String text) {
		List<Token> tokens = new ArrayList<>();
		int i = 0, n = text.length();
		while (i < n) {
			char c = text.charAt(i);
			if (Character.isWhitespace(c)) {
				i++;
			} else if (Character.isDigit(c)) {
				int start = i;
				while (i < n && Character.isDigit(text.charAt(i))) i++;
				tokens.add(new Token("number", text.substring(start, i)));
			} else if (Character.isLetter(c) || c == '_') {
				int start = i;
				while (i < n && (Character.isLetterOrDigit(text.charAt(i)) || text.charAt(i) == '_')) i++;
				String word = text.substring(start, i);
				tokens.add(new Token(KEYWORDS.contains(word) ? "keyword" : "ident", word));
			} else if (c == '-' && i + 1 < n && text.charAt(i + 1) == '>') {
				tokens.add(new Token("op", "->"));
				i += 2;
			} else if (c == '<' && i + 1 < n && text.charAt(i + 1) == '>') {
				tokens.add(new Token("op", "<>"));
				i += 2;
			} else if ((c == '<' || c == '>') && i + 1 < n && text.charAt(i + 1) == '=') {
				tokens.add(new Token("op", text.substring(i, i + 2)));
				i += 2;
			} else if ("().,|=<>.".indexOf(c) >= 0) {
				tokens.add(new Token("op", String.valueOf(c)));
				i++;
			} else {
				throw new Unsupported("Carácter inesperado «" + c + "».");
			}
		}
		tokens.add(new Token("eof", ""));
		return tokens;
	}

	private static final class Parser {
		private final List<Token> tokens;
		private int pos;

		Parser(List<Token> tokens) {
			this.tokens = tokens;
		}

		Node parseExpression() {
			Node n = implication();
			if (!peek().kind().equals("eof")) throw new Unsupported("Sobra «" + peek().text() + "».");
			return n;
		}

		private Token peek() {
			return tokens.get(pos);
		}

		private boolean atKeyword(String w) {
			return peek().kind().equals("keyword") && peek().text().equals(w);
		}

		private boolean atOp(String o) {
			return peek().kind().equals("op") && peek().text().equals(o);
		}

		private Token advance() {
			return tokens.get(pos++);
		}

		private Node implication() {
			Node l = orExpr();
			while (atKeyword("implies")) {
				advance();
				l = new BoolOp("implies", l, orExpr());
			}
			return l;
		}

		private Node orExpr() {
			Node l = andExpr();
			while (atKeyword("or") || atKeyword("xor")) {
				String op = advance().text();
				l = new BoolOp(op, l, andExpr());
			}
			return l;
		}

		private Node andExpr() {
			Node l = notExpr();
			while (atKeyword("and")) {
				advance();
				l = new BoolOp("and", l, notExpr());
			}
			return l;
		}

		private Node notExpr() {
			if (atKeyword("not")) {
				advance();
				return new Not(notExpr());
			}
			return comparison();
		}

		private Node comparison() {
			Node l = postfix();
			if (atOp("=") || atOp("<>") || atOp("<") || atOp(">") || atOp("<=") || atOp(">=")) {
				String op = advance().text();
				return new Compare(op, l, postfix());
			}
			return l;
		}

		private Node postfix() {
			Node node = primary();
			while (true) {
				if (isDot()) {
					advance();
					String name = advance().text();
					node = atOp("(") ? callArgs(node, false, name) : new Property(node, name);
				} else if (atOp("->")) {
					advance();
					node = callArgs(node, true, advance().text());
				} else {
					break;
				}
			}
			return node;
		}

		private boolean isDot() {
			return peek().kind().equals("op") && peek().text().equals(".");
		}

		private Node callArgs(Node target, boolean arrow, String name) {
			List<Node> args = new ArrayList<>();
			String lambdaVar = null;
			Node lambdaBody = null;
			if (atOp("(")) {
				advance();
				if (!atOp(")")) {
					if (isLambdaAhead()) {
						lambdaVar = advance().text();
						expect("|");
						lambdaBody = implication();
					} else {
						args.add(implication());
						while (atOp(",")) {
							advance();
							args.add(implication());
						}
					}
				}
				expect(")");
			}
			return new Call(target, arrow, name, args, lambdaVar, lambdaBody);
		}

		private boolean isLambdaAhead() {
			return peek().kind().equals("ident") && tokens.get(pos + 1).kind().equals("op") && tokens.get(pos + 1).text().equals("|");
		}

		private void expect(String op) {
			if (!atOp(op)) throw new Unsupported("Se esperaba «" + op + "» y se encontró «" + peek().text() + "».");
			advance();
		}

		private Node primary() {
			Token t = peek();
			if (t.kind().equals("keyword") && t.text().equals("self")) {
				advance();
				return new SelfRef();
			}
			if (t.kind().equals("keyword") && (t.text().equals("true") || t.text().equals("false"))) {
				advance();
				return new BoolLit(Boolean.parseBoolean(t.text()));
			}
			if (t.kind().equals("number")) {
				advance();
				return new NumLit(Long.parseLong(t.text()));
			}
			if (t.kind().equals("ident")) {
				advance();
				return new VarRef(t.text());
			}
			if (atOp("(")) {
				advance();
				Node inner = implication();
				expect(")");
				return inner;
			}
			throw new Unsupported("No se esperaba «" + t.text() + "» aquí.");
		}
	}
}
