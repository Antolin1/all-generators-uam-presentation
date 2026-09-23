package org.satgen.server;

import java.util.HashSet;
import java.util.Set;

import org.sat4j.core.VecInt;
import org.sat4j.minisat.SolverFactory;
import org.sat4j.specs.ContradictionException;
import org.sat4j.specs.IProblem;
import org.sat4j.specs.ISolver;
import org.sat4j.specs.TimeoutException;

/** A thin wrapper around SAT4J: hands it a {@link Cnf} and reports whether it is satisfiable and, if so, which literals are true. */
final class Solver {

	static final class Result {
		final boolean sat;
		final Set<Integer> trueVars; // variable numbers (not literals) that came out true
		final long millis;
		final int variables, clauses;

		Result(boolean sat, Set<Integer> trueVars, long millis, int variables, int clauses) {
			this.sat = sat;
			this.trueVars = trueVars;
			this.millis = millis;
			this.variables = variables;
			this.clauses = clauses;
		}

		boolean isTrue(int var) {
			return trueVars.contains(var);
		}
	}

	static Result solve(Cnf cnf, long timeoutSeconds) {
		long start = System.currentTimeMillis();
		ISolver solver = SolverFactory.newDefault();
		solver.setTimeout((int) timeoutSeconds);
		solver.newVar(cnf.variableCount());
		solver.setExpectedNumberOfClauses(cnf.clauses().size());
		try {
			for (int[] clause : cnf.clauses()) solver.addClause(new VecInt(clause));
			IProblem problem = solver;
			boolean sat = problem.isSatisfiable();
			Set<Integer> trueVars = new HashSet<>();
			if (sat) {
				int[] model = problem.model();
				for (int lit : model) if (lit > 0) trueVars.add(lit);
			}
			return new Result(sat, trueVars, System.currentTimeMillis() - start, cnf.variableCount(), cnf.clauses().size());
		} catch (ContradictionException e) {
			// SAT4J throws this when a clause is trivially unsatisfiable on its own (e.g. two contradictory unit clauses)
			return new Result(false, Set.of(), System.currentTimeMillis() - start, cnf.variableCount(), cnf.clauses().size());
		} catch (TimeoutException e) {
			throw new RuntimeException("El resolutor SAT superó el tiempo límite (" + timeoutSeconds + " s).", e);
		}
	}
}
