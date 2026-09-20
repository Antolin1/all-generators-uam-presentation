package de.hub.randomemf.server;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

/** The HTTP API consumed by the web front end. */
final class Api {

	private static final int MAX_BODY = 1 << 20;
	private static final int DEFAULT_MAX_OBJECTS = 100;
	private static final int HARD_MAX_OBJECTS = 5000;
	private static final long RUN_TIMEOUT_MILLIS = 30000;

	private static final String[][] EXAMPLES = {
			{ "RandomEcore", "RandomEcore — genera metamodelos Ecore", "RandomEcore.rcore" },
			{ "TinyEcore", "TinyEcore — con parámetros y regla alternativa", "TinyEcore.rcore" },
	};

	private final RcoreEngine engine;
	private final Metamodels metamodels;
	private final Runner runner = new Runner();
	private volatile boolean ready;

	Api(RcoreEngine engine, Metamodels metamodels) {
		this.engine = engine;
		this.metamodels = metamodels;
	}

	void warmUp() {
		try {
			String source = example(EXAMPLES[0][2]);
			RcoreEngine.Analysis analysis = engine.analyze(source);
			engine.compile(source, analysis);
			runner.run(engine.compile(source, analysis).type, analysis.params, null, 0, 20, 60000);
		} catch (Exception e) {
			System.err.println("Warm-up falló (el servidor sigue disponible): " + e);
		} finally {
			ready = true;
		}
	}

	void register(HttpServer server) {
		server.createContext("/api/health", exchange -> handle(exchange, false, body -> Json.obj("ok", true, "ready", ready)));
		server.createContext("/api/examples", exchange -> handle(exchange, false, body -> examples()));
		server.createContext("/api/metamodels", exchange -> handle(exchange, exchange.getRequestMethod().equals("POST"), this::metamodels));
		server.createContext("/api/template", exchange -> handle(exchange, true, this::template));
		server.createContext("/api/analyze", exchange -> handle(exchange, true, this::analyze));
		server.createContext("/api/generate", exchange -> handle(exchange, true, this::generate));
	}

	// --- endpoints ---

	private Object examples() throws IOException {
		List<Object> list = new ArrayList<Object>();
		for (String[] example : EXAMPLES) {
			list.add(Json.obj("id", example[0], "title", example[1], "source", example(example[2])));
		}
		// generators the user keeps next to their metamodels
		File[] files = metamodels.directory().toFile().listFiles();
		if (files != null) {
			java.util.Arrays.sort(files);
			for (File file : files) {
				if (file.isFile() && file.getName().endsWith(".rcore") && file.length() <= MAX_BODY) {
					list.add(Json.obj("id", "file:" + file.getName(), "title", file.getName() + "  (metamodels/)",
							"source", new String(java.nio.file.Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8)));
				}
			}
		}
		return list;
	}

	/** GET lists the metamodels (rescanning if files changed); POST {"reload": true} forces a rebuild. */
	private Object metamodels(Map<String, Object> request) {
		metamodels.refresh(request != null && Boolean.TRUE.equals(request.get("reload")));
		List<Object> items = new ArrayList<Object>();
		for (Metamodels.Entry entry : metamodels.entries()) {
			List<Object> packages = new ArrayList<Object>();
			for (org.eclipse.emf.ecore.EPackage p : entry.packages) {
				packages.add(Json.obj("name", p.getName(), "nsURI", p.getNsURI()));
			}
			items.add(Json.obj(
					"file", entry.file,
					"builtin", entry.builtin,
					"uri", entry.uri(),
					"status", entry.status,
					"error", entry.error,
					"packages", packages,
					"classes", entry.classCount()));
		}
		return Json.obj("directory", metamodels.directory().toString(), "items", items);
	}

	/** A starting generator for a metamodel. */
	private Object template(Map<String, Object> request) {
		metamodels.refresh(false);
		Metamodels.Entry entry = metamodels.find(string(request, "file"));
		if (entry == null || entry.builtin || !entry.status.equals("ok")) {
			return Json.obj("ok", false, "error", "Ese metamodelo no está disponible");
		}
		try {
			return Json.obj("ok", true, "source", new Scaffold(entry).build());
		} catch (RuntimeException e) {
			return Json.obj("ok", false, "error", String.valueOf(e.getMessage()));
		}
	}

	private Object analyze(Map<String, Object> request) {
		String source = string(request, "source");
		RcoreEngine.Analysis analysis = engine.analyze(source);
		return Json.obj(
				"ok", !analysis.hasErrors,
				"issues", analysis.issues,
				"generator", generatorInfo(analysis),
				"rules", analysis.rules == null ? new ArrayList<Object>() : analysis.rules.rules());
	}

