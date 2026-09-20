package de.hub.randomemf.server;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.FileObject;
import javax.tools.ForwardingJavaFileManager;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileManager;
import javax.tools.JavaFileObject;
import javax.tools.SimpleJavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;

import org.eclipse.xtext.generator.IGenerator;
import org.eclipse.xtext.generator.InMemoryFileSystemAccess;
import org.eclipse.xtext.resource.XtextResource;
import org.eclipse.xtext.resource.XtextResourceSet;
import org.eclipse.xtext.util.CancelIndicator;
import org.eclipse.xtext.validation.CheckMode;
import org.eclipse.xtext.validation.Issue;

import com.google.inject.Injector;

import de.hub.randomemf.RandomEMFStandaloneSetup;
import de.hub.randomemf.randomEMF.Generator;

/**
 * Runs the RandomEMF toolchain on the source text of an rcore file: parse and validate it with the Xtext
 * language, let the language's JVM model inferrer + Xbase generate the Java class of the generator,
 * compile that class in memory and load it.
 */
final class RcoreEngine {

	static final class Analysis {
		final List<Object> issues = new ArrayList<Object>();
		boolean hasErrors;
		Generator generator;
		RuleIndex rules;
		XtextResource resource;
		String className;
		List<Object> params = new ArrayList<Object>();
	}

	static final class CompiledGenerator {
		final Class<?> type;
		final String java;

		CompiledGenerator(Class<?> type, String java) {
			this.type = type;
			this.java = java;
		}
	}

	/** The source is not valid or its generated Java does not compile. */
	static final class CompilationFailed extends Exception {
		private static final long serialVersionUID = 1L;

		CompilationFailed(String message) {
			super(message);
		}
	}

	private static final int CACHE_SIZE = 16;

	private final Injector injector;
	private final Metamodels metamodels;
	private final Map<String, CompiledGenerator> cache = new LinkedHashMap<String, CompiledGenerator>(16, 0.75f, true) {
		private static final long serialVersionUID = 1L;

		@Override
		protected boolean removeEldestEntry(Map.Entry<String, CompiledGenerator> eldest) {
			return size() > CACHE_SIZE;
		}
	};
	private int counter;

	RcoreEngine(Metamodels metamodels) {
		this.metamodels = metamodels;
		injector = new RandomEMFStandaloneSetup().createInjectorAndDoEMFRegistration();
	}

	/** Parses and validates; never throws for invalid input, reports issues instead. */
	synchronized Analysis analyze(String source) {
		// new or changed metamodel files: regenerate their Java, and drop generators compiled against the old classes
		if (metamodels.refresh(false)) {
			cache.clear();
		}
		Analysis analysis = new Analysis();
		XtextResourceSet resourceSet = injector.getInstance(XtextResourceSet.class);
		resourceSet.setClasspathURIContext(metamodels.loader());
		XtextResource resource = (XtextResource) resourceSet.createResource(
				org.eclipse.emf.common.util.URI.createURI("synthetic:/generator" + (counter++) + ".rcore"));
		try {
			resource.load(new ByteArrayInputStream(source.getBytes(StandardCharsets.UTF_8)), Collections.emptyMap());
		} catch (IOException e) {
			analysis.hasErrors = true;
			analysis.issues.add(Json.obj("severity", "error", "message", String.valueOf(e.getMessage()),
					"line", 1, "column", 1, "offset", 0, "length", 0));
			return analysis;
		}

		for (Issue issue : resource.getResourceServiceProvider().getResourceValidator().validate(resource, CheckMode.ALL, CancelIndicator.NullImpl)) {
			String severity = issue.getSeverity().name().toLowerCase();
			if (severity.equals("error")) {
				analysis.hasErrors = true;
			}
			analysis.issues.add(Json.obj(
					"severity", severity,
					"message", issue.getMessage(),
					"line", issue.getLineNumber() == null ? 1 : issue.getLineNumber(),
					"column", issue.getColumn() == null ? 1 : issue.getColumn(),
					"offset", issue.getOffset() == null ? 0 : issue.getOffset(),
					"length", issue.getLength() == null ? 0 : issue.getLength()));
		}

		analysis.resource = resource;
		if (!resource.getContents().isEmpty() && resource.getContents().get(0) instanceof Generator) {
			Generator generator = (Generator) resource.getContents().get(0);
			if (generator.getName() != null && !generator.getRules().isEmpty()) {
				analysis.generator = generator;
				analysis.rules = new RuleIndex(generator);
				analysis.className = generator.getPackage() == null ? generator.getName() : generator.getPackage() + "." + generator.getName();
				for (org.eclipse.xtext.common.types.JvmFormalParameter parameter : generator.getParams()) {
					String type = parameter.getParameterType() == null ? "?" : parameter.getParameterType().getSimpleName();
					analysis.params.add(Json.obj("name", parameter.getName(), "type", type));
				}
			}
		}
		return analysis;
	}

