package org.satgen.server;

import java.util.LinkedHashMap;
import java.util.Map;

import org.eclipse.emf.ecore.EClass;

/**
 * The bounds the user asks the solver to search within: a root class (exactly one instance of it, with no
 * container), and, per class (own bounds; subclasses count towards an ancestor's bounds too, same convention
 * as the other generators in this repo), a minimum and maximum number of instances. Unlike a random generator,
 * these are not "approximate" — they are the actual bounds of the search, and the solver decides whether a
 * model exists within them (and which one) or reports that none does.
 *
 * <p>Nothing is bounded unless the user bounds it: a class with no {@code max} can be as large as the overall
 * budget allows (its own {@code min}, if any, never shrinks that). The budget is the user's own {@code totalMax}
 * when given; only when the request bounds <em>nothing at all</em> does a modest internal default kick in, so
 * that a request that says nothing about size still produces a finite (and fast) SAT problem.
 */
final class Scope {

	/** Used only when the request gives no {@code totalMax} at all — a class with no {@code max} needs some
	 * concrete pool size to encode, and this one applies to every such class independently (not shared out
	 * between them), so it has to stay modest for the encoding to stay fast when nothing was actually asked for. */
	static final int DEFAULT_BUDGET = 6;
	/** A hard ceiling on the budget (however it was derived), purely to protect the server from an request
	 * that would make the encoding unmanageably large — not a modelling limit. */
	static final int SAFETY_CAP = 500;

	final String rootClassName;
	final Map<String, int[]> bounds; // className -> {min, max}; -1 = unbounded
	final Integer totalMin, totalMax;
	final int budget; // the pool size given to any class with no explicit max

	private Scope(String rootClassName, Map<String, int[]> bounds, Integer totalMin, Integer totalMax, int budget) {
		this.rootClassName = rootClassName;
		this.bounds = bounds;
		this.totalMin = totalMin;
		this.totalMax = totalMax;
		this.budget = budget;
	}

	static final class ScopeError extends RuntimeException {
		ScopeError(String message) {
			super(message);
		}
	}

	@SuppressWarnings("unchecked")
	static Scope fromPayload(Map<String, Object> payload, MetaModel mm) {
		String root = String.valueOf(payload.getOrDefault("rootClass", ""));
		EClass rootClass = mm.byName.get(root);
		if (rootClass == null) throw new ScopeError("La clase raíz «" + root + "» no existe en el metamodelo.");
		if (mm.concreteSubtypes(rootClass).isEmpty()) throw new ScopeError("«" + root + "» no tiene ninguna subclase concreta: no puede tener instancias.");

		Map<String, int[]> bounds = new LinkedHashMap<>();
		Object rawBounds = payload.get("classBounds");
		if (rawBounds instanceof Map) {
			for (var entry : ((Map<String, Object>) rawBounds).entrySet()) {
				EClass c = mm.byName.get(entry.getKey());
				if (c == null) throw new ScopeError("La clase «" + entry.getKey() + "» no existe en el metamodelo.");
				Map<String, Object> range = (Map<String, Object>) entry.getValue();
				int min = intOr(range.get("min"), -1);
				int max = intOr(range.get("max"), -1);
				if (min >= 0 && max >= 0 && min > max) throw new ScopeError("En «" + entry.getKey() + "», el mínimo no puede superar al máximo.");
				bounds.put(entry.getKey(), new int[] { min, max });
			}
		}
		Integer totalMin = payload.get("totalMin") instanceof Number n ? n.intValue() : null;
		Integer totalMax = payload.get("totalMax") instanceof Number n ? n.intValue() : null;
		if (totalMin != null && totalMax != null && totalMin > totalMax) throw new ScopeError("El total mínimo no puede superar al máximo.");

		int budget = totalMax != null ? totalMax : DEFAULT_BUDGET;
		if (budget > SAFETY_CAP) {
			throw new ScopeError("El total pedido (" + budget + ") supera el máximo de " + SAFETY_CAP + " que soporta este generador (por rendimiento, no por el modelo).");
		}
		return new Scope(root, bounds, totalMin, totalMax, budget);
	}

	private static int intOr(Object value, int fallback) {
		return value instanceof Number n ? n.intValue() : fallback;
	}

	int min(EClass c) {
		int[] b = bounds.get(c.getName());
		return b == null || b[0] < 0 ? 0 : b[0];
	}

	boolean hasMax(EClass c) {
		int[] b = bounds.get(c.getName());
		return b != null && b[1] >= 0;
	}

	/** {@code c}'s declared max, or — if it has none — the scope's budget: unbounded means "as big as the search allows". */
	int max(EClass c) {
		int[] b = bounds.get(c.getName());
		return b == null || b[1] < 0 ? budget : b[1];
	}
}
