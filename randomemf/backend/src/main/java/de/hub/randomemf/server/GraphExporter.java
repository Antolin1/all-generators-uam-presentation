package de.hub.randomemf.server;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

import org.eclipse.emf.common.util.EList;
import org.eclipse.emf.common.util.TreeIterator;
import org.eclipse.emf.ecore.EAttribute;
import org.eclipse.emf.ecore.EClass;
import org.eclipse.emf.ecore.EEnumLiteral;
import org.eclipse.emf.ecore.EObject;
import org.eclipse.emf.ecore.EReference;
import org.eclipse.emf.ecore.EStructuralFeature;

/**
 * Turns a generated model into a graph of its abstract syntax: one node per object with its attributes,
 * one edge per reference (containment edges are marked, they form the syntax tree).
 */
final class GraphExporter {

	/** Stable node ids for the objects of one export. */
	static final class Ids {
		private final Map<EObject, String> ids = new IdentityHashMap<EObject, String>();

		String of(EObject object) {
			String id = ids.get(object);
			if (id == null) {
				id = "n" + ids.size();
				ids.put(object, id);
			}
			return id;
		}

		/** Id of an object if it is part of the graph, null otherwise. */
		String peek(EObject object) {
			return object == null ? null : ids.get(object);
		}
	}

	private static final int MAX_VALUE_LENGTH = 80;

	private final RuleIndex rules;
	private final TraceRecorder trace;

	GraphExporter(RuleIndex rules, TraceRecorder trace) {
		this.rules = rules;
		this.trace = trace;
	}

	Map<String, Object> export(EObject root, Ids ids) {
		List<EObject> internal = new ArrayList<EObject>();
		internal.add(root);
		for (TreeIterator<EObject> it = root.eAllContents(); it.hasNext();) {
			internal.add(it.next());
		}
		for (EObject object : internal) {
			ids.of(object);
		}
		Set<EObject> internalSet = java.util.Collections.newSetFromMap(new IdentityHashMap<EObject, Boolean>());
		internalSet.addAll(internal);

		List<Object> nodes = new ArrayList<Object>();
		List<Object> edges = new ArrayList<Object>();
		List<EObject> external = new ArrayList<EObject>();
		Set<String> emitted = new HashSet<String>();
		Map<String, Integer> byType = new TreeMap<String, Integer>();
		int containments = 0;

		for (EObject object : internal) {
			nodes.add(node(object, ids, false));
			byType.merge(object.eClass().getName(), 1, Integer::sum);
			// the syntax tree, taken from the actual containment so that objects behind derived containments show up too
			if (object.eContainer() != null) {
				String source = ids.of(object.eContainer());
				String name = object.eContainmentFeature().getName();
				emitted.add(source + ">" + name + ">" + ids.of(object));
				edges.add(Json.obj("id", "e" + edges.size(), "source", source, "target", ids.of(object), "name", name, "kind", "containment"));
				containments++;
			}
			Set<String> assigned = assignedFeatures(object);
			for (EReference reference : object.eClass().getEAllReferences()) {
				// derived references (e.g. ETypedElement.eType) are shown when a rule assigned them
				if (reference.isContainer() || reference.isContainment() || (isDerived(reference) && !assigned.contains(reference.getName()))) {
					continue;
				}
				// of a pair of opposite references draw the single-valued one (Transition.target, not Vertex.incomingTransitions)
				EReference other = reference.getEOpposite();
				if (other != null && reference.isMany() && !other.isMany() && !other.isContainer() && !other.isContainment()) {
					continue;
				}
				for (EObject target : targets(object, reference)) {
					if (target == null || target.eIsProxy()) {
						continue;
					}
					if (!internalSet.contains(target) && !external.contains(target)) {
						external.add(target);
						ids.of(target);
					}
					String source = ids.of(object);
					String tgt = ids.of(target);
					EReference opposite = reference.getEOpposite();
					if (opposite != null && emitted.contains(tgt + ">" + opposite.getName() + ">" + source)) {
						continue;
					}
					emitted.add(source + ">" + reference.getName() + ">" + tgt);
					edges.add(Json.obj(
							"id", "e" + edges.size(),
							"source", source,
							"target", tgt,
							"name", reference.getName(),
							"kind", "reference"));
				}
			}
		}
		for (EObject object : external) {
			nodes.add(node(object, ids, true));
		}
		return Json.obj(
				"root", ids.of(root),
				"nodes", nodes,
				"edges", edges,
				"stats", Json.obj(
						"objects", internal.size(),
						"external", external.size(),
						"edges", edges.size(),
						"containments", containments,
						"byType", byType));
	}