	private Object generate(Map<String, Object> request) {
		long start = System.nanoTime();
		String source = string(request, "source");
		int seed = request.get("seed") instanceof Number ? ((Number) request.get("seed")).intValue() : new java.util.Random().nextInt(1000000);
		int maxObjects = request.get("maxObjects") instanceof Number ? ((Number) request.get("maxObjects")).intValue() : DEFAULT_MAX_OBJECTS;
		maxObjects = Math.max(1, Math.min(maxObjects, HARD_MAX_OBJECTS));
		@SuppressWarnings("unchecked")
		Map<String, Object> args = request.get("args") instanceof Map ? (Map<String, Object>) request.get("args") : null;

		RcoreEngine.Analysis analysis = engine.analyze(source);
		if (analysis.hasErrors || analysis.generator == null) {
			return failure("validation", "El generador tiene errores; corrígelos en el editor.", analysis);
		}

		RcoreEngine.CompiledGenerator compiled;
		try {
			compiled = engine.compile(source, analysis);
		} catch (RcoreEngine.CompilationFailed e) {
			return failure("compile", e.getMessage(), analysis);
		}
		long compiledAt = System.nanoTime();

		Runner.Result result;
		try {
			result = runner.run(compiled.type, analysis.params, args, seed, maxObjects, RUN_TIMEOUT_MILLIS);
		} catch (Runner.RunFailed e) {
			return failure("run", e.getMessage(), analysis);
		}
		if (result.model == null) {
			return failure("run", "El generador no produjo ningún modelo (¿«máx. objetos» demasiado bajo?).", analysis);
		}

		GraphExporter.Ids ids = new GraphExporter.Ids();
		Map<String, Object> graph = new GraphExporter(analysis.rules, result.trace).export(result.model, ids);
		long done = System.nanoTime();
		return Json.obj(
				"ok", true,
				"seed", seed,
				"maxObjects", maxObjects,
				"issues", analysis.issues,
				"generator", generatorInfo(analysis),
				"rules", analysis.rules.rules(),
				"graph", graph,
				"trace", result.trace.toJson(ids),
				"java", compiled.java,
				"millis", Json.obj("prepare", (compiledAt - start) / 1000000, "generate", (done - compiledAt) / 1000000));
	}

	private static Map<String, Object> generatorInfo(RcoreEngine.Analysis analysis) {
		if (analysis.generator == null) {
			return null;
		}
		return Json.obj(
				"name", analysis.generator.getName(),
				"package", analysis.generator.getPackage(),
				"metamodel", analysis.generator.getImportURI(),
				"params", analysis.params);
	}

	private static Map<String, Object> failure(String phase, String error, RcoreEngine.Analysis analysis) {
		return Json.obj(
				"ok", false,
				"phase", phase,
				"error", error,
				"issues", analysis.issues,
				"generator", generatorInfo(analysis),
				"rules", analysis.rules == null ? new ArrayList<Object>() : analysis.rules.rules());
	}

	// --- plumbing ---

	private interface Endpoint {
		Object call(Map<String, Object> request) throws Exception;
	}

	private static String string(Map<String, Object> request, String key) {
		Object value = request.get(key);
		return value == null ? "" : String.valueOf(value);
	}

	private static String example(String file) throws IOException {
		try (InputStream in = Api.class.getResourceAsStream("/examples/" + file)) {
			if (in == null) {
				throw new IOException("Falta el ejemplo " + file);
			}
			return new String(readAll(in, MAX_BODY), StandardCharsets.UTF_8);
		}
	}

	private static byte[] readAll(InputStream in, int limit) throws IOException {
		ByteArrayOutputStream out = new ByteArrayOutputStream();
		byte[] buffer = new byte[8192];
		int read;
		while ((read = in.read(buffer)) >= 0) {
			out.write(buffer, 0, read);
			if (out.size() > limit) {
				throw new IOException("Petición demasiado grande");
			}
		}
		return out.toByteArray();
	}

	private static void handle(HttpExchange exchange, boolean post, Endpoint endpoint) throws IOException {
		try {
			if (!exchange.getRequestMethod().equals(post ? "POST" : "GET")) {
				send(exchange, 405, Json.obj("ok", false, "error", "Método no permitido"));
				return;
			}
			Map<String, Object> request = null;
			if (post) {
				try {
					request = Json.readObject(readAll(exchange.getRequestBody(), MAX_BODY));
				} catch (IOException e) {
					send(exchange, 400, Json.obj("ok", false, "error", "JSON inválido: " + e.getMessage()));
					return;
				}
			}
			long start = System.currentTimeMillis();
			Object response = endpoint.call(request);
			System.out.println(exchange.getRequestMethod() + " " + exchange.getRequestURI().getPath() + " " + (System.currentTimeMillis() - start) + " ms");
			send(exchange, 200, response);
		} catch (Throwable t) {
			t.printStackTrace();
			send(exchange, 500, Json.obj("ok", false, "phase", "server", "error", t.toString()));
		} finally {
			exchange.close();
		}
	}

	private static void send(HttpExchange exchange, int status, Object body) throws IOException {
		byte[] bytes = Json.write(body).getBytes(StandardCharsets.UTF_8);
		exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
		exchange.sendResponseHeaders(status, bytes.length);
		try (OutputStream out = exchange.getResponseBody()) {
			out.write(bytes);
		}
	}
}
