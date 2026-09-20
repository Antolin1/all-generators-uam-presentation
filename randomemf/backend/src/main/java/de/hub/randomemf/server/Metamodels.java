package de.hub.randomemf.server;

import java.io.File;
import java.io.IOException;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;

import org.eclipse.emf.codegen.ecore.genmodel.GenJDKLevel;
import org.eclipse.emf.codegen.ecore.genmodel.GenModel;
import org.eclipse.emf.codegen.ecore.genmodel.GenModelFactory;
import org.eclipse.emf.codegen.ecore.genmodel.GenModelPackage;
import org.eclipse.emf.codegen.ecore.genmodel.GenPackage;
import org.eclipse.emf.codegen.ecore.genmodel.generator.GenBaseGeneratorAdapter;
import org.eclipse.emf.codegen.ecore.genmodel.generator.GenModelGeneratorAdapterFactory;
import org.eclipse.emf.codegen.ecore.generator.Generator;
import org.eclipse.emf.common.util.BasicMonitor;
import org.eclipse.emf.common.util.URI;
import org.eclipse.emf.ecore.EClass;
import org.eclipse.emf.ecore.EClassifier;
import org.eclipse.emf.ecore.EPackage;
import org.eclipse.emf.ecore.EcorePackage;
import org.eclipse.emf.ecore.plugin.EcorePlugin;
import org.eclipse.emf.ecore.resource.Resource;
import org.eclipse.emf.ecore.resource.ResourceSet;
import org.eclipse.emf.ecore.resource.impl.ResourceSetImpl;
import org.eclipse.emf.ecore.xmi.impl.XMIResourceFactoryImpl;
import org.eclipse.emf.ecore.xmi.XMLResource;
import org.eclipse.xtext.ecore.EcoreSupportStandaloneSetup;

/**
 * Makes metamodels resolvable outside Eclipse.
 * <p>
 * rcore generators name their metamodel with a <code>platform:/resource/...</code> URI, and the Java that RandomEMF
 * generates for a generator needs the <em>EMF-generated Java classes</em> of that metamodel (and its GenModel, which
 * {@code GenModelHelper} looks up by namespace URI). In Eclipse both exist because you ran EMF's code generation; here
 * the Ecore built into EMF is registered by hand and every {@code *.ecore} dropped into the metamodels directory gets
 * its GenModel and Java code generated, compiled and registered automatically, and again when the files change.
 */
final class Metamodels {

	static final String ECORE_URI = "platform:/resource/org.eclipse.emf.ecore/model/Ecore.ecore";
	static final String PROJECT = "metamodels";
	private static final String JAVA_BASE_PACKAGE = "mm";

	static final class Entry {
		final String file;
		final boolean builtin;
		String status = "ok"; // ok | error
		String error;
		final List<EPackage> packages = new ArrayList<EPackage>();
		GenModel genModel;

		Entry(String file, boolean builtin) {
			this.file = file;
			this.builtin = builtin;
		}

		/** URI to write after <code>in</code> in an rcore generator. */
		String uri() {
			return builtin ? ECORE_URI : "platform:/resource/" + PROJECT + "/" + file;
		}

		int classCount() {
			int count = 0;
			for (EPackage p : packages) count += classCount(p);
			return count;
		}

		private static int classCount(EPackage ePackage) {
			int count = 0;
			for (EClassifier c : ePackage.getEClassifiers()) {
				if (c instanceof EClass) count++;
			}
			for (EPackage sub : ePackage.getESubpackages()) count += classCount(sub);
			return count;
		}
	}

	private final Path directory;
	private final Path workRoot;
	private final List<Entry> entries = new ArrayList<Entry>();
	private final Set<String> registeredNsUris = new HashSet<String>();
	private final Set<String> registeredProjects = new HashSet<String>();
	private URLClassLoader loader;
	private String fingerprint;
	private int version;
	private final List<String> classDirs = new ArrayList<String>();

	Metamodels(Path directory) throws IOException {
		this.directory = directory;
		this.workRoot = Files.createTempDirectory("mmgen");
		registerBuiltin();
	}

