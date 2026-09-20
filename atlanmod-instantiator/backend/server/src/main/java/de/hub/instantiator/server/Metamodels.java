package de.hub.instantiator.server;

import java.io.File;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.apache.commons.lang3.Range;
import org.eclipse.emf.common.util.BasicDiagnostic;
import org.eclipse.emf.common.util.Diagnostic;
import org.eclipse.emf.common.util.URI;
import org.eclipse.emf.ecore.EAttribute;
import org.eclipse.emf.ecore.EClass;
import org.eclipse.emf.ecore.EObject;
import org.eclipse.emf.ecore.EPackage;
import org.eclipse.emf.ecore.EReference;
import org.eclipse.emf.ecore.EcorePackage;
import org.eclipse.emf.ecore.resource.Resource;
import org.eclipse.emf.ecore.util.Diagnostician;
import org.eclipse.emf.ecore.util.EcoreUtil;
import org.eclipse.emf.ecore.xmi.impl.EcoreResourceFactoryImpl;
import org.eclipse.emf.ecore.xmi.impl.XMIResourceFactoryImpl;
import org.eclipse.emf.ecore.xmi.impl.XMIResourceImpl;

import fr.inria.atlanmod.instantiator.GenericMetamodelConfig;

/**
 * The *.ecore files in the metamodels directory. The instantiator works on the metamodel as data (dynamic EMF), so
 * unlike a code generator there is nothing to generate or compile: a file is just loaded, checked and described.
 */
final class Metamodels {

	/** A loaded metamodel and what was found when checking it. */
	static final class Loaded {
		final String file;
		final Resource resource;
		final List<String> errors = new ArrayList<String>();
		final List<String> warnings = new ArrayList<String>();
		final Map<String, EClass> classes = new LinkedHashMap<String, EClass>();

		Loaded(String file, Resource resource) {
			this.file = file;
			this.resource = resource;
		}
	}

	private final File directory;

	Metamodels(File directory) {
		this.directory = directory;
		// same registry set-up as the instantiator's own Launcher
		Resource.Factory.Registry.INSTANCE.getExtensionToFactoryMap().put(EcorePackage.eNS_PREFIX, new EcoreResourceFactoryImpl());
		Resource.Factory.Registry.INSTANCE.getExtensionToFactoryMap().put(Resource.Factory.Registry.DEFAULT_EXTENSION, new XMIResourceFactoryImpl());
	}

	File directory() {
		return directory;
	}

	List<String> files() {
		List<String> names = new ArrayList<String>();
		File[] all = directory.listFiles();
		if (all != null) {
			for (File f : all) {
				if (f.isFile() && f.getName().endsWith(".ecore")) names.add(f.getName());
			}
		}
		Collections.sort(names);
		return names;
	}

	/** Loads, resolves and validates a metamodel file (only files directly inside the directory are allowed). */
	Loaded load(String file) throws Exception {
		if (file == null || !files().contains(file)) {
			throw new IllegalArgumentException("Metamodelo desconocido: " + file);
		}
		Resource resource = new XMIResourceImpl(URI.createFileURI(new File(directory, file).getAbsolutePath()));
		Loaded loaded = new Loaded(file, resource);
		resource.load(Collections.emptyMap());
		EcoreUtil.resolveAll(resource);

		BasicDiagnostic chain = new BasicDiagnostic();
		for (EObject root : resource.getContents()) {
			Diagnostician.INSTANCE.validate(root, chain);
		}
		for (Diagnostic diagnostic : chain.getChildren()) {
			if (diagnostic.getSeverity() == Diagnostic.ERROR) loaded.errors.add(diagnostic.getMessage());
			else if (diagnostic.getSeverity() == Diagnostic.WARNING) loaded.warnings.add(diagnostic.getMessage());
		}

		for (java.util.Iterator<EObject> it = resource.getAllContents(); it.hasNext();) {
			EObject object = it.next();
			if (object instanceof EPackage) {
				EPackage ePackage = (EPackage) object;
				// the generator creates instances through the package's factory: make the package known by its nsURI
				if (ePackage.getNsURI() != null) EPackage.Registry.INSTANCE.put(ePackage.getNsURI(), ePackage);
			} else if (object instanceof EClass) {
				loaded.classes.put(qualifiedName((EClass) object), (EClass) object);
			}
		}
		return loaded;
	}

	static String qualifiedName(EClass eClass) {
		StringBuilder name = new StringBuilder(eClass.getName());
		for (EPackage p = eClass.getEPackage(); p != null; p = p.getESuperPackage()) {
			name.insert(0, p.getName() + ".");
		}
		return name.toString();
	}

	/** JSON description of every metamodel file, for the class table of the UI. */
	List<Object> describe() {
		List<Object> items = new ArrayList<Object>();
		for (String file : files()) {
			try {
				Loaded loaded = load(file);
				Set<EClass> roots = new GenericMetamodelConfig(loaded.resource, Range.between(1, 1), 0L).possibleRootEClasses();
				List<Object> classes = new ArrayList<Object>();
				for (Map.Entry<String, EClass> entry : loaded.classes.entrySet()) {
					EClass c = entry.getValue();
					List<String> supers = new ArrayList<String>();
					for (EClass s : c.getESuperTypes()) supers.add(s.getName());
					int attributes = 0;
					for (EAttribute a : c.getEAllAttributes()) if (!a.isDerived() && !a.isTransient()) attributes++;
					int references = 0;
					int containments = 0;
					for (EReference r : c.getEAllReferences()) {
						if (r.isContainer() || r.isDerived() || r.isTransient()) continue;
						references++;
						if (r.isContainment()) containments++;
					}
					classes.add(Json.obj(
							"id", entry.getKey(),
							"name", c.getName(),
							"abstract", c.isAbstract() || c.isInterface(),
							"supertypes", supers,
							"attributes", attributes,
							"references", references,
							"containments", containments,
							"rootCandidate", roots.contains(c)));
				}
				List<Object> packages = new ArrayList<Object>();
				for (java.util.Iterator<EObject> it = loaded.resource.getAllContents(); it.hasNext();) {
					EObject o = it.next();
					if (o instanceof EPackage) packages.add(Json.obj("name", ((EPackage) o).getName(), "nsURI", ((EPackage) o).getNsURI()));
				}
				items.add(Json.obj("file", file, "status", loaded.errors.isEmpty() ? "ok" : "invalid", "errors", loaded.errors,
						"warnings", loaded.warnings, "packages", packages, "classes", classes));
			} catch (Throwable t) {
				items.add(Json.obj("file", file, "status", "error", "errors", Collections.singletonList(String.valueOf(rootMessage(t))),
						"warnings", new ArrayList<String>(), "packages", new ArrayList<Object>(), "classes", new ArrayList<Object>()));
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
