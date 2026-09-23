package org.satgen.server;

import java.io.ByteArrayOutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

import org.eclipse.emf.common.util.EList;
import org.eclipse.emf.common.util.URI;
import org.eclipse.emf.ecore.EClass;
import org.eclipse.emf.ecore.EObject;
import org.eclipse.emf.ecore.EReference;
import org.eclipse.emf.ecore.resource.Resource;
import org.eclipse.emf.ecore.xmi.impl.XMIResourceImpl;
import org.tzi.use.api.UseApiException;
import org.tzi.use.api.UseSystemApi;
import org.tzi.use.uml.ocl.value.CollectionValue;
import org.tzi.use.uml.ocl.value.ObjectValue;
import org.tzi.use.uml.ocl.value.Value;

/**
 * Orchestrates one request end to end: load the metamodel and its OCL, encode "does a model within these
 * bounds exist" as SAT ({@link Encoder}), solve it ({@link Solver}) and, if satisfiable, decode the
 * satisfying assignment into real EMF objects and replay them into a real USE system ({@link UseModel},
 * {@code UseSystemApi}) — so the final "does it conform?" answer, and the per-object violation list, come
 * from USE's own OCL engine, not from trusting our own compiler.
 */
final class Runner {

	static final long TIMEOUT_SECONDS = 20;
	static final int MAX_OCL_EXAMPLES = 8;
	static final int MAX_DIMACS_CLAUSE_LINES = 50_000;

	static final class Failure extends Exception {
		final String phase;

		Failure(String phase, String message) {
			super(message);
			this.phase = phase;
		}
	}

	private final Metamodels metamodels;

	Runner(Metamodels metamodels) {
		this.metamodels = metamodels;
	}

	Map<String, Object> generate(String metamodelFile, Map<String, Object> payload) throws Failure {
		Metamodels.Loaded loaded;
		try {
			loaded = metamodels.load(metamodelFile);
		} catch (IllegalArgumentException e) {
			throw new Failure("params", e.getMessage());
		} catch (Exception e) {
			throw new Failure("metamodel", "No se pudo leer el metamodelo: " + rootMessage(e));
		}
		if (!loaded.errors.isEmpty()) {
			throw new Failure("metamodel", "El metamodelo tiene " + loaded.errors.size() + " error(es); corrígelos:\n  - "
					+ String.join("\n  - ", loaded.errors.subList(0, Math.min(5, loaded.errors.size()))));
		}

		Scope scope;
		Encoder.Result enc;
		try {
			scope = Scope.fromPayload(payload, loaded.metaModel);
			enc = Encoder.build(loaded.metaModel, scope, loaded.constraints);
		} catch (Scope.ScopeError e) {
			throw new Failure("params", e.getMessage());
		}

		Solver.Result sol;
		try {
			sol = Solver.solve(enc.cnf, TIMEOUT_SECONDS);
		} catch (RuntimeException e) {
			throw new Failure("run", e.getMessage());
		}
		Map<String, Object> satStats = Json.obj("variables", sol.variables, "clauses", sol.clauses, "millis", sol.millis);
		String cnfText = enc.cnf.toDimacs(MAX_DIMACS_CLAUSE_LINES);

		if (!sol.sat) {
			return Json.obj(
					"ok", true, "sat", false,
					"satStats", satStats,
					"cnf", cnfText,
					"translatedConstraints", enc.translatedConstraints,
					"untranslatedConstraints", enc.untranslatedConstraints,
					"oclFileErrors", loaded.oclErrors);
		}
		return decode(loaded, scope, enc, sol, satStats, cnfText);
	}

