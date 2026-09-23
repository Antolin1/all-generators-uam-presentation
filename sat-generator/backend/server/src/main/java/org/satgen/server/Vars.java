package org.satgen.server;

import java.util.HashMap;
import java.util.Map;


/**
 * The boolean variables of the encoding: whether a candidate object slot is actually part of the model
 * ({@link #active}), and whether two candidate slots are linked across a given relationship ({@link #link}).
 * Both are created lazily (the first read of a pair allocates it), so the {@link MetaModel.Ref#index} +
 * class-name + slot keys are all that is needed to address them from both the constraint encoder and the
 * OCL-to-SAT compiler.
 */
final class Vars {

	private final Cnf cnf;
	private final Map<String, Integer> activeVars = new HashMap<>();
	private final Map<String, Integer> linkVars = new HashMap<>();

	Vars(Cnf cnf) {
		this.cnf = cnf;
	}

	int active(String className, int slot) {
		String key = className + "#" + slot;
		return activeVars.computeIfAbsent(key, k -> {
			int v = cnf.newVar();
			cnf.name(v, "existe(" + key + ")");
			return v;
		});
	}

	/** The link variable for {@code Ref#index}, from an `owner` slot to a `target` slot (the Ref's own, forward, direction). */
	int link(int refIndex, String ownerClass, int ownerSlot, String targetClass, int targetSlot) {
		String key = refIndex + "|" + ownerClass + "#" + ownerSlot + "|" + targetClass + "#" + targetSlot;
		return linkVars.computeIfAbsent(key, k -> {
			int v = cnf.newVar();
			cnf.name(v, "enlace(" + ownerClass + "#" + ownerSlot + " --Ref" + refIndex + "--> " + targetClass + "#" + targetSlot + ")");
			return v;
		});
	}
}
