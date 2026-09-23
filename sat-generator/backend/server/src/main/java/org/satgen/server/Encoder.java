package org.satgen.server;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.eclipse.emf.ecore.EClass;

/**
 * Builds the whole "does a model within these bounds exist" problem as CNF: a candidate pool of objects per
 * concrete class, well-formedness (association-end multiplicities, a single-rooted containment forest) and
 * the OCL invariants that {@link Ocl2Sat} could compile. What it produces is handed to a SAT solver; a
 * satisfying assignment decodes directly into which candidate objects and links actually belong to the model.
 */
final class Encoder {

	/** Bits for the per-object containment "rank" used to rule out cycles; 60 objects max, so plenty of headroom. */
	private static final int DEPTH_BITS = 7;

	static final class Result {
		final Cnf cnf;
		final Vars vars;
		final Map<EClass, Integer> pool;
		final List<String> translatedConstraints;
		final List<String> untranslatedConstraints; // "Context::Name: reason" — only checked afterwards, via USE

		Result(Cnf cnf, Vars vars, Map<EClass, Integer> pool, List<String> translated, List<String> untranslated) {
			this.cnf = cnf;
			this.vars = vars;
			this.pool = pool;
			this.translatedConstraints = translated;
			this.untranslatedConstraints = untranslated;
		}
	}

	static Result build(MetaModel mm, Scope scope, List<Ocl2Sat.Constraint> constraints) {
		Cnf cnf = new Cnf();
		Vars vars = new Vars(cnf);
		Map<EClass, Integer> pool = new LinkedHashMap<>();
		for (EClass c : mm.concreteClasses) pool.put(c, Math.max(scope.min(c), scope.max(c)));

		// A class with no max of its own gets the scope's budget as its pool (see Scope#max), so this only fires
		// when the classes that DO have an explicit max still can't add up to the requested total — a real
		// contradiction, not an artifact of a hidden default, worth explaining instead of a bare UNSAT.
		int totalPool = pool.values().stream().mapToInt(Integer::intValue).sum();
		if (scope.totalMin != null && scope.totalMin > totalPool) {
			throw new Scope.ScopeError("Pides un total de al menos " + scope.totalMin + " objetos, pero las cotas máximas de las clases solo suman "
					+ totalPool + " en total. Sube el máximo de alguna clase, o quítaselo para que no tenga cota propia.");
		}

		classCountBounds(mm, scope, pool, vars, cnf);
		exactlyOneRoot(mm, scope, pool, vars, cnf);
		associationMultiplicities(mm, pool, vars, cnf);
		EClass rootClass = mm.byName.get(scope.rootClassName);
		containmentForest(mm, pool, vars, cnf, rootClass);
		containmentAcyclic(mm, pool, vars, cnf);

		Ocl2Sat.PoolSize poolSize = pool::get;
		List<String> translated = new ArrayList<>();
		List<String> untranslated = new ArrayList<>();
		for (Ocl2Sat.Constraint c : constraints) {
			EClass ctxClass = mm.byName.get(c.context);
			if (ctxClass == null) {
				untranslated.add(c.context + "::" + c.name + ": la clase de contexto no existe en este metamodelo.");
				continue;
			}
			boolean any = false;
			String failure = null;
			for (EClass concrete : mm.concreteSubtypes(ctxClass)) {
				int n = pool.get(concrete);
				for (int slot = 0; slot < n; slot++) {
					Ocl2Sat.Ctx ctx = new Ocl2Sat.Ctx(cnf, vars, mm, poolSize, concrete, slot);
					try {
						int lit = Ocl2Sat.compile(c, ctx);
						cnf.assertImplies(vars.active(concrete.getName(), slot), lit);
						any = true;
					} catch (Ocl2Sat.Unsupported e) {
						failure = e.getMessage();
					}
				}
			}
			if (failure != null) untranslated.add(c.context + "::" + c.name + ": " + failure);
			else if (any) translated.add(c.context + "::" + c.name);
		}
		return new Result(cnf, vars, pool, translated, untranslated);
	}