	@SuppressWarnings("unchecked")
	private static List<EObject> targets(EObject object, EReference reference) {
		if (!object.eIsSet(reference)) {
			return java.util.Collections.emptyList();
		}
		Object value = object.eGet(reference, false);
		if (reference.isMany()) {
			return new ArrayList<EObject>((EList<EObject>) value);
		}
		List<EObject> single = new ArrayList<EObject>(1);
		single.add((EObject) value);
		return single;
	}

	/** Names of the features the rule that created the object assigned. */
	private Set<String> assignedFeatures(EObject object) {
		Set<String> assigned = new HashSet<String>();
		TraceRecorder.Node creator = trace.creators.get(object);
		if (creator != null) {
			for (int index : trace.assignedFeatures(object)) {
				String name = rules.featureName(creator.rule, index);
				if (name != null) {
					assigned.add(name);
				}
			}
		}
		return assigned;
	}

	private static boolean isDerived(EStructuralFeature feature) {
		return feature.isDerived() || feature.isTransient() || feature.isVolatile();
	}

	private Map<String, Object> node(EObject object, Ids ids, boolean external) {
		EClass type = object.eClass();
		TraceRecorder.Node creator = trace.creators.get(object);
		Set<String> assigned = assignedFeatures(object);

		List<Object> attributes = new ArrayList<Object>();
		if (!external) {
			for (EAttribute attribute : type.getEAllAttributes()) {
				// show what a rule assigned (even if it equals the default) and whatever else is set
				boolean wasAssigned = assigned.contains(attribute.getName());
				if (isDerived(attribute) ? !wasAssigned : (!object.eIsSet(attribute) && !wasAssigned)) {
					continue;
				}
				String value = format(object.eGet(attribute));
				attributes.add(Json.obj("name", attribute.getName(), "value", value));
			}
		}

		Map<String, Object> json = new LinkedHashMap<String, Object>();
		json.put("id", ids.of(object));
		json.put("type", type.getName());
		json.put("abstract", type.isAbstract());
		json.put("name", nameOf(object));
		json.put("external", external);
		json.put("attributes", attributes);
		json.put("rule", creator == null ? null : creator.rule);
		json.put("app", creator == null ? null : "a" + creator.id);
		// objects EMF created on its own (e.g. EGenericType behind an eType): part of the model, but no rule made them
		json.put("implicit", !external && creator == null);
		return json;
	}

	private static String nameOf(EObject object) {
		EStructuralFeature name = object.eClass().getEStructuralFeature("name");
		if (name instanceof EAttribute && name.getEType().getInstanceClass() == String.class && !name.isMany()) {
			Object value = object.eGet(name);
			return value == null ? null : String.valueOf(value);
		}
		return null;
	}

	private static String format(Object value) {
		String text;
		if (value == null) {
			text = "null";
		} else if (value instanceof EEnumLiteral) {
			text = ((EEnumLiteral) value).getLiteral();
		} else if (value instanceof java.util.Collection) {
			StringBuilder builder = new StringBuilder("[");
			for (Object element : (java.util.Collection<?>) value) {
				if (builder.length() > 1) {
					builder.append(", ");
				}
				builder.append(format(element));
			}
			text = builder.append("]").toString();
		} else if (value instanceof org.eclipse.emf.common.util.Enumerator) {
			text = value.toString();
		} else {
			text = String.valueOf(value);
		}
		return text.length() > MAX_VALUE_LENGTH ? text.substring(0, MAX_VALUE_LENGTH - 1) + "…" : text;
	}

}
