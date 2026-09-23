package de.hub.instantiator.server;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicReference;
import java.util.logging.Handler;
import java.util.logging.Level;
import java.util.logging.LogRecord;
import java.util.logging.Logger;

import org.apache.commons.lang3.Range;
import org.eclipse.emf.common.util.BasicDiagnostic;
import org.eclipse.emf.common.util.Diagnostic;
import org.eclipse.emf.ecore.EAttribute;
import org.eclipse.emf.ecore.EClass;
import org.eclipse.emf.ecore.EObject;
import org.eclipse.emf.ecore.EStructuralFeature;
import org.eclipse.emf.ecore.resource.Resource;
import org.eclipse.emf.ecore.resource.impl.ResourceSetImpl;
import org.eclipse.emf.ecore.util.Diagnostician;

import fr.inria.atlanmod.instantiator.GenericMetamodelConfig;
import fr.inria.atlanmod.instantiator.GenericMetamodelGenerator;
import fr.obeo.emf.specimen.SpecimenGenerator;

/** Runs the AtlanMod instantiator once, with the same parameter handling as its command-line launcher. */
final class Runner {

	static final int MAX_SIZE = 200000;
	/** Fixed: average length of generated text values (only its +/- variation is below; the tolerance the UI exposes is size/degree). */
	private static final int VALUES_SIZE = 12;
	private static final float VALUES_VARIATION = 0.1f;
	/** Defaults for the two tolerances the UI can change: how much the model size and the degree may vary around the requested value. */
	static final float DEFAULT_SIZE_VARIATION = 0.1f;
	static final float DEFAULT_DEGREE_VARIATION = 0.1f;
	private static final int MAX_XMI_BYTES = 3 * 1024 * 1024;
	private static final int MAX_GRAPH_OBJECTS = 300;
	private static final int MAX_GRAPH_EDGES = 1500;
	private static final int MAX_OCL_EXAMPLES = 8;

	static final class Request {
		String metamodel;
		int size = 20;
		int degree = 2;
		/** +/- tolerance around `size` and `degree`, as a fraction (0.1 = 10 %). */
		float sizeVariation = DEFAULT_SIZE_VARIATION;
		float degreeVariation = DEFAULT_DEGREE_VARIATION;
		Long seed;
		Set<String> excluded = new HashSet<String>();
		Set<String> roots = new LinkedHashSet<String>();
	}

	static final class Failure extends Exception {
		private static final long serialVersionUID = 1L;
		final String phase;

		Failure(String phase, String message) {
			super(message);
			this.phase = phase;
		}
	}

	private final Metamodels metamodels;
	private final ExecutorService pool = Executors.newCachedThreadPool(runnable -> {
		Thread thread = new Thread(runnable, "instantiator-run");
		thread.setDaemon(true);
		return thread;
	});

	Runner(Metamodels metamodels) {
		this.metamodels = metamodels;
	}

	/** One generation at a time: the instantiator logs through static java.util.logging loggers, which we capture. */
	@SuppressWarnings("removal")
	synchronized Map<String, Object> run(final Request request, long timeoutMillis) throws Failure {
		validate(request);
		final AtomicReference<Thread> worker = new AtomicReference<Thread>();
		Future<Map<String, Object>> future = pool.submit(new Callable<Map<String, Object>>() {
			@Override
			public Map<String, Object> call() throws Exception {
				worker.set(Thread.currentThread());
				return generate(request);
			}
		});
		try {
			return future.get(timeoutMillis, TimeUnit.MILLISECONDS);
		} catch (TimeoutException e) {
			Thread thread = worker.get();
			if (thread != null) thread.stop();
			throw new Failure("run", "La generación superó el límite de " + (timeoutMillis / 1000) + " s y se abortó. Prueba con un tamaño menor.");
		} catch (InterruptedException e) {
			Thread.currentThread().interrupt();
			throw new Failure("run", "Generación interrumpida");
		} catch (ExecutionException e) {
			Throwable cause = e.getCause();
			if (cause instanceof Failure) throw (Failure) cause;
			throw new Failure("run", cause instanceof StackOverflowError ? "Desbordamiento de pila durante la generación" : describe(cause));
		}
	}

