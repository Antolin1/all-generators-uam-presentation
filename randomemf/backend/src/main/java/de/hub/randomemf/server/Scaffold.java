package de.hub.randomemf.server;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.eclipse.emf.codegen.ecore.genmodel.GenEnum;
import org.eclipse.emf.codegen.ecore.genmodel.GenPackage;
import org.eclipse.emf.ecore.EAttribute;
import org.eclipse.emf.ecore.EClass;
import org.eclipse.emf.ecore.EClassifier;
import org.eclipse.emf.ecore.EEnum;
import org.eclipse.emf.ecore.EPackage;
import org.eclipse.emf.ecore.EReference;
import org.eclipse.emf.ecore.EStructuralFeature;

/**
 * Writes a first rcore generator for a metamodel: one rule per class reachable through containment (an
 * <code>alter</code> rule wherever a reference can hold several classes), attributes with a random value by type,
 * and containment references guarded by <code>depth</code> so that the recursion ends. Non-containment references
 * cannot be guessed (which object should a transition point to?), so they are left as comments.
 */
final class Scaffold {

	private static final int MAX_DEPTH = 8;

	private final Metamodels.Entry entry;
	private final EPackage root;
	private final List<EClass> classes = new ArrayList<EClass>();

	Scaffold(Metamodels.Entry entry) {
		this.entry = entry;
		this.root = entry.packages.get(0);
		for (EPackage p : entry.packages) collect(p);
	}

	private void collect(EPackage ePackage) {
		for (EClassifier classifier : ePackage.getEClassifiers()) {
			if (classifier instanceof EClass) classes.add((EClass) classifier);
		}
		for (EPackage sub : ePackage.getESubpackages()) collect(sub);
	}

	String build() {
		EClass start = pickRoot();
		if (start == null) {
			throw new IllegalStateException("El metamodelo no tiene ninguna clase concreta");
		}

		// classes to give rules to: everything reachable from the root through containment (and their subtypes)
		Set<EClass> reachable = new LinkedHashSet<EClass>();
		visit(start, reachable);

		StringBuilder out = new StringBuilder();
		String name = Metamodels.capitalize(Metamodels.identifier(Metamodels.stem(entry.file)));
		out.append("// Generador inicial para ").append(entry.file).append(". Es un punto de partida: edítalo.\n");
		out.append("//\n");
		out.append("// - Cada regla crea un objeto de una clase; `feature := expr` asigna, `feature += expr # n` añade n valores.\n");
		out.append("// - Las referencias que no son de contención (p. ej. el destino de una transición) no se generan\n");
		out.append("//   solas: aparecen comentadas con un ejemplo @(...) que puedes descomentar y adaptar (una referencia\n");
		out.append("//   @(...) se resuelve al final, cuando ya existe todo el modelo; por eso se indica una clase concreta con `:`).\n");
		out.append("// - `depth` cuenta las reglas anidadas: se usa para que la recursión termine.\n");
		out.append("// - Ojo: las alternativas de `alter` no se reparten exactamente según su prioridad (ver README de este proyecto).\n\n");
		out.append("import static de.hub.randomemf.runtime.Random.*\n\n");
		out.append("generator ").append(name).append("Generator for ").append(Metamodels.identifier(root.getName())).append("\n");
		out.append("    in \"").append(entry.uri()).append("\" {\n");

		List<EClass> ordered = new ArrayList<EClass>();
		ordered.add(start);
		for (EClass c : reachable) if (c != start) ordered.add(c);

		Set<String> emittedAlt = new LinkedHashSet<String>();
		for (EClass c : ordered) {
			if (!isAbstract(c)) {
				out.append("\n");
				classRule(out, c);
			}
		}
		for (EClass c : ordered) {
			if (needsAlternative(c) && emittedAlt.add(c.getName())) {
				out.append("\n");
				alternativeRule(out, c);
			}
		}
		out.append("}\n");

		List<String> unreachable = new ArrayList<String>();
		for (EClass c : classes) {
			if (!isAbstract(c) && !reachable.contains(c)) unreachable.add(c.getName());
		}
		if (!unreachable.isEmpty()) {
			out.append("\n// Clases concretas sin regla (no se alcanzan por contención desde ").append(start.getName()).append("): ")
					.append(String.join(", ", unreachable)).append("\n");
		}
		return out.toString();
	}