	/** Ecore itself, which lives inside the EMF jar and already has its Java classes. */
	private static void registerBuiltin() {
		// resource service providers for *.ecore / *.genmodel, so Xtext can index and link into metamodels
		EcoreSupportStandaloneSetup.setup();
		// GenModelHelper reads the genmodel of every metamodel to find its generated Java classes
		EPackage.Registry.INSTANCE.put(GenModelPackage.eNS_URI, GenModelPackage.eINSTANCE);
		Resource.Factory.Registry.INSTANCE.getExtensionToFactoryMap().put("genmodel", new XMIResourceFactoryImpl());

		// platform:/resource/org.eclipse.emf.ecore/model/Ecore.ecore  ->  Ecore.ecore inside the EMF jar
		URL ecoreJar = EcorePackage.class.getProtectionDomain().getCodeSource().getLocation();
		EcorePlugin.getPlatformResourceMap().put("org.eclipse.emf.ecore", URI.createURI("jar:" + ecoreJar.toExternalForm() + "!/"));
		EcorePlugin.getEPackageNsURIToGenModelLocationMap().put(EcorePackage.eNS_URI,
				URI.createURI("platform:/resource/org.eclipse.emf.ecore/model/Ecore.genmodel"));
	}

	Path directory() {
		return directory;
	}

	synchronized int version() {
		return version;
	}

	/** The class loader that sees the generated classes of every metamodel; the app's loader if there are none. */
	synchronized ClassLoader loader() {
		return loader != null ? loader : Metamodels.class.getClassLoader();
	}

	/** Extra class path (generated metamodel classes) for compiling generators. */
	synchronized String extraClasspath() {
		StringBuilder path = new StringBuilder();
		for (String dir : classDirs) {
			path.append(File.pathSeparatorChar).append(dir);
		}
		return path.toString();
	}

	synchronized List<Entry> entries() {
		return new ArrayList<Entry>(entries);
	}

	synchronized Entry find(String file) {
		for (Entry entry : entries) {
			if (entry.file.equals(file)) return entry;
		}
		return null;
	}

	/** Rebuilds everything if files were added, removed or modified since the last call. Returns whether it did. */
	synchronized boolean refresh(boolean force) {
		String current = fingerprint();
		if (!force && current.equals(fingerprint)) {
			return false;
		}
		fingerprint = current;
		rebuild();
		return true;
	}

	private String fingerprint() {
		StringBuilder text = new StringBuilder();
		for (File file : files(".ecore", ".genmodel")) {
			text.append(file.getName()).append(':').append(file.lastModified()).append(':').append(file.length()).append(';');
		}
		return text.toString();
	}

	private List<File> files(String... extensions) {
		File[] all = directory.toFile().listFiles();
		List<File> result = new ArrayList<File>();
		if (all != null) {
			for (File file : all) {
				for (String extension : extensions) {
					if (file.isFile() && file.getName().endsWith(extension)) result.add(file);
				}
			}
		}
		Collections.sort(result);
		return result;
	}

	// --- rebuild ---

	private void rebuild() {
		version++;
		// forget what the previous round registered
		for (String nsUri : registeredNsUris) {
			EPackage.Registry.INSTANCE.remove(nsUri);
			EcorePlugin.getEPackageNsURIToGenModelLocationMap().remove(nsUri);
		}
		registeredNsUris.clear();
		for (String project : registeredProjects) {
			EcorePlugin.getPlatformResourceMap().remove(project);
		}
		registeredProjects.clear();
		entries.clear();
		classDirs.clear();

		entries.add(builtinEntry());
		EcorePlugin.getPlatformResourceMap().put(PROJECT, URI.createFileURI(directory.toAbsolutePath().toString() + File.separator));
		registeredProjects.add(PROJECT);

		Path work = workRoot.resolve("v" + version);
		List<URL> urls = new ArrayList<URL>();
		for (File file : files(".ecore")) {
			Entry entry = new Entry(file.getName(), false);
			entries.add(entry);
			try {
				build(entry, work.resolve(stem(file.getName())));
				File classes = work.resolve(stem(file.getName())).resolve("classes").toFile();
				classDirs.add(classes.getAbsolutePath());
				urls.add(classes.toURI().toURL());
			} catch (Throwable t) {
				entry.status = "error";
				entry.error = message(t);
				System.err.println("Metamodelo " + file.getName() + ": " + entry.error);
			}
		}

		loader = new URLClassLoader(urls.toArray(new URL[0]), Metamodels.class.getClassLoader());
		// touching the generated EPackage registers it (and its factory) in EPackage.Registry
		for (Entry entry : entries) {
			if (entry.builtin || !entry.status.equals("ok")) continue;
			try {
				for (GenPackage genPackage : entry.genModel.getGenPackages()) {
					Class.forName(genPackage.getQualifiedPackageInterfaceName(), true, loader).getField("eINSTANCE").get(null);
				}
			} catch (Throwable t) {
				entry.status = "error";
				entry.error = "Las clases generadas no se pudieron cargar: " + message(t);
			}
		}
	}

	private Entry builtinEntry() {
		Entry entry = new Entry("Ecore.ecore", true);
		entry.packages.add(EcorePackage.eINSTANCE);
		return entry;
	}

