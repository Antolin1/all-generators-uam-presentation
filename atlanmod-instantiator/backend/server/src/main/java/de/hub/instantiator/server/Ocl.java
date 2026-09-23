package de.hub.instantiator.server;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

import org.eclipse.emf.ecore.EClass;
import org.eclipse.emf.ecore.EObject;
import org.eclipse.emf.ecore.EStructuralFeature;

/**
 * A small, pragmatic subset of OCL: enough to write "Complete OCL"-style invariants
 * (<code>context ClassName inv Name: ...</code>) over an Ecore metamodel and evaluate them against
 * dynamic EMF objects. Not the OMG standard — navigation, the usual collection operations with a lambda,
 * boolean logic, comparisons and <code>oclIsKindOf</code>/<code>oclIsTypeOf</code>, which is what
 * hand-written well-formedness rules over a metamodel tend to need.
 */
final class Ocl {

	private Ocl() {
	}

	/** A parsed <code>context X inv Name: expr</code> block. */
	static final class Constraint {
		final String context;
		final String name;
		final String source; // the expression, trimmed, for display
		final Node expr;

		Constraint(String context, String name, String source, Node expr) {
			this.context = context;
			this.name = name;
			this.source = source;
			this.expr = expr;
		}
	}

	/** A syntax error while parsing an .ocl file, or a navigation error while evaluating a constraint. */
	static final class OclError extends RuntimeException {
		private static final long serialVersionUID = 1L;

		OclError(String message) {
			super(message);
		}
	}

	// ------------------------------------------------------------ AST ------------------------------------------------------------

	private interface Node {
		Object eval(Env env);
	}

	private static final class Env {
		final Map<String, Object> vars;
		final ClassLookup classes;

		Env(Map<String, Object> vars, ClassLookup classes) {
			this.vars = vars;
			this.classes = classes;
		}

		Env with(String name, Object value) {
			java.util.LinkedHashMap<String, Object> copy = new java.util.LinkedHashMap<String, Object>(vars);
			copy.put(name, value);
			return new Env(copy, classes);
		}
	}

	/** Resolves a bare type name (as written in OCL, e.g. <code>Entry</code>) to its EClass. */
	interface ClassLookup {
		EClass find(String simpleName);
	}

	private static final class Lit implements Node {
		final Object value;

		Lit(Object value) {
			this.value = value;
		}

		public Object eval(Env env) {
			return value;
		}
	}

	private static final class SelfRef implements Node {
		public Object eval(Env env) {
			return env.vars.get("self");
		}
	}

	private static final class VarRef implements Node {
		final String name;

		VarRef(String name) {
			this.name = name;
		}

		public Object eval(Env env) {
			if (!env.vars.containsKey(name)) throw new OclError("Variable «" + name + "» no está definida aquí.");
			return env.vars.get(name);
		}
	}

	private static final class Not implements Node {
		final Node inner;

		Not(Node inner) {
			this.inner = inner;
		}

		public Object eval(Env env) {
			return !truthy(inner.eval(env));
		}
	}

	private static final class BoolOp implements Node {
		final String op;
		final Node left;
		final Node right;

		BoolOp(String op, Node left, Node right) {
			this.op = op;
			this.left = left;
			this.right = right;
		}

		public Object eval(Env env) {
			boolean l = truthy(left.eval(env));
			if (op.equals("and") && !l) return false;
			if (op.equals("or") && l) return true;
			boolean r = truthy(right.eval(env));
			if (op.equals("implies")) return !l || r;
			if (op.equals("xor")) return l != r;
			return r; // "and" with a true left side, or "or" with a false one: the result is just the right side
		}
	}

	private static final class Compare implements Node {
		final String op;
		final Node left;
		final Node right;

		Compare(String op, Node left, Node right) {
			this.op = op;
			this.left = left;
			this.right = right;
		}

		public Object eval(Env env) {
			Object l = left.eval(env);
			Object r = right.eval(env);
			if (op.equals("=")) return java.util.Objects.equals(l, r);
			if (op.equals("<>")) return !java.util.Objects.equals(l, r);
			double a = number(l);
			double b = number(r);
			if (op.equals("<")) return a < b;
			if (op.equals(">")) return a > b;
			if (op.equals("<=")) return a <= b;
			return a >= b;
		}
	}