	private static void validate(Request r) throws Failure {
		if (r.size < 1 || r.size > MAX_SIZE) throw new Failure("params", "El tamaño debe estar entre 1 y " + MAX_SIZE);
		if (r.degree < 0 || r.degree > 200) throw new Failure("params", "El grado debe estar entre 0 y 200");
		if (r.sizeVariation < 0 || r.sizeVariation > 1) throw new Failure("params", "La tolerancia del tamaño debe estar entre 0 % y 100 %");
		if (r.degreeVariation < 0 || r.degreeVariation > 1) throw new Failure("params", "La tolerancia del grado debe estar entre 0 % y 100 %");
	}

	private Map<String, Object> generate(Request r) throws Exception {
		long start = System.nanoTime();
		Metamodels.Loaded loaded;
		try {
			loaded = metamodels.load(r.metamodel);
		} catch (IllegalArgumentException e) {
			throw new Failure("params", e.getMessage());
		} catch (Exception e) {
			throw new Failure("metamodel", "No se pudo leer el metamodelo: " + rootMessage(e));
		}
		if (!loaded.errors.isEmpty()) {
			throw new Failure("metamodel", "El metamodelo tiene " + loaded.errors.size() + " error(es); corrígelos:\n  - "
					+ String.join("\n  - ", loaded.errors.subList(0, Math.min(5, loaded.errors.size()))));
		}

		Set<EClass> excluded = classes(loaded, r.excluded, "excluida");

		long seed = r.seed != null ? r.seed : System.currentTimeMillis();
		Range<Integer> elements = Range.between(Math.round(r.size * (1 - r.sizeVariation)), Math.round(r.size * (1 + r.sizeVariation)));

		// roots: the ones asked for, or the default candidates; never an excluded class
		ConfigurableConfig probe = new ConfigurableConfig(loaded.resource, elements, seed, excluded, Collections.<EClass>emptySet());
		Set<EClass> roots = r.roots.isEmpty() ? new LinkedHashSet<EClass>(probe.possibleRootEClasses()) : classes(loaded, r.roots, "raíz");
		roots.removeAll(excluded);
		if (roots.isEmpty()) {
			throw new Failure("params", "No queda ninguna metaclase que pueda ser raíz del modelo: revisa las exclusiones y las raíces elegidas.");
		}

		ConfigurableConfig config = new ConfigurableConfig(loaded.resource, elements, seed, excluded, roots);
		// same derivation as the launcher: the "degree" sets both the number of references and of attribute values per object
		config.setValuesRange(Math.round(VALUES_SIZE * (1 - VALUES_VARIATION)), Math.round(VALUES_SIZE * (1 + VALUES_VARIATION)));
		config.setReferencesRange(Math.round(r.degree * (1 - r.degreeVariation)), Math.round(r.degree * (1 + r.degreeVariation)));
		config.setPropertiesRange(Math.round(r.degree * (1 - r.degreeVariation)), Math.round(r.degree * (1 + r.degreeVariation)));

		Path out = Files.createTempDirectory("instantiator");
		LogCapture log = new LogCapture();
		ResourceSetImpl resourceSet = new ResourceSetImpl();
		try {
			GenericMetamodelGenerator generator = new GenericMetamodelGenerator(config);
			generator.setSamplesPath(out);
			log.attach();
			try {
				generator.runGeneration(resourceSet, 1, r.size, r.sizeVariation);
			} finally {
				log.detach();
			}
			long generated = System.nanoTime();

			Resource model = resourceSet.getResources().get(0);
			List<EObject> objectList = new ArrayList<EObject>();
			Map<String, Integer> byClass = new TreeMap<String, Integer>();
			for (Iterator<EObject> it = model.getAllContents(); it.hasNext();) {
				EObject object = it.next();
				objectList.add(object);
				byClass.merge(object.eClass().getName(), 1, Integer::sum);
			}
			int objects = objectList.size();

			Map<String, Object> diagnosis = diagnose(model);
			Map<EObject, List<String>> violatedBy = new IdentityHashMap<EObject, List<String>>();
			Map<String, Object> ocl = checkOcl(model, loaded, objectList, violatedBy);

			Map<String, Object> graph = null;
			String graphSkipped = null;
			if (objects > MAX_GRAPH_OBJECTS) {
				graphSkipped = "El modelo tiene " + objects + " objetos; se dibujan como máximo " + MAX_GRAPH_OBJECTS + ". Descarga el XMI o reduce el tamaño.";
			} else {
				graph = new GraphExporter().export(model, violatedBy);
				if (((Number) ((Map<?, ?>) graph.get("stats")).get("edges")).intValue() > MAX_GRAPH_EDGES) {
					graph = null;
					graphSkipped = "Demasiadas aristas para dibujarlas (más de " + MAX_GRAPH_EDGES + "): reduce el grado o el tamaño.";
				}
			}

			String xmi = null;
			long xmiBytes = 0;
			File xmiFile = firstXmi(out.toFile());
			if (xmiFile != null) {
				xmiBytes = xmiFile.length();
				if (xmiBytes <= MAX_XMI_BYTES) xmi = new String(Files.readAllBytes(xmiFile.toPath()), StandardCharsets.UTF_8);
			}

			Map<String, Object> applied = Json.obj(
					"elements", range(config.getElementsRange()),
					"properties", range(config.getPropertiesRange()),
					"references", range(config.getReferencesRange()),
					"values", range(config.getValuesRange()));
			return Json.obj(
					"ok", true,
					"seed", seed,
					"applied", applied,
					"requested", r.size,
					"objects", objects,
					"byClass", byClass,
					"graph", graph,
					"graphSkipped", graphSkipped,
					"xmi", xmi,
					"xmiBytes", xmiBytes,
					"diagnosis", diagnosis,
					"ocl", ocl,
					"warnings", loaded.warnings.size(),
					"log", log.lines,
					"millis", Json.obj("generate", (generated - start) / 1000000, "total", (System.nanoTime() - start) / 1000000));
		} finally {
			delete(out.toFile());
		}
	}

