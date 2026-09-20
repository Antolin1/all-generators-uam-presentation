package de.hub.randomemf.server;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.eclipse.emf.ecore.EObject;

import de.hub.randomemf.runtime.Trace;

/**
 * Records which rules were applied during one generation run, as a tree that mirrors the call structure:
 * <pre>
 * rule Package (created an EPackage)
 *   feature eClassifiers += Class # 3          (assignment number 3 of the rule, evaluated 3 times)
 *     rule Class (created an EClass)
 *       feature ...
 *         alt Feature -> alternative 2         (an alternative rule picked its 3rd alternative)
 *           rule Attribute ...
 * </pre>
 */
final class TraceRecorder implements Trace.Listener {

	static final class Node {
		final int id;
		final String kind; // rule | feature | alt
		final String rule;
		int index = -1;
		int count = -1;
		String[] params;
		EObject object;
		final List<Node> children = new ArrayList<Node>();

		Node(int id, String kind, String rule) {
			this.id = id;
			this.kind = kind;
			this.rule = rule;
		}
	}

	static final class Resolution {
		final String rule;
		final int index;
		final EObject source;
		final EObject target;

		Resolution(String rule, int index, EObject source, EObject target) {
			this.rule = rule;
			this.index = index;
			this.source = source;
			this.target = target;
		}
	}

	final List<Node> roots = new ArrayList<Node>();
	final List<Resolution> resolutions = new ArrayList<Resolution>();
	final Map<EObject, Node> creators = new IdentityHashMap<EObject, Node>();
	private final Deque<Node> stack = new ArrayDeque<Node>();
	private int nextId = 0;

	private Node open(String kind, String rule) {
		Node node = new Node(nextId++, kind, rule);
		if (stack.isEmpty()) {
			roots.add(node);
		} else {
			stack.peek().children.add(node);
		}
		stack.push(node);
		return node;
	}

	private void close(String kind, String rule) {
		// tolerate an unbalanced stack (a rule may have thrown): unwind to the matching node
		while (!stack.isEmpty()) {
			Node top = stack.pop();
			if (top.kind.equals(kind) && top.rule.equals(rule)) {
				return;
			}
		}
	}

	@Override
	public void ruleStart(String rule, EObject self, Object[] params) {
		Node node = open("rule", rule);
		node.object = self;
		node.params = new String[params.length];
		for (int i = 0; i < params.length; i++) {
			node.params[i] = describe(params[i]);
		}
		creators.put(self, node);
	}

	@Override
	public void ruleEnd(String rule, EObject self) {
		close("rule", rule);
	}

	@Override
	public void featureStart(String rule, int index, int count) {
		Node node = open("feature", rule);
		node.index = index;
		node.count = count;
	}

	@Override
	public void featureEnd(String rule, int index) {
		close("feature", rule);
	}

	@Override
	public void alternativeStart(String rule, int chosen) {
		open("alt", rule).index = chosen;
	}

	@Override
	public void alternativeEnd(String rule) {
		close("alt", rule);
	}

	@Override
	public void referenceResolved(String rule, int index, EObject source, EObject target) {
		resolutions.add(new Resolution(rule, index, source, target));
	}

	/** Indices of the assignments of the object's rule, i.e. the features the rule set. */
	List<Integer> assignedFeatures(EObject object) {
		Node rule = creators.get(object);
		List<Integer> indices = new ArrayList<Integer>();
		if (rule != null) {
			for (Node child : rule.children) {
				if (child.kind.equals("feature")) {
					indices.add(child.index);
				}
			}
		}
		return indices;
	}

	Map<String, Object> toJson(GraphExporter.Ids ids) {
		List<Object> rootsJson = new ArrayList<Object>();
		for (Node root : roots) {
			rootsJson.add(toJson(root, ids));
		}
		List<Object> resolved = new ArrayList<Object>();
		for (Resolution r : resolutions) {
			resolved.add(Json.obj("rule", r.rule, "index", r.index, "source", ids.peek(r.source), "target", ids.peek(r.target)));
		}
		return Json.obj("roots", rootsJson, "resolutions", resolved);
	}

	private Map<String, Object> toJson(Node node, GraphExporter.Ids ids) {
		Map<String, Object> json = new LinkedHashMap<String, Object>();
		json.put("id", "a" + node.id);
		json.put("kind", node.kind);
		json.put("rule", node.rule);
		if (!node.kind.equals("rule")) {
			json.put("index", node.index);
		}
		if (node.kind.equals("feature")) {
			json.put("count", node.count);
		}
		if (node.kind.equals("rule")) {
			json.put("params", node.params);
			json.put("object", ids.peek(node.object));
		}
		List<Object> children = new ArrayList<Object>();
		for (Node child : node.children) {
			children.add(toJson(child, ids));
		}
		json.put("children", children);
		return json;
	}

	private static String describe(Object value) {
		if (value instanceof EObject) {
			return "<" + ((EObject) value).eClass().getName() + ">";
		}
		return String.valueOf(value);
	}
}