	private static final class Arith implements Node {
		final String op;
		final Node left;
		final Node right;

		Arith(String op, Node left, Node right) {
			this.op = op;
			this.left = left;
			this.right = right;
		}

		public Object eval(Env env) {
			double a = number(left.eval(env));
			double b = number(right.eval(env));
			double result;
			if (op.equals("+")) result = a + b;
			else if (op.equals("-")) result = a - b;
			else if (op.equals("*")) result = a * b;
			else if (op.equals("div")) result = Math.floor(a / b);
			else if (op.equals("mod")) result = a % b;
			else result = a / b;
			return result == Math.rint(result) && !Double.isInfinite(result) ? (Object) (int) result : (Object) result;
		}
	}

	/** <code>self.property</code>, evaluated over a single EObject or distributed over a collection ("collect" navigation). */
	private static final class Property implements Node {
		final Node target;
		final String name;

		Property(Node target, String name) {
			this.target = target;
			this.name = name;
		}

		public Object eval(Env env) {
			Object value = target.eval(env);
			if (value instanceof List) {
				List<Object> out = new ArrayList<Object>();
				for (Object item : (List<?>) value) out.add(property(item, name));
				return out;
			}
			return property(value, name);
		}

		private Object property(Object value, String name) {
			if (value == null) throw new OclError("No se puede navegar «" + name + "»: el valor es undefined.");
			if (!(value instanceof EObject)) throw new OclError("«" + name + "» no es una propiedad de " + value);
			EObject object = (EObject) value;
			EStructuralFeature feature = object.eClass().getEStructuralFeature(name);
			if (feature == null) throw new OclError("«" + object.eClass().getName() + "» no tiene la propiedad «" + name + "».");
			Object raw = object.eGet(feature);
			if (feature.isMany()) return new ArrayList<Object>((java.util.Collection<?>) raw);
			return raw;
		}
	}

	/** A no-argument or single-value operation, e.g. <code>size()</code>, <code>oclIsKindOf(Type)</code>. */
	private static final class Call implements Node {
		final Node target;
		final boolean arrow; // -> (collection) vs . (object, only for operations that take parentheses)
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

		public Object eval(Env env) {
			Object receiver = target.eval(env);
			if (!arrow) return dotCall(receiver, env);
			List<Object> collection = asCollection(receiver);
			return arrowCall(collection, env);
		}

		private Object dotCall(Object receiver, Env env) {
			if (name.equals("oclIsKindOf") || name.equals("oclIsTypeOf")) {
				EClass type = env.classes.find(typeName());
				if (type == null) throw new OclError("Tipo «" + typeName() + "» desconocido en esta expresión OCL.");
				if (receiver == null) return false;
				if (!(receiver instanceof EObject)) return false;
				EClass actual = ((EObject) receiver).eClass();
				return name.equals("oclIsTypeOf") ? actual.equals(type) : type.isSuperTypeOf(actual);
			}
			if (name.equals("oclIsUndefined")) return receiver == null;
			if (name.equals("oclAsType")) return receiver; // dynamic typing: nothing to convert
			if (name.equals("toUpperCase")) return String.valueOf(receiver).toUpperCase();
			if (name.equals("toLowerCase")) return String.valueOf(receiver).toLowerCase();
			if (name.equals("size") && receiver instanceof String) return ((String) receiver).length();
			throw new OclError("Operación «." + name + "» no soportada.");
		}

		private String typeName() {
			Node first = args.get(0);
			if (first instanceof VarRef) return ((VarRef) first).name;
			throw new OclError("Se esperaba un nombre de tipo en " + name + "(...)");
		}