	// --- rules ---

	private void classRule(StringBuilder out, EClass c) {
		out.append("  ").append(c.getName()).append(": ").append(c.getName()).append(" ->\n");
		boolean any = false;
		for (EStructuralFeature feature : c.getEAllStructuralFeatures()) {
			if (feature.isDerived() || !feature.isChangeable() || feature.isVolatile() || feature.isTransient()) continue;
			if (feature instanceof EAttribute) {
				String value = value((EAttribute) feature);
				if (value == null) {
					out.append("    // ").append(feature.getName()).append(": tipo ").append(feature.getEType().getName()).append(" sin valor por defecto\n");
				} else if (feature.isMany()) {
					out.append("    ").append(feature.getName()).append(" += ").append(value).append("#Poisson(2)\n");
				} else {
					out.append("    ").append(feature.getName()).append(" := ").append(value).append("\n");
				}
				any = true;
			} else {
				EReference reference = (EReference) feature;
				if (reference.isContainer()) continue;
				EClass target = reference.getEReferenceType();
				if (reference.isContainment()) {
					String rule = ruleFor(target);
					if (rule == null) continue;
					if (reference.isMany()) {
						out.append("    ").append(feature.getName()).append(" += ").append(rule)
								.append("#(if (depth < ").append(MAX_DEPTH).append(") Poisson(1) else 0)\n");
					} else {
						out.append("    ").append(feature.getName()).append(" := if (depth < ").append(MAX_DEPTH).append(") ").append(rule).append(" else null\n");
					}
				} else {
					out.append("    // ").append(feature.getName()).append(" -> ").append(target.getName())
							.append(reference.isMany() ? " (varios)" : "").append(reference.getEOpposite() != null ? ", opuesta de " + reference.getEOpposite().getName() : "")
							.append(" (no contenida). Ejemplo:\n");
					String example = referenceExample(reference, target);
					if (example != null) out.append("    //   ").append(example).append("\n");
				}
				any = true;
			}
		}
		if (!any) out.append("    // (sin características que asignar)\n");
		out.append("  ;\n");
	}

	private void alternativeRule(StringBuilder out, EClass c) {
		List<EClass> options = new ArrayList<EClass>();
		if (!isAbstract(c)) options.add(c);
		for (EClass sub : classes) {
			if (sub != c && !isAbstract(sub) && c.isSuperTypeOf(sub)) options.add(sub);
		}
		out.append("  alter ").append(altName(c)).append(": ").append(c.getName()).append(" ->\n    ");
		for (int i = 0; i < options.size(); i++) {
			if (i > 0) out.append(" | ");
			out.append(options.get(i).getName()).append("#2");
		}
		out.append("\n  ;\n");
	}

	// --- helpers ---

	/** A deferred reference <code>@(...)</code> that picks a random existing object of the target type. */
	private String referenceExample(EReference reference, EClass target) {
		EClass concrete = isAbstract(target) ? null : target;
		for (EClass sub : classes) {
			if (concrete == null && !isAbstract(sub) && target.isSuperTypeOf(sub)) concrete = sub;
		}
		org.eclipse.emf.codegen.ecore.genmodel.GenClass genClass = null;
		for (GenPackage genPackage : entry.genModel.getAllGenPackagesWithClassifiers()) {
			for (org.eclipse.emf.codegen.ecore.genmodel.GenClass candidate : genPackage.getGenClasses()) {
				if (candidate.getEcoreClass() == target) genClass = candidate;
			}
		}
		if (concrete == null || genClass == null) return null;
		String pick = "Uniform(model.eAllContents.filter(typeof(" + genClass.getQualifiedInterfaceName() + ")).toList)";
		// @() creates a proxy of the given concrete class first, hence the ':Concrete'
		return reference.getName() + ":" + concrete.getName() + (reference.isMany() ? " += @(" + pick + " # 1)" : " := @(" + pick + ")");
	}