	/**
	 * Checks every OCL invariant that applies to this metamodel against every instance of its context class
	 * (and its subclasses) in the generated model, and collects which objects violate which rule (for the graph).
	 */
	private static Map<String, Object> checkOcl(Resource model, Metamodels.Loaded loaded, List<EObject> objects, Map<EObject, List<String>> violatedBy) {
		List<Object> results = new ArrayList<Object>();
		boolean ok = true;
		for (Ocl.Constraint constraint : loaded.constraints) {
			EClass contextClass = loaded.classesByName.get(constraint.context);
			int instances = 0;
			int violations = 0;
			String error = null;
			List<String> examples = new ArrayList<String>();
			for (EObject object : objects) {
				if (!contextClass.isSuperTypeOf(object.eClass())) continue;
				instances++;
				boolean holds;
				String objectError = null;
				try {
					holds = Ocl.holds(constraint, object, loaded.lookup);
				} catch (Ocl.OclError e) {
					holds = false;
					objectError = error = e.getMessage();
				}
				if (!holds) {
					violations++;
					if (examples.size() < MAX_OCL_EXAMPLES) {
						examples.add(describe(model, object) + (objectError != null ? " — error de evaluación: " + objectError : ""));
					}
					List<String> tags = violatedBy.get(object);
					if (tags == null) {
						tags = new ArrayList<String>();
						violatedBy.put(object, tags);
					}
					tags.add(constraint.context + "." + constraint.name);
				}
			}
			if (violations > 0 || error != null) ok = false;
			results.add(Json.obj("context", constraint.context, "name", constraint.name, "expression", constraint.source,
					"instances", instances, "violations", violations, "examples", examples, "error", error));
		}
		if (!loaded.oclErrors.isEmpty()) ok = false;
		return Json.obj("ok", ok, "constraints", results, "fileErrors", loaded.oclErrors);
	}