		private Object arrowCall(List<Object> collection, Env env) {
			if (name.equals("size")) return collection.size();
			if (name.equals("isEmpty")) return collection.isEmpty();
			if (name.equals("notEmpty")) return !collection.isEmpty();
			if (name.equals("asSet") || name.equals("asBag") || name.equals("asSequence") || name.equals("asOrderedSet")) return collection;
			if (name.equals("first")) return collection.isEmpty() ? null : collection.get(0);
			if (name.equals("last")) return collection.isEmpty() ? null : collection.get(collection.size() - 1);
			if (name.equals("sum")) {
				double sum = 0;
				for (Object o : collection) sum += number(o);
				return sum == Math.rint(sum) ? (Object) (int) sum : (Object) sum;
			}
			if (name.equals("includes")) return collection.contains(args.get(0).eval(env));
			if (name.equals("excludes")) return !collection.contains(args.get(0).eval(env));
			if (name.equals("select") || name.equals("reject") || name.equals("exists") || name.equals("forAll") || name.equals("collect")) {
				List<Object> matched = new ArrayList<Object>();
				boolean anyMatch = false;
				boolean allMatch = true;
				for (Object item : collection) {
					Env inner = env.with(lambdaVar, item);
					boolean truth = truthy(lambdaBody.eval(inner));
					if (name.equals("select") && truth) matched.add(item);
					if (name.equals("reject") && !truth) matched.add(item);
					if (name.equals("collect")) matched.add(lambdaBody.eval(inner));
					anyMatch = anyMatch || truth;
					allMatch = allMatch && truth;
				}
				if (name.equals("exists")) return anyMatch;
				if (name.equals("forAll")) return allMatch;
				return matched;
			}
			throw new OclError("Operación «->" + name + "» no soportada.");
		}
	}

	@SuppressWarnings("unchecked")
	private static List<Object> asCollection(Object value) {
		if (value == null) return Collections.emptyList();
		if (value instanceof List) return (List<Object>) value;
		List<Object> single = new ArrayList<Object>(1);
		single.add(value);
		return single;
	}

	private static boolean truthy(Object value) {
		if (value instanceof Boolean) return (Boolean) value;
		throw new OclError("Se esperaba un valor booleano, no " + value);
	}

	private static double number(Object value) {
		if (value instanceof Number) return ((Number) value).doubleValue();
		throw new OclError("Se esperaba un número, no " + value);
	}

	// ---------------------------------------------------------- parser ----------------------------------------------------------

	/** Splits an .ocl source into <code>context X inv Name: expr</code> blocks and parses each expression. */
	static List<Constraint> parse(String source) {
		List<Constraint> constraints = new ArrayList<Constraint>();
		String withoutComments = stripComments(source);
		java.util.regex.Matcher header = java.util.regex.Pattern
				.compile("context\\s+(\\w+)\\s+inv(?:\\s+(\\w+))?\\s*:", java.util.regex.Pattern.MULTILINE)
				.matcher(withoutComments);
		List<int[]> spans = new ArrayList<int[]>();
		List<String[]> headers = new ArrayList<String[]>();
		while (header.find()) {
			spans.add(new int[] { header.start(), header.end() });
			headers.add(new String[] { header.group(1), header.group(2) });
		}
		for (int i = 0; i < spans.size(); i++) {
			int bodyStart = spans.get(i)[1];
			int bodyEnd = i + 1 < spans.size() ? spans.get(i + 1)[0] : withoutComments.length();
			String body = withoutComments.substring(bodyStart, bodyEnd).trim();
			String context = headers.get(i)[0];
			String name = headers.get(i)[1] != null ? headers.get(i)[1] : "inv" + (i + 1);
			if (body.isEmpty()) throw new OclError("La restricción «" + context + "::" + name + "» no tiene expresión.");
			Node expr;
			try {
				expr = new Parser(tokenize(body)).parseExpression();
			} catch (OclError e) {
				throw new OclError("«" + context + "::" + name + "»: " + e.getMessage());
			}
			constraints.add(new Constraint(context, name, body, expr));
		}
		return constraints;
	}

	/** Evaluates a parsed constraint's expression with <code>self</code> bound to the given object. */
	static boolean holds(Constraint constraint, EObject self, ClassLookup classes) {
		java.util.LinkedHashMap<String, Object> vars = new java.util.LinkedHashMap<String, Object>();
		vars.put("self", self);
		Object value = constraint.expr.eval(new Env(vars, classes));
		return truthy(value);
	}

	private static String stripComments(String source) {
		StringBuilder out = new StringBuilder(source.length());
		boolean inString = false;
		for (int i = 0; i < source.length(); i++) {
			char c = source.charAt(i);
			if (c == '\'' ) inString = !inString;
			if (!inString && c == '-' && i + 1 < source.length() && source.charAt(i + 1) == '-') {
				while (i < source.length() && source.charAt(i) != '\n') i++;
				out.append('\n');
				continue;
			}
			out.append(c);
		}
		return out.toString();
	}

	// --- tokenizer ---

