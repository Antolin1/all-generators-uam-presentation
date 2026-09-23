package org.satgen.server;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import org.eclipse.emf.common.util.BasicDiagnostic;
import org.eclipse.emf.common.util.Diagnostic;
import org.eclipse.emf.common.util.URI;
import org.eclipse.emf.ecore.EClass;
import org.eclipse.emf.ecore.EObject;
import org.eclipse.emf.ecore.EPackage;
import org.eclipse.emf.ecore.EcorePackage;
import org.eclipse.emf.ecore.resource.Resource;
import org.eclipse.emf.ecore.util.Diagnostician;
import org.eclipse.emf.ecore.util.EcoreUtil;
import org.eclipse.emf.ecore.xmi.impl.EcoreResourceFactoryImpl;
import org.eclipse.emf.ecore.xmi.impl.XMIResourceFactoryImpl;
import org.eclipse.emf.ecore.xmi.impl.XMIResourceImpl;

/**
 * The *.ecore files in the metamodels directory, each paired with the OCL invariants (from every *.ocl file in
 * the same directory) whose {@code context} class exists in it — the same "match by class name, not file name"
 * convention used by the other generators in this repo.
 */
final class Metamodels {

	static final class Loaded {
		final String file;
		final Resource resource;
		final List<String> errors = new ArrayList<>();
		final List<String> warnings = new ArrayList<>();
		final MetaModel metaModel;
		final List<Ocl2Sat.Constraint> constraints = new ArrayList<>();
		final List<String> oclErrors = new ArrayList<>();

		Loaded(String file, Resource resource, MetaModel metaModel) {
			this.file = file;
			this.resource = resource;
			this.metaModel = metaModel;
		}
	}

	private final File directory;

	Metamodels(File directory) {
		this.directory = directory;
		Resource.Factory.Registry.INSTANCE.getExtensionToFactoryMap().put(EcorePackage.eNS_PREFIX, new EcoreResourceFactoryImpl());
		Resource.Factory.Registry.INSTANCE.getExtensionToFactoryMap().put(Resource.Factory.Registry.DEFAULT_EXTENSION, new XMIResourceFactoryImpl());
	}

	File directory() {
		return directory;
	}

	List<String> files() {
		return listFiles(".ecore");
	}

	List<String> oclFiles() {
		return listFiles(".ocl");
	}

	private List<String> listFiles(String suffix) {
		List<String> names = new ArrayList<>();
		File[] all = directory.listFiles();
		if (all != null) for (File f : all) if (f.isFile() && f.getName().endsWith(suffix)) names.add(f.getName());
		Collections.sort(names);
		return names;
	}

	Loaded load(String file) throws Exception {
		if (file == null || !files().contains(file)) throw new IllegalArgumentException("Metamodelo desconocido: " + file);
		Resource resource = new XMIResourceImpl(URI.createFileURI(new File(directory, file).getAbsolutePath()));
		resource.load(Collections.emptyMap());
		EcoreUtil.resolveAll(resource);

		BasicDiagnostic chain = new BasicDiagnostic();
		for (EObject root : resource.getContents()) Diagnostician.INSTANCE.validate(root, chain);
		Loaded loaded = new Loaded(file, resource, MetaModel.from(resource));
		for (Diagnostic d : chain.getChildren()) {
			if (d.getSeverity() == Diagnostic.ERROR) loaded.errors.add(d.getMessage());
			else if (d.getSeverity() == Diagnostic.WARNING) loaded.warnings.add(d.getMessage());
		}
		for (var it = resource.getAllContents(); it.hasNext();) {
			Object o = it.next();
			if (o instanceof EPackage p && p.getNsURI() != null) EPackage.Registry.INSTANCE.put(p.getNsURI(), p);
		}
		loadConstraints(loaded);
		return loaded;
	}

	private void loadConstraints(Loaded loaded) {
		for (String oclFile : oclFiles()) {
			List<Ocl2Sat.Constraint> parsed;
			try {
				parsed = Ocl2Sat.parse(new String(Files.readAllBytes(new File(directory, oclFile).toPath()), StandardCharsets.UTF_8));
			} catch (Exception e) {
				loaded.oclErrors.add(oclFile + ": " + rootMessage(e));
				continue;
			}
			for (Ocl2Sat.Constraint c : parsed) if (loaded.metaModel.byName.containsKey(c.context)) loaded.constraints.add(c);
		}
	}

	/** JSON description of every metamodel file: its classes and the OCL invariants that apply to it. */
	List<Object> describe() {
		List<Object> items = new ArrayList<>();
		for (String file : files()) {
			try {
				Loaded loaded = load(file);
				List<Object> classes = new ArrayList<>();
				for (EClass c : loaded.metaModel.byName.values()) {
					List<String> supers = new ArrayList<>();
					for (EClass s : c.getESuperTypes()) supers.add(s.getName());
					classes.add(Json.obj(
							"name", c.getName(),
							"abstract", c.isAbstract() || c.isInterface(),
							"supertypes", supers,
							"rootCandidate", loaded.metaModel.containmentRefsInto(c).isEmpty()));
				}
				List<Object> constraints = new ArrayList<>();
				for (Ocl2Sat.Constraint c : loaded.constraints) {
					constraints.add(Json.obj("context", c.context, "name", c.name, "expression", c.source));
				}
				items.add(Json.obj("file", file, "status", loaded.errors.isEmpty() ? "ok" : "invalid",
						"errors", loaded.errors, "warnings", loaded.warnings, "classes", classes,
						"constraints", constraints, "oclErrors", loaded.oclErrors));
			} catch (Throwable t) {
				items.add(Json.obj("file", file, "status", "error", "errors", List.of(rootMessage(t)),
						"warnings", List.of(), "classes", List.of(), "constraints", List.of(), "oclErrors", List.of()));
			}
		}
		return items;
	}

	private static String rootMessage(Throwable t) {
		Throwable cause = t;
		while (cause.getCause() != null && cause.getCause() != cause) cause = cause.getCause();
		String message = cause.getMessage();
		return message == null ? cause.toString() : message;
	}
}