	/**
	 * The candidate pool for every concrete class: a class with an explicit max gets exactly that; the scope's
	 * budget left over after reserving those is split evenly among the classes with no max of their own (so
	 * "no bound" means "as big as the search can afford", without every unbounded class separately claiming the
	 * whole budget for itself — which would multiply the problem size by however many classes are left unbounded).
	 */
	private static Map<EClass, Integer> pools(MetaModel mm, Scope scope) {
		Map<EClass, Integer> pool = new LinkedHashMap<>();
		List<EClass> unbounded = new ArrayList<>();
		int reserved = 0;
		for (EClass c : mm.concreteClasses) {
			if (scope.hasMax(c)) {
				pool.put(c, scope.max(c));
				reserved += scope.max(c);
			} else {
				unbounded.add(c);
			}
		}
		if (!unbounded.isEmpty()) {
			int remaining = Math.max(scope.budget - reserved, unbounded.size());
			int share = Math.max(1, remaining / unbounded.size());
			for (EClass c : unbounded) pool.put(c, Math.max(scope.min(c), share));
		}
		return pool;
	}

	/** Bounds on how many instances of a (possibly abstract) class may be active, counting its subclasses too. */
	private static void classCountBounds(MetaModel mm, Scope scope, Map<EClass, Integer> pool, Vars vars, Cnf cnf) {
		for (String className : scope.bounds.keySet()) {
			EClass named = mm.byName.get(className);
			if (named == null) continue;
			List<Integer> actives = activesOf(mm, pool, vars, named);
			int min = scope.min(named), max = scope.max(named);
			if (min > 0) cnf.assertAtLeast(actives, min);
			cnf.assertAtMost(actives, max);
		}
		if (scope.totalMin != null || scope.totalMax != null) {
			List<Integer> all = new ArrayList<>();
			for (EClass c : mm.concreteClasses) for (int s = 0; s < pool.get(c); s++) all.add(vars.active(c.getName(), s));
			if (scope.totalMin != null) cnf.assertAtLeast(all, scope.totalMin);
			if (scope.totalMax != null) cnf.assertAtMost(all, scope.totalMax);
		}
	}

	private static void exactlyOneRoot(MetaModel mm, Scope scope, Map<EClass, Integer> pool, Vars vars, Cnf cnf) {
		EClass root = mm.byName.get(scope.rootClassName);
		cnf.assertExactly(activesOf(mm, pool, vars, root), 1);
	}

	private static List<Integer> activesOf(MetaModel mm, Map<EClass, Integer> pool, Vars vars, EClass named) {
		List<Integer> actives = new ArrayList<>();
		for (EClass c : mm.concreteSubtypes(named)) for (int s = 0; s < pool.get(c); s++) actives.add(vars.active(c.getName(), s));
		return actives;
	}

	/** For every relationship: a link needs both ends active, and each object's own end respects its declared multiplicity. */
	private static void associationMultiplicities(MetaModel mm, Map<EClass, Integer> pool, Vars vars, Cnf cnf) {
		for (MetaModel.Ref ref : mm.refs) {
			List<EClass> owners = mm.concreteSubtypes(ref.owner);
			List<EClass> targets = mm.concreteSubtypes(ref.target);
			Map<String, List<Integer>> incomingByTarget = new LinkedHashMap<>();

			for (EClass oc : owners) {
				int on = pool.get(oc);
				for (int os = 0; os < on; os++) {
					int ownerActive = vars.active(oc.getName(), os);
					List<Integer> outgoing = new ArrayList<>();
					for (EClass tc : targets) {
						int tn = pool.get(tc);
						for (int ts = 0; ts < tn; ts++) {
							int link = vars.link(ref.index, oc.getName(), os, tc.getName(), ts);
							int targetActive = vars.active(tc.getName(), ts);
							cnf.assertImplies(link, ownerActive);
							cnf.assertImplies(link, targetActive);
							outgoing.add(link);
							incomingByTarget.computeIfAbsent(tc.getName() + "#" + ts, k -> new ArrayList<>()).add(link);
						}
					}
					boundConditionally(cnf, ownerActive, outgoing, ref.ownerLower, ref.ownerUpper);
				}
			}
			if (ref.roleFromTarget != null) {
				for (EClass tc : targets) {
					int tn = pool.get(tc);
					for (int ts = 0; ts < tn; ts++) {
						int targetActive = vars.active(tc.getName(), ts);
						List<Integer> incoming = incomingByTarget.getOrDefault(tc.getName() + "#" + ts, List.of());
						boundConditionally(cnf, targetActive, incoming, ref.targetLower, ref.targetUpper);
					}
				}
			}
		}
	}

