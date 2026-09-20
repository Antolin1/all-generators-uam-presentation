package de.hub.randomemf.runtime;

import org.eclipse.emf.ecore.EObject;

/**
 * Optional observer of a generation run. The Java code generated for a generator calls these
 * hooks while it executes its rules; unless a {@link Listener} is installed they do nothing.
 * <p>
 * Like {@link Random}, this is static state, so only one generation may run at a time.
 */
public class Trace {

	public interface Listener {
		/** A class rule created <code>self</code>; <code>params</code> are the rule's parameter values. */
		void ruleStart(String rule, EObject self, Object[] params);
		void ruleEnd(String rule, EObject self);
		/** The feature assignment number <code>index</code> of the rule is about to produce <code>count</code> values. */
		void featureStart(String rule, int index, int count);
		void featureEnd(String rule, int index);
		/** An alternative rule chose its alternative number <code>chosen</code> (0-based). */
		void alternativeStart(String rule, int chosen);
		void alternativeEnd(String rule);
		/** A deferred reference <code>@(...)</code> of the given feature assignment was resolved. */
		void referenceResolved(String rule, int index, EObject source, EObject target);
	}

	private static Listener listener;

	public static void setListener(Listener listener) {
		Trace.listener = listener;
	}

	public static void ruleStart(String rule, EObject self, Object[] params) {
		if (listener != null) listener.ruleStart(rule, self, params);
	}

	public static void ruleEnd(String rule, EObject self) {
		if (listener != null) listener.ruleEnd(rule, self);
	}

	public static void featureStart(String rule, int index, int count) {
		if (listener != null) listener.featureStart(rule, index, count);
	}

	public static void featureEnd(String rule, int index) {
		if (listener != null) listener.featureEnd(rule, index);
	}

	public static void alternativeStart(String rule, int chosen) {
		if (listener != null) listener.alternativeStart(rule, chosen);
	}

	public static void alternativeEnd(String rule) {
		if (listener != null) listener.alternativeEnd(rule);
	}

	public static void referenceResolved(String rule, int index, EObject source, EObject target) {
		if (listener != null) listener.referenceResolved(rule, index, source, target);
	}
}