	/** Concrete class no other class contains: the natural root of a model. */
	private EClass pickRoot() {
		Set<EClass> contained = new LinkedHashSet<EClass>();
		for (EClass c : classes) {
			for (EReference r : c.getEAllContainments()) {
				for (EClass k : classes) {
					if (r.getEReferenceType().isSuperTypeOf(k)) contained.add(k);
				}
			}
		}
		for (EClass c : classes) if (!isAbstract(c) && !contained.contains(c)) return c;
		for (EClass c : classes) if (!isAbstract(c)) return c;
		return null;
	}

	private void visit(EClass c, Set<EClass> reachable) {
		if (!reachable.add(c)) return;
		for (EReference r : c.getEAllContainments()) {
			EClass target = r.getEReferenceType();
			visit(target, reachable);
			for (EClass sub : classes) {
				if (sub != target && target.isSuperTypeOf(sub)) visit(sub, reachable);
			}
		}
	}

	private boolean isAbstract(EClass c) {
		return c.isAbstract() || c.isInterface();
	}

	private boolean hasConcreteSubtypes(EClass c) {
		for (EClass sub : classes) {
			if (sub != c && !isAbstract(sub) && c.isSuperTypeOf(sub)) return true;
		}
		return false;
	}

	/** An alternative rule is needed wherever a reference to <code>c</code> may hold more than one concrete class. */
	private boolean needsAlternative(EClass c) {
		return hasConcreteSubtypes(c) && isContainmentTarget(c);
	}

	private boolean isContainmentTarget(EClass c) {
		for (EClass k : classes) {
			for (EReference r : k.getEAllContainments()) if (r.getEReferenceType() == c) return true;
		}
		return false;
	}

	private String altName(EClass c) {
		return isAbstract(c) ? c.getName() : "Any" + c.getName();
	}

	private String ruleFor(EClass target) {
		if (needsAlternative(target)) return altName(target);
		return isAbstract(target) ? null : target.getName();
	}

	/** An rcore expression that produces a value for the attribute, or null if the type is unknown. */
	private String value(EAttribute attribute) {
		EClassifier type = attribute.getEType();
		if (type instanceof EEnum) {
			for (GenPackage genPackage : entry.genModel.getAllGenPackagesWithClassifiers()) {
				for (GenEnum genEnum : genPackage.getGenEnums()) {
					if (genEnum.getEcoreEnum() == type) return "Uniform(" + genEnum.getQualifiedInstanceClassName() + ".VALUES)";
				}
			}
			return null;
		}
		Class<?> java = type.getInstanceClass();
		if (java == null) return null;
		Map<Class<?>, String> byType = new LinkedHashMap<Class<?>, String>();
		byType.put(String.class, "RandomID(6)");
		byType.put(boolean.class, "UniformBool(0.5)");
		byType.put(Boolean.class, "UniformBool(0.5)");
		byType.put(int.class, "Uniform(0, 100)");
		byType.put(Integer.class, "Uniform(0, 100)");
		byType.put(long.class, "Uniform(0, 100)");
		byType.put(Long.class, "Uniform(0, 100)");
		byType.put(short.class, "Uniform(0, 100) as short");
		byType.put(Short.class, "Uniform(0, 100) as short");
		byType.put(byte.class, "Uniform(0, 100) as byte");
		byType.put(Byte.class, "Uniform(0, 100) as byte");
		byType.put(double.class, "Rand().nextDouble()");
		byType.put(Double.class, "Rand().nextDouble()");
		byType.put(float.class, "Rand().nextFloat()");
		byType.put(Float.class, "Rand().nextFloat()");
		byType.put(java.util.Date.class, "new java.util.Date()");
		return byType.get(java);
	}
}