	/**
	 * "At most one incoming containment link" (see {@link #containmentForest}) allows several disjoint cycles
	 * (every node in a cycle still has in-degree exactly one) — it just doesn't guarantee a <em>tree</em>. This
	 * gives every candidate object a free "rank" and forces it to strictly increase along every containment
	 * link that turns out to be active; a cycle would need a rank strictly greater than itself, which is
	 * unsatisfiable, so the solver simply cannot produce one.
	 */
	private static void containmentAcyclic(MetaModel mm, Map<EClass, Integer> pool, Vars vars, Cnf cnf) {
		Map<String, Cnf.Bits> depth = new LinkedHashMap<>();
		for (MetaModel.Ref ref : mm.refs) {
			if (!ref.containment) continue;
			for (EClass oc : mm.concreteSubtypes(ref.owner)) {
				int on = pool.get(oc);
				for (int os = 0; os < on; os++) {
					Cnf.Bits ownerDepth = depth.computeIfAbsent(oc.getName() + "#" + os, k -> cnf.freshBits(DEPTH_BITS));
					Cnf.Bits ownerNext = cnf.increment(ownerDepth);
					for (EClass tc : mm.concreteSubtypes(ref.target)) {
						int tn = pool.get(tc);
						for (int ts = 0; ts < tn; ts++) {
							int link = vars.link(ref.index, oc.getName(), os, tc.getName(), ts);
							Cnf.Bits targetDepth = depth.computeIfAbsent(tc.getName() + "#" + ts, k -> cnf.freshBits(DEPTH_BITS));
							cnf.assertImplies(link, cnf.equal(targetDepth, ownerNext));
						}
					}
				}
			}
		}
	}

	private static void boundConditionally(Cnf cnf, int guard, List<Integer> literals, int lower, int upper) {
		if (lower <= 0 && upper < 0) return; // unconstrained
		if (lower > 0) cnf.assertImplies(guard, cnf.cardinalityCompare(literals, ">=", lower));
		if (upper >= 0) cnf.assertImplies(guard, cnf.cardinalityCompare(literals, "<=", upper));
	}

	/**
	 * Every active object of a containable class has exactly one containment parent, except instances of the
	 * (possibly abstract) root class, which may have none — that is how the model ends up a single tree instead
	 * of a disconnected forest or a graph with cycles through containment.
	 */
	private static void containmentForest(MetaModel mm, Map<EClass, Integer> pool, Vars vars, Cnf cnf, EClass rootClass) {
		for (EClass c : mm.concreteClasses) {
			List<MetaModel.Ref> refsIn = mm.containmentRefsInto(c);
			if (refsIn.isEmpty()) continue;
			boolean rootEligible = rootClass.isSuperTypeOf(c);
			int n = pool.get(c);
			for (int cs = 0; cs < n; cs++) {
				List<Integer> incoming = new ArrayList<>();
				for (MetaModel.Ref ref : refsIn) {
					for (EClass oc : mm.concreteSubtypes(ref.owner)) {
						int on = pool.get(oc);
						for (int os = 0; os < on; os++) incoming.add(vars.link(ref.index, oc.getName(), os, c.getName(), cs));
					}
				}
				cnf.assertAtMost(incoming, 1);
				if (!rootEligible) {
					int active = vars.active(c.getName(), cs);
					cnf.assertImplies(active, cnf.cardinalityCompare(incoming, ">=", 1));
				}
			}
		}
	}
}
