package org.satgen.server;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.eclipse.emf.ecore.EClass;
import org.eclipse.emf.ecore.EReference;
import org.eclipse.emf.ecore.resource.Resource;

/**
 * What the SAT encoder and the OCL-to-SAT compiler need from a loaded Ecore metamodel: its concrete classes
 * (the ones that get a pool of candidate object slots) and its references, each reduced to one canonical,
 * direction-aware {@link Ref} even when Ecore declares it as an {@code eOpposite} pair (so there is exactly
 * one set of link variables per real relationship, not two inconsistent ones).
 */
final class MetaModel {

	/** A relationship between two classes, as seen from its "owner" (forward) side; {@code backward} is null
	 * for a one-directional Ecore reference (its target side is then unconstrained, as in real Ecore/EMF). */
	static final class Ref {
		final int index;
		final EReference forward; // owner.<role> -> target*; also the actual feature used to build EMF instances
		final EReference backward; // target.<role> -> owner*, or null
		final EClass owner;
		final EClass target;
		final String roleFromOwner;
		final String roleFromTarget;
		final int ownerLower, ownerUpper; // bounds on how many `target`s a `owner` instance may link to (-1 = unbounded)
		final int targetLower, targetUpper; // bounds on the back direction, meaningless if roleFromTarget == null
		final boolean containment; // owner "contains" target (single-parent constraint applies to `target`)

		Ref(int index, EReference forward, EReference backward) {
			this.index = index;
			this.forward = forward;
			this.backward = backward;
			this.owner = forward.getEContainingClass();
			this.target = (EClass) forward.getEType();
			this.roleFromOwner = forward.getName();
			this.roleFromTarget = backward == null ? null : backward.getName();
			this.ownerLower = forward.getLowerBound();
			this.ownerUpper = forward.getUpperBound();
			this.targetLower = backward == null ? 0 : backward.getLowerBound();
			this.targetUpper = backward == null ? -1 : backward.getUpperBound();
			this.containment = forward.isContainment() || (backward != null && backward.isContainment());
		}
	}

	final List<EClass> concreteClasses = new ArrayList<>();
	final Map<String, EClass> byName = new LinkedHashMap<>();
	final List<Ref> refs = new ArrayList<>();

	static MetaModel from(Resource resource) {
		MetaModel mm = new MetaModel();
		for (var it = resource.getAllContents(); it.hasNext();) {
			Object o = it.next();
			if (o instanceof EClass c) {
				mm.byName.put(c.getName(), c);
				if (!c.isAbstract() && !c.isInterface()) mm.concreteClasses.add(c);
			}
		}
		java.util.Set<EReference> handled = new java.util.HashSet<>();
		int index = 0;
		for (var it = resource.getAllContents(); it.hasNext();) {
			Object o = it.next();
			if (!(o instanceof EReference ref) || handled.contains(ref) || ref.isDerived() || ref.isTransient()) continue;
			handled.add(ref);
			EReference opposite = ref.getEOpposite();
			if (opposite != null) handled.add(opposite);
			// "forward" = owner -> target: if exactly one side is a containment reference it MUST be forward
			// (so `target` below really is the contained type); otherwise, pick a deterministic order.
			EReference forward;
			if (ref.isContainment() && (opposite == null || !opposite.isContainment())) forward = ref;
			else if (opposite != null && opposite.isContainment() && !ref.isContainment()) forward = opposite;
			else forward = opposite == null || key(ref).compareTo(key(opposite)) <= 0 ? ref : opposite;
			EReference backward = forward == ref ? opposite : ref;
			mm.refs.add(new Ref(index++, forward, backward));
		}
		return mm;
	}

	private static String key(EReference r) {
		return r.getEContainingClass().getName() + "." + r.getName();
	}

	/** {@code type} itself (if concrete) plus every concrete class that specializes it, directly or not. */
	List<EClass> concreteSubtypes(EClass type) {
		List<EClass> result = new ArrayList<>();
		for (EClass c : concreteClasses) if (type.isSuperTypeOf(c)) result.add(c);
		return result;
	}

	/** The references whose target side (containment) can hold an instance of {@code type}. */
	List<Ref> containmentRefsInto(EClass type) {
		List<Ref> result = new ArrayList<>();
		for (Ref r : refs) if (r.containment && r.target.isSuperTypeOf(type)) result.add(r);
		return result;
	}
}
