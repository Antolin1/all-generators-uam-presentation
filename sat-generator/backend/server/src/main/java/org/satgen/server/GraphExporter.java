package org.satgen.server;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

import org.eclipse.emf.common.util.EList;
import org.eclipse.emf.ecore.EClass;
import org.eclipse.emf.ecore.EObject;
import org.eclipse.emf.ecore.EReference;
import org.eclipse.emf.ecore.resource.Resource;

/** The model SAT found, as a graph: one node per object (no attributes — those aren't part of the SAT encoding), one edge per link. */
final class GraphExporter {

	private final Map<EObject, String> ids = new IdentityHashMap<>();

	private String id(EObject object) {
		return ids.computeIfAbsent(object, o -> "n" + ids.size());
	}

	Map<String, Object> export(Resource model, Map<EObject, List<String>> violatedBy) {
		List<EObject> objects = new ArrayList<>();
		for (EObject root : model.getContents()) {
			objects.add(root);
			for (Iterator<EObject> it = root.eAllContents(); it.hasNext();) objects.add(it.next());
		}
		for (EObject object : objects) id(object);

		List<Object> nodes = new ArrayList<>();
		List<Object> edges = new ArrayList<>();
		Map<String, Integer> byType = new TreeMap<>();
		Set<String> emitted = new HashSet<>();
		int containments = 0;

		for (EObject object : objects) {
			nodes.add(node(object, violatedBy.get(object)));
			byType.merge(object.eClass().getName(), 1, Integer::sum);

			EObject container = object.eContainer();
			if (container != null) {
				String source = id(container);
				String name = object.eContainmentFeature().getName();
				emitted.add(source + ">" + name + ">" + id(object));
				edges.add(Json.obj("id", "e" + edges.size(), "source", source, "target", id(object), "name", name, "kind", "containment"));
				containments++;
			}

			for (EReference reference : object.eClass().getEAllReferences()) {
				if (reference.isContainer() || reference.isContainment() || reference.isDerived() || reference.isTransient()) continue;
				EReference other = reference.getEOpposite();
				if (other != null && reference.isMany() && !other.isMany() && !other.isContainer() && !other.isContainment()) continue;
				for (EObject target : targets(object, reference)) {
					if (target == null || target.eIsProxy() || !ids.containsKey(target)) continue;
					String source = id(object);
					String tgt = id(target);
					if (other != null && emitted.contains(tgt + ">" + other.getName() + ">" + source)) continue;
					if (!emitted.add(source + ">" + reference.getName() + ">" + tgt)) continue;
					edges.add(Json.obj("id", "e" + edges.size(), "source", source, "target", tgt, "name", reference.getName(), "kind", "reference"));
				}
			}
		}
		return Json.obj(
				"root", objects.isEmpty() ? null : id(objects.get(0)),
				"nodes", nodes,
				"edges", edges,
				"stats", Json.obj("objects", objects.size(), "edges", edges.size(), "containments", containments, "byType", byType));
	}

	@SuppressWarnings("unchecked")
	private static List<EObject> targets(EObject object, EReference reference) {
		if (!object.eIsSet(reference)) return new ArrayList<>();
		Object value = object.eGet(reference, false);
		if (reference.isMany()) return new ArrayList<>((EList<EObject>) value);
		List<EObject> single = new ArrayList<>(1);
		single.add((EObject) value);
		return single;
	}

	private Map<String, Object> node(EObject object, List<String> problems) {
		EClass type = object.eClass();
		Map<String, Object> json = new java.util.LinkedHashMap<>();
		json.put("id", id(object));
		json.put("type", type.getName());
		json.put("abstract", type.isAbstract());
		json.put("name", null);
		json.put("external", false);
		json.put("implicit", false);
		json.put("attributes", List.of());
		json.put("rule", type.getName());
		json.put("app", null);
		json.put("problems", problems != null ? problems : List.of());
		return json;
	}
}