	private static final class Token {
		final String kind; // ident, number, string, op, keyword, eof
		final String text;

		Token(String kind, String text) {
			this.kind = kind;
			this.text = text;
		}
	}

	private static final java.util.Set<String> KEYWORDS = new java.util.HashSet<String>(java.util.Arrays.asList(
			"and", "or", "xor", "not", "implies", "if", "then", "else", "endif", "let", "in", "true", "false", "self", "div", "mod"));

	private static List<Token> tokenize(String text) {
		List<Token> tokens = new ArrayList<Token>();
		int i = 0;
		int n = text.length();
		while (i < n) {
			char c = text.charAt(i);
			if (Character.isWhitespace(c)) {
				i++;
			} else if (Character.isDigit(c)) {
				int start = i;
				while (i < n && (Character.isDigit(text.charAt(i)) || text.charAt(i) == '.')) i++;
				tokens.add(new Token("number", text.substring(start, i)));
			} else if (Character.isLetter(c) || c == '_') {
				int start = i;
				while (i < n && (Character.isLetterOrDigit(text.charAt(i)) || text.charAt(i) == '_')) i++;
				String word = text.substring(start, i);
				tokens.add(new Token(KEYWORDS.contains(word) ? "keyword" : "ident", word));
			} else if (c == '\'') {
				int start = ++i;
				while (i < n && text.charAt(i) != '\'') i++;
				tokens.add(new Token("string", text.substring(start, i)));
				i++;
			} else if (c == '-' && i + 1 < n && text.charAt(i + 1) == '>') {
				tokens.add(new Token("op", "->"));
				i += 2;
			} else if (c == '<' && i + 1 < n && text.charAt(i + 1) == '>') {
				tokens.add(new Token("op", "<>"));
				i += 2;
			} else if ((c == '<' || c == '>') && i + 1 < n && text.charAt(i + 1) == '=') {
				tokens.add(new Token("op", text.substring(i, i + 2)));
				i += 2;
			} else if ("().,|=<>+-*/.".indexOf(c) >= 0) {
				tokens.add(new Token("op", String.valueOf(c)));
				i++;
			} else {
				throw new OclError("Carácter inesperado «" + c + "» en la expresión OCL.");
			}
		}
		tokens.add(new Token("eof", ""));
		return tokens;
	}

	/** Recursive-descent parser, precedence low to high: implies, or/xor, and, not, comparison, +-, * /, unary, postfix, primary. */
	private static final class Parser {
		private final List<Token> tokens;
		private int pos;

		Parser(List<Token> tokens) {
			this.tokens = tokens;
		}

		Node parseExpression() {
			Node node = implication();
			expect("eof");
			return node;
		}

		private Token peek() {
			return tokens.get(pos);
		}

		private boolean atKeyword(String word) {
			Token t = peek();
			return t.kind.equals("keyword") && t.text.equals(word);
		}

		private boolean atOp(String op) {
			Token t = peek();
			return t.kind.equals("op") && t.text.equals(op);
		}

		private Token advance() {
			return tokens.get(pos++);
		}

		private void expect(String kind) {
			if (!peek().kind.equals(kind)) throw new OclError("Se esperaba " + kind + " pero se encontró «" + peek().text + "».");
			pos++;
		}

		private Node implication() {
			Node left = orExpr();
			while (atKeyword("implies")) {
				advance();
				left = new BoolOp("implies", left, orExpr());
			}
			return left;
		}

		private Node orExpr() {
			Node left = andExpr();
			while (atKeyword("or") || atKeyword("xor")) {
				String op = advance().text;
				left = new BoolOp(op, left, andExpr());
			}
			return left;
		}

		private Node andExpr() {
			Node left = notExpr();
			while (atKeyword("and")) {
				advance();
				left = new BoolOp("and", left, notExpr());
			}
			return left;
		}

		private Node notExpr() {
			if (atKeyword("not")) {
				advance();
				return new Not(notExpr());
			}
			return comparison();
		}

		private Node comparison() {
			Node left = additive();
			if (atOp("=") || atOp("<>") || atOp("<") || atOp(">") || atOp("<=") || atOp(">=")) {
				String op = advance().text;
				return new Compare(op, left, additive());
			}
			return left;
		}