	private Map<String, Object> decode(Metamodels.Loaded loaded, Scope scope, Encoder.Result enc, Solver.Result sol, Map<String, Object> satStats, String cnfText)
			throws Failure {
		MetaModel mm = loaded.metaModel;

		// 1. the active objects, as dynamic EMF instances (no attributes: those are not part of the SAT encoding)
		Map<String, EObject> bySlot = new HashMap<>();
		Map<String, Integer> byClass = new TreeMap<>();
		int objectCount = 0;
		for (EClass c : mm.concreteClasses) {
			int n = enc.pool.get(c);
			for (int s = 0; s < n; s++) {
				if (sol.isTrue(enc.vars.active(c.getName(), s))) {
					EObject obj = c.getEPackage().getEFactoryInstance().create(c);
					bySlot.put(slotKey(c.getName(), s), obj);
					byClass.merge(c.getName(), 1, Integer::sum);
					objectCount++;
				}
			}
		}

		// 2. the active links, added as real EMF containment/references (EMF keeps eOpposite features in sync)
		for (MetaModel.Ref ref : mm.refs) {
			for (EClass oc : mm.concreteSubtypes(ref.owner)) {
				int on = enc.pool.get(oc);
				for (int os = 0; os < on; os++) {
					EObject ownerObj = bySlot.get(slotKey(oc.getName(), os));
					if (ownerObj == null) continue;
					for (EClass tc : mm.concreteSubtypes(ref.target)) {
						int tn = enc.pool.get(tc);
						for (int ts = 0; ts < tn; ts++) {
							if (!sol.isTrue(enc.vars.link(ref.index, oc.getName(), os, tc.getName(), ts))) continue;
							EObject targetObj = bySlot.get(slotKey(tc.getName(), ts));
							if (targetObj != null) addLink(ownerObj, ref.forward, targetObj);
						}
					}
				}
			}
		}

		// 3. the resource: the chosen root first (so it is `graph.root`), then any object SAT left unreachable (should not
		// happen given the containment rules, but classes with no containment reference into them are, by design, exempt)
		EClass rootClass = mm.byName.get(scope.rootClassName);
		EObject rootObj = null;
		for (EClass c : mm.concreteSubtypes(rootClass)) {
			int n = enc.pool.get(c);
			for (int s = 0; s < n && rootObj == null; s++) rootObj = bySlot.get(slotKey(c.getName(), s));
			if (rootObj != null) break;
		}
		if (rootObj == null) throw new Failure("run", "SAT no marcó ninguna instancia de la clase raíz como activa (esto no debería pasar).");
		Resource resource = new XMIResourceImpl(URI.createURI("model.xmi"));
		resource.getContents().add(rootObj);
		for (EObject o : bySlot.values()) if (o != rootObj && o.eContainer() == null) resource.getContents().add(o);

		// 4. replay the same objects and links into a real USE system, and let USE's own OCL engine be the judge
		UseModel useModel;
		try {
			useModel = UseModel.build(mm, loaded.constraints);
		} catch (UseApiException e) {
			throw new Failure("run", "No se pudo construir el modelo en USE: " + e.getMessage());
		}
		UseSystemApi sysApi = UseSystemApi.create(useModel.model, false);
		Map<String, EObject> byUseName = new HashMap<>();
		Map<EObject, String> useNameOf = new IdentityHashMap<>();
		try {
			for (Map.Entry<String, EObject> e : bySlot.entrySet()) {
				String className = e.getKey().substring(0, e.getKey().indexOf('#'));
				String useName = className.toLowerCase() + "_" + e.getKey().substring(e.getKey().indexOf('#') + 1);
				sysApi.createObject(className, useName);
				byUseName.put(useName, e.getValue());
				useNameOf.put(e.getValue(), useName);
			}
			for (MetaModel.Ref ref : mm.refs) {
				for (EClass oc : mm.concreteSubtypes(ref.owner)) {
					int on = enc.pool.get(oc);
					for (int os = 0; os < on; os++) {
						EObject ownerObj = bySlot.get(slotKey(oc.getName(), os));
						if (ownerObj == null) continue;
						for (EClass tc : mm.concreteSubtypes(ref.target)) {
							int tn = enc.pool.get(tc);
							for (int ts = 0; ts < tn; ts++) {
								if (!sol.isTrue(enc.vars.link(ref.index, oc.getName(), os, tc.getName(), ts))) continue;
								EObject targetObj = bySlot.get(slotKey(tc.getName(), ts));
								if (targetObj != null) sysApi.createLink("Ref" + ref.index, useNameOf.get(ownerObj), useNameOf.get(targetObj));
							}
						}
					}
				}
			}
		} catch (UseApiException e) {
			throw new Failure("run", "No se pudo reproducir el modelo encontrado en USE: " + e.getMessage());
		}

		StringWriter log = new StringWriter();
		boolean structurallyValid = sysApi.checkState(new PrintWriter(log));

		// 5. every OCL invariant, checked for real by USE (not just the ones our own compiler could turn into SAT)
		Map<EObject, List<String>> violatedBy = new IdentityHashMap<>();
		List<Object> oclResults = new ArrayList<>();
		boolean oclOk = true;
		for (Ocl2Sat.Constraint c : loaded.constraints) {
			int instances = 0, violations = 0;
			List<String> examples = new ArrayList<>();
			String error = null;
			try {
				Value all = sysApi.evaluate(c.context + ".allInstances()");
				if (all instanceof CollectionValue cv) instances = cv.size();
				// "self" is the OCL keyword bound by an invariant's own context, not usable as a fresh iterator
				// variable here — rebind the body's "self" references to a plain variable for this query.
				String body = c.source.replaceAll("\\bself\\b", "__self__");
				Value bad = sysApi.evaluate(c.context + ".allInstances()->select(__self__ | not (" + body + "))");
				if (bad instanceof CollectionValue cv) {
					for (Value v : cv) {
						if (!(v instanceof ObjectValue ov)) continue;
						violations++;
						String name = ov.value().name();
						if (examples.size() < MAX_OCL_EXAMPLES) examples.add(name);
						EObject obj = byUseName.get(name);
						if (obj != null) violatedBy.computeIfAbsent(obj, k -> new ArrayList<>()).add(c.context + "." + c.name);
					}
				}
			} catch (UseApiException e) {
				error = e.getMessage();
			}
			if (violations > 0 || error != null) oclOk = false;
			oclResults.add(Json.obj("context", c.context, "name", c.name, "expression", c.source,
					"instances", instances, "violations", violations, "examples", examples, "error", error));
		}

		Map<String, Object> graph = new GraphExporter().export(resource, violatedBy);
		String xmi = toXmi(resource);

		return Json.obj(
				"ok", true, "sat", true,
				"objects", objectCount,
				"byClass", byClass,
				"graph", graph,
				"xmi", xmi,
				"cnf", cnfText,
				"diagnosis", Json.obj("ok", structurallyValid, "log", log.toString()),
				"ocl", Json.obj("ok", oclOk, "constraints", oclResults, "fileErrors", loaded.oclErrors),
				"translatedConstraints", enc.translatedConstraints,
				"untranslatedConstraints", enc.untranslatedConstraints,
				"satStats", satStats);
	}

	private static String slotKey(String className, int slot) {
		return className + "#" + slot;
	}

	@SuppressWarnings("unchecked")
	private static void addLink(EObject owner, EReference forward, EObject target) {
		if (forward.isMany()) ((EList<EObject>) owner.eGet(forward)).add(target);
		else owner.eSet(forward, target);
	}

	private static String toXmi(Resource resource) throws Failure {
		try {
			ByteArrayOutputStream out = new ByteArrayOutputStream();
			resource.save(out, null);
			return out.toString(StandardCharsets.UTF_8);
		} catch (Exception e) {
			throw new Failure("run", "No se pudo exportar a XMI: " + rootMessage(e));
		}
	}

	private static String rootMessage(Throwable t) {
		Throwable cause = t;
		while (cause.getCause() != null && cause.getCause() != cause) cause = cause.getCause();
		String message = cause.getMessage();
		return message == null ? cause.toString() : message;
	}
}
