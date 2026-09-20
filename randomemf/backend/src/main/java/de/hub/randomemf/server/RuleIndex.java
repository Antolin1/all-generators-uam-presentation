package de.hub.randomemf.server;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.eclipse.emf.ecore.EObject;
import org.eclipse.xtext.nodemodel.INode;
import org.eclipse.xtext.nodemodel.util.NodeModelUtils;

import de.hub.randomemf.randomEMF.AbstractRule;
import de.hub.randomemf.randomEMF.AlternativeRule;
import de.hub.randomemf.randomEMF.Generator;
import de.hub.randomemf.randomEMF.InnerRule;

/**
 * Describes the rules of a parsed generator (with their position in the source text) so the UI can
 * relate the applied rules of a run back to the editor.
 */
final class RuleIndex {

	private final Map<String, List<String>> featureNames = new LinkedHashMap<String, List<String>>();
	private final List<Object> rules = new ArrayList<Object>();

	RuleIndex(Generator generator) {
		for (AbstractRule rule : generator.getRules()) {
			boolean alter = rule instanceof AlternativeRule;
			List<String> names = new ArrayList<String>();
			List<Object> items = new ArrayList<Object>();
			int index = 0;
			for (InnerRule inner : rule.getInners()) {
				String feature = inner.getEFeature() == null || inner.getEFeature().eIsProxy() ? null : inner.getEFeature().getName();
				names.add(feature);
				items.add(alter ? alternative(index, inner) : feature(index, feature, inner));
				index++;
			}
			featureNames.put(rule.getName(), names);
			List<String> params = new ArrayList<String>();
			for (org.eclipse.xtext.common.types.JvmFormalParameter p : rule.getParams()) {
				params.add(text(p));
			}
			rules.add(Json.obj(
					"name", rule.getName(),
					"kind", alter ? "alter" : "class",
					"eClass", rule.getEClass() == null || rule.getEClass().eIsProxy() ? null : rule.getEClass().getName(),
					"params", params,
					"entry", generator.getRules().get(0) == rule,
					"range", range(rule),
					"items", items));
		}
	}

	List<Object> rules() {
		return rules;
	}

	/** Name of the feature assigned by the assignment number <code>index</code> of the rule (null for alternatives). */
	String featureName(String rule, int index) {
		List<String> names = featureNames.get(rule);
		return names == null || index < 0 || index >= names.size() ? null : names.get(index);
	}

	private static Map<String, Object> feature(int index, String feature, InnerRule inner) {
		return Json.obj(
				"index", index,
				"feature", feature,
				"op", inner.isIsAddRule() ? "+=" : ":=",
				"ref", inner.isIsRef(),
				"value", text(inner.getExpr()),
				"times", inner.getNumber() == null ? null : text(inner.getNumber()),
				"range", range(inner));
	}

	private static Map<String, Object> alternative(int index, InnerRule inner) {
		return Json.obj(
				"index", index,
				"value", text(inner.getExpr()),
				"priority", inner.getNumber() == null ? null : text(inner.getNumber()),
				"range", range(inner));
	}

	private static String text(EObject object) {
		INode node = object == null ? null : NodeModelUtils.findActualNodeFor(object);
		return node == null ? null : NodeModelUtils.getTokenText(node).replaceAll("\\s+", " ").trim();
	}

	static Map<String, Object> range(EObject object) {
		INode node = NodeModelUtils.findActualNodeFor(object);
		if (node == null) {
			return null;
		}
		return Json.obj(
				"offset", node.getOffset(),
				"length", node.getLength(),
				"startLine", node.getStartLine(),
				"endLine", node.getEndLine());
	}

}
