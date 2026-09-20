package de.hub.instantiator.server;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

import org.eclipse.emf.common.util.EList;
import org.eclipse.emf.ecore.EAttribute;
import org.eclipse.emf.ecore.EClass;
import org.eclipse.emf.ecore.EEnumLiteral;
import org.eclipse.emf.ecore.EObject;
import org.eclipse.emf.ecore.EReference;
import org.eclipse.emf.ecore.EStructuralFeature;
import org.eclipse.emf.ecore.resource.Resource;

/** A generated model as a graph: one node per object with its attribute values, one edge per reference. */
final class GraphExporter {

	private static final int MAX_VALUE_LENGTH = 60;
	private static final int MAX_ATTRIBUTES = 6;

	private final Map<EObject, String> ids = new IdentityHashMap<EObject, String>();

	private String id(EObject object) {
		String id = ids.get(object);
		if (id == null) {
			id = "n" + ids.size();
			ids.put(object, id);
		}
		return id;
	}

	Map<String, Object> export(Resource model) {
		List<EObject> objects = new ArrayList<EObject>();
		for (EObject root : model.getContents()) {
			objects.add(root);
			for (Iterator<EObject> it = root.eAllContents(); it.hasNext();) objects.add(it.next());
		}
		for (EObject object : objects) id(object);

		List<Object> nodes = new ArrayList<Object>();
		List<Object> edges = new ArrayList<Object>();
		Map<String, Integer> byType = new TreeMap<String, Integer>();
		Set<String> emitted = new HashSet<String>();
		int containments = 0;

		for (EObject object : objects) {
			nodes.add(node(object));
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
				if (reference.isContainer() || reference.isContainment() || reference.isDerived() || reference.isTransient() || reference.isVolatile()) continue;
				EReference other = reference.getEOpposite();
				// of two opposite references draw the single-valued one
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
				"stats", Json.obj("objects", objects.size(), "external", 0, "edges", edges.size(), "containments", containments, "byType", byType));
	}

	@SuppressWarnings("unchecked")
	private static List<EObject> targets(EObject object, EReference reference) {
		if (!object.eIsSet(reference)) return new ArrayList<EObject>();
		Object value = object.eGet(reference, false);
		if (reference.isMany()) return new ArrayList<EObject>((EList<EObject>) value);
		List<EObject> single = new ArrayList<EObject>(1);
		single.add((EObject) value);
		return single;
	}

	private Map<String, Object> node(EObject object) {
		EClass type = object.eClass();
		List<Object> attributes = new ArrayList<Object>();
		int hidden = 0;
		for (EAttribute attribute : type.getEAllAttributes()) {
			if (attribute.isDerived() || attribute.isTransient() || attribute.isVolatile() || !object.eIsSet(attribute)) continue;
			if (attributes.size() >= MAX_ATTRIBUTES) {
				hidden++;
				continue;
			}
			attributes.add(Json.obj("name", attribute.getName(), "value", format(object.eGet(attribute))));
		}
		if (hidden > 0) attributes.add(Json.obj("name", "…", "value", "+" + hidden + " más"));

		Map<String, Object> json = new LinkedHashMap<String, Object>();
		json.put("id", id(object));
		json.put("type", type.getName());
		json.put("abstract", type.isAbstract());
		json.put("name", nameOf(object));
		json.put("external", false);
		json.put("implicit", false);
		json.put("attributes", attributes);
		// the "rule" that made the object is, for this generator, simply its metaclass
		json.put("rule", type.getName());
		json.put("app", null);
		return json;
	}

	private static String nameOf(EObject object) {
		EStructuralFeature name = object.eClass().getEStructuralFeature("name");
		if (name instanceof EAttribute && name.getEType().getInstanceClass() == String.class && !name.isMany() && object.eIsSet(name)) {
			String value = String.valueOf(object.eGet(name));
			return value.length() > MAX_VALUE_LENGTH ? value.substring(0, MAX_VALUE_LENGTH - 1) + "…" : value;
		}
		return null;
	}

	private static String format(Object value) {
		String text;
		if (value == null) text = "null";
		else if (value instanceof EEnumLiteral) text = ((EEnumLiteral) value).getLiteral();
		else if (value instanceof java.util.Collection) {
			StringBuilder builder = new StringBuilder("[");
			for (Object element : (java.util.Collection<?>) value) {
				if (builder.length() > 1) builder.append(", ");
				builder.append(format(element));
			}
			text = builder.append("]").toString();
		} else text = String.valueOf(value);
		text = text.replace('\n', ' ');
		return text.length() > MAX_VALUE_LENGTH ? text.substring(0, MAX_VALUE_LENGTH - 1) + "…" : text;
	}
}
