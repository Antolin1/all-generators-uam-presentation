package org.satgen.server;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A CNF formula under construction: variable allocation, unit/binary/ternary clauses, and a small set of
 * Tseitin-encoded boolean gates (and/or/not/xor/implies) and a binary "popcount" adder with a constant
 * comparator, so that arbitrary boolean OCL expressions — including {@code size() OP n} — can be compiled
 * into a single literal usable inside a larger expression, not just asserted at the top level.
 *
 * <p>A literal is a non-zero int, DIMACS-style: variable {@code v} is the literal {@code v}, its negation
 * {@code -v}. Two fixed literals, {@link #TRUE} and {@link #FALSE}, are pinned to a value by a unit clause.
 */
public final class Cnf {

	private int nextVar = 1;
	private final List<int[]> clauses = new ArrayList<>();
	private final Map<Integer, String> names = new LinkedHashMap<>();
	public final int TRUE;
	public final int FALSE;

	public Cnf() {
		TRUE = newVar();
		FALSE = newVar();
		assertClause(TRUE);
		assertClause(-FALSE);
	}

	public int newVar() {
		return nextVar++;
	}

	public int variableCount() {
		return nextVar - 1;
	}

	public List<int[]> clauses() {
		return clauses;
	}

	/** A human-readable name for a variable (only {@link Vars}' `existe`/`enlace` variables get one; auxiliary
	 * Tseitin variables from the gates below stay anonymous — there would be too many to name meaningfully). */
	public void name(int variable, String label) {
		names.putIfAbsent(variable, label);
	}

	/**
	 * The formula as DIMACS CNF text, with the named variables listed as leading comments — this is the actual
	 * "SAT code" a satisfiability solver reads: {@code p cnf <vars> <clauses>} followed by one clause per line,
	 * each literal a signed variable number, terminated by a {@code 0}.
	 */
	public String toDimacs() {
		return toDimacs(Integer.MAX_VALUE);
	}

	/** Same as {@link #toDimacs()}, but showing at most {@code maxClauseLines} clauses (plus a note if more were left out). */
	public String toDimacs(int maxClauseLines) {
		StringBuilder out = new StringBuilder();
		out.append("c Generado por sat-generator: la codificación SAT de \"¿existe un modelo dentro de este scope?\".\n");
		out.append("c Cada objeto candidato y cada posible enlace entre dos objetos es una variable booleana:\n");
		out.append("c   ").append(names.size()).append(" de ").append(variableCount()).append(" variables tienen nombre (existe/enlace);\n");
		out.append("c   el resto son variables auxiliares de las puertas booleanas (Tseitin) que compilan la lógica y las comparaciones.\n");
		out.append("c\n");
		for (Map.Entry<Integer, String> entry : names.entrySet()) {
			out.append("c ").append(entry.getKey()).append(' ').append(entry.getValue()).append('\n');
		}
		out.append("c\n");
		out.append("p cnf ").append(variableCount()).append(' ').append(clauses.size()).append('\n');
		int shown = Math.min(clauses.size(), maxClauseLines);
		for (int i = 0; i < shown; i++) {
			for (int literal : clauses.get(i)) out.append(literal).append(' ');
			out.append("0\n");
		}
		if (shown < clauses.size()) {
			out.append("c … y ").append(clauses.size() - shown).append(" cláusulas más (omitidas aquí para no sobrecargar la respuesta; el resolutor sí las usó todas).\n");
		}
		return out.toString();
	}

	public void assertClause(int... literals) {
		clauses.add(literals);
	}

	/** {@code x <=> a AND b}, returning {@code x}. */
	public int and(int a, int b) {
		if (a == FALSE || b == FALSE) return FALSE;
		if (a == TRUE) return b;
		if (b == TRUE) return a;
		int x = newVar();
		assertClause(-x, a);
		assertClause(-x, b);
		assertClause(x, -a, -b);
		return x;
	}

	/** {@code x <=> a OR b}, returning {@code x}. */
	public int or(int a, int b) {
		return -and(-a, -b);
	}

	public int not(int a) {
		return -a;
	}

	/** {@code x <=> a XOR b}, returning {@code x}. */
	public int xor(int a, int b) {
		if (a == FALSE) return b;
		if (b == FALSE) return a;
		if (a == TRUE) return not(b);
		if (b == TRUE) return not(a);
		int x = newVar();
		assertClause(-x, a, b);
		assertClause(-x, -a, -b);
		assertClause(x, -a, b);
		assertClause(x, a, -b);
		return x;
	}

	/** {@code a IMPLIES b}, as a literal (not asserted). */
	public int implies(int a, int b) {
		return or(not(a), b);
	}

	public int andAll(List<Integer> literals) {
		int acc = TRUE;
		for (int l : literals) acc = and(acc, l);
		return acc;
	}

	public int orAll(List<Integer> literals) {
		int acc = FALSE;
		for (int l : literals) acc = or(acc, l);
		return acc;
	}

	/** Asserts {@code a <=> b} (used to force an inactive slot's incident literals to false, etc.). */
	public void assertIff(int a, int b) {
		assertClause(-a, b);
		assertClause(a, -b);
	}

	public void assertImplies(int a, int b) {
		assertClause(-a, b);
	}

	/**
	 * A non-negative binary number built out of literals (a "popcount"): {@code bits.get(0)} is the least
	 * significant bit. Produced by {@link #popcount} and consumed by {@link #compare}.
	 */
	public static final class Bits {
		final List<Integer> bits; // LSB first

		Bits(List<Integer> bits) {
			this.bits = bits;
		}
	}

	/** How many of {@code literals} are true, as a {@link Bits} built with a ripple-carry adder tree. */
	public Bits popcount(List<Integer> literals) {
		List<Bits> ones = new ArrayList<>();
		for (int l : literals) {
			List<Integer> single = new ArrayList<>(1);
			single.add(l);
			ones.add(new Bits(single));
		}
		if (ones.isEmpty()) {
			List<Integer> zero = new ArrayList<>(1);
			zero.add(FALSE);
			return new Bits(zero);
		}
		while (ones.size() > 1) {
			List<Bits> next = new ArrayList<>();
			for (int i = 0; i + 1 < ones.size(); i += 2) next.add(add(ones.get(i), ones.get(i + 1)));
			if (ones.size() % 2 == 1) next.add(ones.get(ones.size() - 1));
			ones = next;
		}
		return ones.get(0);
	}

	/** Ripple-carry addition of two binary numbers (LSB-first bit lists), each Tseitin-encoded gate by gate. */
	private Bits add(Bits a, Bits b) {
		int n = Math.max(a.bits.size(), b.bits.size());
		List<Integer> sum = new ArrayList<>();
		int carry = FALSE;
		for (int i = 0; i < n; i++) {
			int ai = i < a.bits.size() ? a.bits.get(i) : FALSE;
			int bi = i < b.bits.size() ? b.bits.get(i) : FALSE;
			int axb = xor(ai, bi);
			sum.add(xor(axb, carry));
			// carry-out = majority(ai, bi, carry) = (ai AND bi) OR (carry AND (ai XOR bi))
			carry = or(and(ai, bi), and(carry, axb));
		}
		sum.add(carry);
		return new Bits(sum);
	}

	/** {@code n} fresh literals as a free (solver-chosen) binary number, MSB unconstrained. */
	public Bits freshBits(int width) {
		List<Integer> bits = new ArrayList<>(width);
		for (int i = 0; i < width; i++) bits.add(newVar());
		return new Bits(bits);
	}

	/** {@code value(bits) + 1}, as a new {@link Bits} one bit wider. */
	public Bits increment(Bits bits) {
		List<Integer> one = new ArrayList<>(1);
		one.add(TRUE);
		return add(bits, new Bits(one));
	}

	/** {@code value(a) = value(b)}, as a literal (bit lists of different lengths are zero-extended). */
	public int equal(Bits a, Bits b) {
		int n = Math.max(a.bits.size(), b.bits.size());
		int acc = TRUE;
		for (int i = 0; i < n; i++) {
			int ai = i < a.bits.size() ? a.bits.get(i) : FALSE;
			int bi = i < b.bits.size() ? b.bits.get(i) : FALSE;
			acc = and(acc, not(xor(ai, bi)));
		}
		return acc;
	}

	private long maxValue(List<Integer> bits) {
		return (1L << bits.size()) - 1;
	}

	/** {@code value(bits) >= n}, as a literal. */
	public int geConst(Bits bits, long n) {
		return geConst(bits.bits, bits.bits.size() - 1, n);
	}

	// `index` is the current (MSB-down) position into a LSB-first list; `weight` = 2^index.
	private int geConst(List<Integer> bits, int index, long n) {
		if (n <= 0) return TRUE;
		if (index < 0) return FALSE; // no bits left, value is 0
		long weight = 1L << index;
		int msb = bits.get(index);
		if (n >= weight) {
			return and(msb, geConst(bits, index - 1, n - weight));
		}
		return or(msb, geConst(bits, index - 1, n));
	}

	/** {@code value(bits) OP n}, as a literal. {@code op} is one of {@code = <> < > <= >=}. */
	public int compare(Bits bits, String op, long n) {
		switch (op) {
			case ">=":
				return geConst(bits, n);
			case ">":
				return geConst(bits, n + 1);
			case "<":
				return not(geConst(bits, n));
			case "<=":
				return not(geConst(bits, n + 1));
			case "=":
				if (n < 0 || n > maxValue(bits.bits)) return FALSE;
				return and(geConst(bits, n), not(geConst(bits, n + 1)));
			case "<>":
				return not(compare(bits, "=", n));
			default:
				throw new IllegalArgumentException("Operador de comparación desconocido: " + op);
		}
	}

	/** Convenience: {@code (#true among literals) OP n}, as a literal. */
	public int cardinalityCompare(List<Integer> literals, String op, long n) {
		if (n == 0 && op.equals("=")) return andAll(negateAll(literals));
		if (n == 0 && op.equals("<>")) return orAll(literals);
		if (n == 0 && op.equals(">=")) return TRUE;
		if (n == 0 && op.equals(">")) return orAll(literals);
		if (n <= 0 && op.equals("<=")) return n == 0 ? andAll(negateAll(literals)) : FALSE;
		return compare(popcount(literals), op, n);
	}

	private List<Integer> negateAll(List<Integer> literals) {
		List<Integer> out = new ArrayList<>(literals.size());
		for (int l : literals) out.add(not(l));
		return out;
	}

	/** Asserts that at most {@code k} of {@code literals} are true (a plain clause list, no output literal). */
	public void assertAtMost(List<Integer> literals, int k) {
		if (k >= literals.size()) return;
		assertClause(cardinalityCompare(literals, "<=", k));
	}

	/** Asserts that at least {@code k} of {@code literals} are true. */
	public void assertAtLeast(List<Integer> literals, int k) {
		if (k <= 0) return;
		assertClause(cardinalityCompare(literals, ">=", k));
	}

	/** Asserts that exactly {@code k} of {@code literals} are true. */
	public void assertExactly(List<Integer> literals, int k) {
		assertAtLeast(literals, k);
		assertAtMost(literals, k);
	}
}