		private Node additive() {
			Node left = multiplicative();
			while (atOp("+") || atOp("-")) {
				String op = advance().text;
				left = new Arith(op, left, multiplicative());
			}
			return left;
		}

		private Node multiplicative() {
			Node left = unary();
			while (atOp("*") || atOp("/") || atKeyword("div") || atKeyword("mod")) {
				String op = advance().text;
				left = new Arith(op, left, unary());
			}
			return left;
		}

		private Node unary() {
			if (atOp("-")) {
				advance();
				final Node inner = unary();
				return new Node() {
					public Object eval(Env env) {
						return -number(inner.eval(env));
					}
				};
			}
			return postfix();
		}

		private Node postfix() {
			Node node = primary();
			while (true) {
				if (isDot()) {
					advance();
					String name = advance().text;
					// a dotted name with no parentheses is a property; with parentheses it's an operation (e.g. oclIsKindOf(X))
					node = atOp("(") ? callArgs(node, false, name) : new Property(node, name);
				} else if (atOp("->")) {
					advance();
					node = callArgs(node, true, advance().text);
				} else {
					break;
				}
			}
			return node;
		}

		private boolean isDot() {
			return peek().kind.equals("op") && peek().text.equals(".");
		}

		private Node callArgs(Node target, boolean arrow, String name) {
			List<Node> args = new ArrayList<Node>();
			String lambdaVar = null;
			Node lambdaBody = null;
			if (atOp("(")) {
				advance();
				if (!atOp(")")) {
					if (isLambdaAhead()) {
						lambdaVar = advance().text;
						expect2("|");
						lambdaBody = implication();
					} else {
						args.add(implication());
						while (atOp(",")) {
							advance();
							args.add(implication());
						}
					}
				}
				expect2(")");
			}
			return new Call(target, arrow, name, args, lambdaVar, lambdaBody);
		}

		/** Look-ahead: <code>ident |</code> right after the opening paren means a lambda (this subset takes one iterator variable). */
		private boolean isLambdaAhead() {
			return peek().kind.equals("ident") && tokens.get(pos + 1).kind.equals("op") && tokens.get(pos + 1).text.equals("|");
		}

		private void expect2(String op) {
			if (!atOp(op)) throw new OclError("Se esperaba «" + op + "» pero se encontró «" + peek().text + "».");
			advance();
		}

		private Node primary() {
			Token t = peek();
			if (t.kind.equals("keyword") && t.text.equals("self")) {
				advance();
				return new SelfRef();
			}
			if (t.kind.equals("keyword") && (t.text.equals("true") || t.text.equals("false"))) {
				advance();
				return new Lit(Boolean.valueOf(t.text));
			}
			if (t.kind.equals("keyword") && t.text.equals("if")) return ifExpr();
			if (t.kind.equals("keyword") && t.text.equals("let")) return letExpr();
			if (t.kind.equals("number")) {
				advance();
				return t.text.indexOf('.') >= 0 ? new Lit(Double.parseDouble(t.text)) : new Lit(Integer.parseInt(t.text));
			}
			if (t.kind.equals("string")) {
				advance();
				return new Lit(t.text);
			}
			if (t.kind.equals("ident")) {
				advance();
				return new VarRef(t.text);
			}
			if (atOp("(")) {
				advance();
				Node inner = implication();
				expect2(")");
				return inner;
			}
			throw new OclError("No se esperaba «" + t.text + "» aquí.");
		}

		private Node ifExpr() {
			advance();
			final Node cond = implication();
			if (!atKeyword("then")) throw new OclError("Se esperaba «then».");
			advance();
			final Node whenTrue = implication();
			if (!atKeyword("else")) throw new OclError("Se esperaba «else».");
			advance();
			final Node whenFalse = implication();
			if (!atKeyword("endif")) throw new OclError("Se esperaba «endif».");
			advance();
			return new Node() {
				public Object eval(Env env) {
					return truthy(cond.eval(env)) ? whenTrue.eval(env) : whenFalse.eval(env);
				}
			};
		}

		private Node letExpr() {
			advance();
			final String name = advance().text;
			expect2("=");
			final Node value = implication();
			if (!atKeyword("in")) throw new OclError("Se esperaba «in».");
			advance();
			final Node body = implication();
			return new Node() {
				public Object eval(Env env) {
					return body.eval(env.with(name, value.eval(env)));
				}
			};
		}
	}
}