	private void build(Entry entry, Path out) throws Exception {
		Files.createDirectories(out.resolve("src"));
		Files.createDirectories(out.resolve("classes"));
		String project = "mmgen-" + stem(entry.file);
		EcorePlugin.getPlatformResourceMap().put(project, URI.createFileURI(out.toAbsolutePath().toString() + File.separator));
		registeredProjects.add(project);

		// 1. the metamodel
		ResourceSet resourceSet = new ResourceSetImpl();
		resourceSet.getResourceFactoryRegistry().getExtensionToFactoryMap().put("ecore", new org.eclipse.emf.ecore.xmi.impl.EcoreResourceFactoryImpl());
		resourceSet.getResourceFactoryRegistry().getExtensionToFactoryMap().put("genmodel", new XMIResourceFactoryImpl());
		Resource ecore = resourceSet.getResource(URI.createURI(entry.uri()), true);
		for (org.eclipse.emf.ecore.EObject root : ecore.getContents()) {
			if (root instanceof EPackage) entry.packages.add((EPackage) root);
		}
		if (entry.packages.isEmpty()) {
			throw new IllegalStateException("El archivo no contiene ningún EPackage");
		}
		for (EPackage ePackage : entry.packages) {
			org.eclipse.emf.common.util.Diagnostic diagnostic = org.eclipse.emf.ecore.util.Diagnostician.INSTANCE.validate(ePackage);
			if (diagnostic.getSeverity() == org.eclipse.emf.common.util.Diagnostic.ERROR) {
				throw new IllegalStateException("El metamodelo no es válido: " + firstError(diagnostic));
			}
			if (ePackage.getNsURI() == null) {
				throw new IllegalStateException("El paquete «" + ePackage.getName() + "» no tiene nsURI");
			}
			if (EPackage.Registry.INSTANCE.containsKey(ePackage.getNsURI()) && !registeredNsUris.contains(ePackage.getNsURI())) {
				throw new IllegalStateException("El nsURI «" + ePackage.getNsURI() + "» ya está registrado (¿es Ecore u otro metamodelo incorporado?)");
			}
		}
		for (Entry other : entries) {
			if (other != entry && other.status.equals("ok")) {
				for (EPackage mine : entry.packages) {
					for (EPackage theirs : other.packages) {
						if (mine.getNsURI().equals(theirs.getNsURI())) {
							throw new IllegalStateException("El nsURI «" + mine.getNsURI() + "» ya lo usa " + other.file);
						}
					}
				}
			}
		}

		// 2. its GenModel: the one next to the .ecore if any, otherwise a default one
		GenModel genModel = loadOrCreateGenModel(resourceSet, entry, project);
		entry.genModel = genModel;
		genModel.setModelDirectory("/" + project + "/src");
		genModel.setUpdateClasspath(false);
		genModel.setCanGenerate(true);
		URI genModelUri = URI.createURI("platform:/resource/" + project + "/" + stem(entry.file) + ".genmodel");
		Resource genModelResource = genModel.eResource();
		if (genModelResource == null) {
			genModelResource = resourceSet.createResource(genModelUri);
			genModelResource.getContents().add(genModel);
		} else {
			genModelResource.setURI(genModelUri);
		}
		genModelResource.save(Collections.singletonMap(XMLResource.OPTION_ENCODING, "UTF-8"));

		// 3. EMF's own code generation: interfaces, implementations, package, factory, util
		Generator generator = new Generator();
		// the descriptor must be registered before setInput, which is when the adapter factories are created
		generator.getAdapterFactoryDescriptorRegistry().addDescriptor(GenModelPackage.eNS_URI, GenModelGeneratorAdapterFactory.DESCRIPTOR);
		generator.setInput(genModel);
		org.eclipse.emf.common.util.Diagnostic result = generator.generate(genModel, GenBaseGeneratorAdapter.MODEL_PROJECT_TYPE, new BasicMonitor());
		if (result.getSeverity() == org.eclipse.emf.common.util.Diagnostic.ERROR) {
			throw new IllegalStateException("Falló la generación de código EMF: " + firstError(result));
		}

		// 4. compile it
		compile(out.resolve("src"), out.resolve("classes"));

		// 5. what RandomEMF looks up while it infers the generator's Java
		for (EPackage ePackage : entry.packages) {
			EcorePlugin.getEPackageNsURIToGenModelLocationMap().put(ePackage.getNsURI(), genModelUri);
			registeredNsUris.add(ePackage.getNsURI());
		}
	}