	/** A short, human label for an object in a violation message: its "name" attribute if it has one, else its position in the model. */
	private static String describe(Resource model, EObject object) {
		EStructuralFeature nameFeature = object.eClass().getEStructuralFeature("name");
		if (nameFeature instanceof EAttribute && !nameFeature.isMany() && object.eIsSet(nameFeature)) {
			Object value = object.eGet(nameFeature);
			if (value != null) return object.eClass().getName() + " «" + value + "»";
		}
		return object.eClass().getName() + " (" + model.getURIFragment(object) + ")";
	}

	private static Map<String, Object> diagnose(Resource model) {
		BasicDiagnostic chain = new BasicDiagnostic();
		for (EObject root : model.getContents()) {
			Diagnostician.INSTANCE.validate(root, chain);
		}
		List<String> messages = new ArrayList<String>();
		int errors = 0;
		for (Diagnostic diagnostic : chain.getChildren()) {
			if (diagnostic.getSeverity() == Diagnostic.ERROR) {
				errors++;
				if (messages.size() < 30) messages.add(diagnostic.getMessage());
			}
		}
		return Json.obj("ok", errors == 0, "errors", errors, "messages", messages);
	}

	private static Set<EClass> classes(Metamodels.Loaded loaded, Set<String> ids, String what) throws Failure {
		Set<EClass> result = new LinkedHashSet<EClass>();
		for (String id : ids) result.add(one(loaded, id));
		return result;
	}

	private static EClass one(Metamodels.Loaded loaded, String id) throws Failure {
		EClass eClass = loaded.classes.get(id);
		if (eClass == null) throw new Failure("params", "La metaclase «" + id + "» no existe en " + loaded.file);
		return eClass;
	}

	private static List<Integer> range(Range<Integer> range) {
		List<Integer> list = new ArrayList<Integer>();
		list.add(range.getMinimum());
		list.add(range.getMaximum());
		return list;
	}

	private static File firstXmi(File dir) {
		File[] children = dir.listFiles();
		if (children == null) return null;
		for (File child : children) {
			if (child.isDirectory()) {
				File found = firstXmi(child);
				if (found != null) return found;
			} else if (child.getName().endsWith(".xmi")) {
				return child;
			}
		}
		return null;
	}

	private static void delete(File file) {
		File[] children = file.listFiles();
		if (children != null) for (File child : children) delete(child);
		try {
			Files.deleteIfExists(file.toPath());
		} catch (IOException e) {
			/* temp dir: the OS will clean it */
		}
	}

	private static String rootMessage(Throwable t) {
		Throwable cause = t;
		while (cause.getCause() != null && cause.getCause() != cause) cause = cause.getCause();
		String message = cause.getMessage();
		return message == null ? cause.toString() : message;
	}

	private static String describe(Throwable cause) {
		StringBuilder message = new StringBuilder(cause.toString());
		int shown = 0;
		for (StackTraceElement frame : cause.getStackTrace()) {
			if (shown++ < 4) message.append("\n  en ").append(frame);
		}
		return message.toString();
	}

	/** Collects what the instantiator logs (INFO and above) while a generation runs. */
	private static final class LogCapture extends Handler {
		final List<Object> lines = new ArrayList<Object>();
		private final Logger[] loggers = { Logger.getLogger(GenericMetamodelGenerator.class.getName()), SpecimenGenerator.LOGGER };
		private final Level[] levels = new Level[2];
		private final boolean[] parents = new boolean[2];

		void attach() {
			for (int i = 0; i < loggers.length; i++) {
				levels[i] = loggers[i].getLevel();
				parents[i] = loggers[i].getUseParentHandlers();
				loggers[i].setLevel(Level.INFO);
				loggers[i].setUseParentHandlers(false);
				loggers[i].addHandler(this);
			}
			setLevel(Level.INFO);
		}

		void detach() {
			for (int i = 0; i < loggers.length; i++) {
				loggers[i].removeHandler(this);
				loggers[i].setLevel(levels[i]);
				loggers[i].setUseParentHandlers(parents[i]);
			}
		}

		@Override
		public void publish(LogRecord record) {
			if (record.getLevel().intValue() >= Level.INFO.intValue()) {
				lines.add(Json.obj("level", record.getLevel().getName(), "message", record.getMessage()));
			}
		}

		@Override
		public void flush() {
		}

		@Override
		public void close() {
		}
	}
}