	/** Compiles the generator described by the (already analyzed, error free) source. Cached by source text. */
	synchronized CompiledGenerator compile(String source, Analysis analysis) throws CompilationFailed {
		String key = sha1(source) + ":" + metamodels.version();
		CompiledGenerator cached = cache.get(key);
		if (cached != null) {
			return cached;
		}
		if (analysis.hasErrors || analysis.generator == null) {
			throw new CompilationFailed("El generador tiene errores");
		}

		InMemoryFileSystemAccess files = new InMemoryFileSystemAccess();
		injector.getInstance(IGenerator.class).doGenerate(analysis.resource, files);
		Map<String, String> sources = new LinkedHashMap<String, String>();
		for (Map.Entry<String, CharSequence> file : files.getTextFiles().entrySet()) {
			String path = file.getKey().replace("DEFAULT_OUTPUT", "");
			if (path.endsWith(".java")) {
				sources.put(path.replaceAll("^/", "").replace('/', '.').replaceAll("\\.java$", ""), file.getValue().toString());
			}
		}
		if (!sources.containsKey(analysis.className)) {
			throw new CompilationFailed("RandomEMF no generó la clase " + analysis.className);
		}

		MemoryClassLoader loader = javac(sources);
		try {
			CompiledGenerator compiled = new CompiledGenerator(loader.loadClass(analysis.className), sources.get(analysis.className));
			cache.put(key, compiled);
			return compiled;
		} catch (ClassNotFoundException e) {
			throw new CompilationFailed("No se pudo cargar " + analysis.className);
		}
	}

	private MemoryClassLoader javac(Map<String, String> sources) throws CompilationFailed {
		JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
		if (compiler == null) {
			throw new CompilationFailed("No hay compilador Java disponible (¿JRE en lugar de JDK?)");
		}
		DiagnosticCollector<JavaFileObject> diagnostics = new DiagnosticCollector<JavaFileObject>();
		MemoryClassLoader loader = new MemoryClassLoader(metamodels.loader());
		StandardJavaFileManager standard = compiler.getStandardFileManager(diagnostics, null, StandardCharsets.UTF_8);
		List<JavaFileObject> units = new ArrayList<JavaFileObject>();
		for (Map.Entry<String, String> source : sources.entrySet()) {
			units.add(new SourceFile(source.getKey(), source.getValue()));
		}
		List<String> options = Arrays.asList("-classpath", System.getProperty("java.class.path") + metamodels.extraClasspath(), "-proc:none", "-nowarn", "-g", "-source", "1.8", "-target", "1.8");
		boolean ok = compiler.getTask(null, new MemoryFileManager(standard, loader), diagnostics, options, null, units).call();
		if (!ok) {
			StringBuilder message = new StringBuilder("El Java generado no compila:");
			for (Diagnostic<? extends JavaFileObject> diagnostic : diagnostics.getDiagnostics()) {
				if (diagnostic.getKind() == Diagnostic.Kind.ERROR) {
					message.append("\n  línea ").append(diagnostic.getLineNumber()).append(": ").append(diagnostic.getMessage(null));
				}
			}
			throw new CompilationFailed(message.toString());
		}
		return loader;
	}

	private static String sha1(String text) {
		try {
			byte[] digest = MessageDigest.getInstance("SHA-1").digest(text.getBytes(StandardCharsets.UTF_8));
			StringBuilder hex = new StringBuilder();
			for (byte b : digest) {
				hex.append(String.format("%02x", b));
			}
			return hex.toString();
		} catch (java.security.NoSuchAlgorithmException e) {
			throw new IllegalStateException(e);
		}
	}

	// --- in-memory compilation ---

	private static final class SourceFile extends SimpleJavaFileObject {
		private final String code;

		SourceFile(String className, String code) {
			super(URI.create("string:///" + className.replace('.', '/') + Kind.SOURCE.extension), Kind.SOURCE);
			this.code = code;
		}

		@Override
		public CharSequence getCharContent(boolean ignoreEncodingErrors) {
			return code;
		}
	}

	private static final class ClassFile extends SimpleJavaFileObject {
		private final ByteArrayOutputStream bytes = new ByteArrayOutputStream();

		ClassFile(String className) {
			super(URI.create("mem:///" + className.replace('.', '/') + Kind.CLASS.extension), Kind.CLASS);
		}

		@Override
		public OutputStream openOutputStream() {
			return bytes;
		}
	}

	private static final class MemoryClassLoader extends ClassLoader {
		private final Map<String, ClassFile> classes = new HashMap<String, ClassFile>();

		MemoryClassLoader(ClassLoader parent) {
			super(parent);
		}

		@Override
		protected Class<?> findClass(String name) throws ClassNotFoundException {
			ClassFile file = classes.get(name);
			if (file == null) {
				throw new ClassNotFoundException(name);
			}
			byte[] bytes = file.bytes.toByteArray();
			return defineClass(name, bytes, 0, bytes.length);
		}
	}

	private static final class MemoryFileManager extends ForwardingJavaFileManager<JavaFileManager> {
		private final MemoryClassLoader loader;

		MemoryFileManager(JavaFileManager delegate, MemoryClassLoader loader) {
			super(delegate);
			this.loader = loader;
		}

		@Override
		public JavaFileObject getJavaFileForOutput(Location location, String className, JavaFileObject.Kind kind, FileObject sibling) {
			ClassFile file = new ClassFile(className);
			loader.classes.put(className, file);
			return file;
		}
	}
}