	private GenModel loadOrCreateGenModel(ResourceSet resourceSet, Entry entry, String project) throws IOException {
		File sibling = directory.resolve(stem(entry.file) + ".genmodel").toFile();
		if (sibling.isFile()) {
			Resource resource = resourceSet.getResource(URI.createURI("platform:/resource/" + PROJECT + "/" + sibling.getName()), true);
			if (!resource.getContents().isEmpty() && resource.getContents().get(0) instanceof GenModel) {
				return (GenModel) resource.getContents().get(0);
			}
		}
		GenModel genModel = GenModelFactory.eINSTANCE.createGenModel();
		genModel.setComplianceLevel(GenJDKLevel.JDK80_LITERAL);
		genModel.setModelName(capitalize(identifier(stem(entry.file))));
		genModel.setModelPluginID(project);
		genModel.setRootExtendsClass("org.eclipse.emf.ecore.impl.MinimalEObjectImpl$Container");
		genModel.initialize(entry.packages);
		for (GenPackage genPackage : genModel.getAllGenPackagesWithClassifiers()) {
			genPackage.setBasePackage(JAVA_BASE_PACKAGE);
			// nsPrefix is free text (Yakindu's is "hu.bme.mit.inf.yakindumm"), but the prefix names Java classes
			genPackage.setPrefix(capitalize(identifier(genPackage.getEcorePackage().getName())));
		}
		return genModel;
	}

	private static void compile(Path sources, Path classes) throws IOException {
		List<File> java = new ArrayList<File>();
		collect(sources.toFile(), java);
		if (java.isEmpty()) {
			throw new IllegalStateException("EMF no generó ningún archivo Java");
		}
		JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
		DiagnosticCollector<JavaFileObject> diagnostics = new DiagnosticCollector<JavaFileObject>();
		StandardJavaFileManager files = compiler.getStandardFileManager(diagnostics, null, StandardCharsets.UTF_8);
		boolean ok = compiler.getTask(null, files, diagnostics,
				Arrays.asList("-classpath", System.getProperty("java.class.path"), "-d", classes.toString(), "-proc:none", "-nowarn", "-source", "1.8", "-target", "1.8"),
				null, files.getJavaFileObjectsFromFiles(java)).call();
		if (!ok) {
			StringBuilder message = new StringBuilder("El Java generado por EMF no compila:");
			int shown = 0;
			for (Diagnostic<? extends JavaFileObject> diagnostic : diagnostics.getDiagnostics()) {
				if (diagnostic.getKind() == Diagnostic.Kind.ERROR && shown++ < 5) {
					message.append("\n  ").append(diagnostic.getSource() == null ? "" : new File(diagnostic.getSource().getName()).getName())
							.append(':').append(diagnostic.getLineNumber()).append(' ').append(diagnostic.getMessage(null));
				}
			}
			throw new IllegalStateException(message.toString());
		}
	}

	private static void collect(File dir, List<File> out) {
		File[] children = dir.listFiles();
		if (children == null) return;
		for (File child : children) {
			if (child.isDirectory()) collect(child, out);
			else if (child.getName().endsWith(".java")) out.add(child);
		}
	}

	// --- helpers ---

	private static String firstError(org.eclipse.emf.common.util.Diagnostic diagnostic) {
		for (org.eclipse.emf.common.util.Diagnostic child : diagnostic.getChildren()) {
			if (child.getSeverity() == org.eclipse.emf.common.util.Diagnostic.ERROR) {
				String nested = firstError(child);
				return nested.isEmpty() ? child.getMessage() : nested;
			}
		}
		return diagnostic.getSeverity() == org.eclipse.emf.common.util.Diagnostic.ERROR && diagnostic.getChildren().isEmpty() ? diagnostic.getMessage() : "";
	}

	private static String message(Throwable t) {
		for (Throwable cause = t; cause != null; cause = cause.getCause()) {
			if (cause instanceof org.xml.sax.SAXParseException) {
				org.xml.sax.SAXParseException xml = (org.xml.sax.SAXParseException) cause;
				return "No es un XML válido (línea " + xml.getLineNumber() + ", columna " + xml.getColumnNumber() + "): " + xml.getMessage();
			}
		}
		String text = t.getMessage();
		return text == null || text.isEmpty() ? t.toString() : text;
	}

	static String stem(String file) {
		int dot = file.lastIndexOf('.');
		return dot < 0 ? file : file.substring(0, dot);
	}

	static String identifier(String text) {
		StringBuilder id = new StringBuilder();
		for (char c : text.toCharArray()) {
			id.append(Character.isJavaIdentifierPart(c) ? c : '_');
		}
		if (id.length() == 0 || !Character.isJavaIdentifierStart(id.charAt(0))) id.insert(0, '_');
		return id.toString();
	}

	static String capitalize(String text) {
		return text.isEmpty() ? text : Character.toUpperCase(text.charAt(0)) + text.substring(1);
	}

}
