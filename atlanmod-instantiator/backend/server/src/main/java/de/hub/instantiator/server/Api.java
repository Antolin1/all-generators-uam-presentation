package de.hub.instantiator.server;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

/** The HTTP API consumed by the web front end. */
final class Api {

	private static final int MAX_BODY = 1 << 20;
	private static final long RUN_TIMEOUT_MILLIS = 60000;

	private final Metamodels metamodels;
	private final Runner runner;
	private volatile boolean ready;

	Api(Metamodels metamodels) {
		this.metamodels = metamodels;
		this.runner = new Runner(metamodels);
	}

	/** The first run loads EMF, Guava and commons-math; do it before the first user request. */
	void warmUp() {
		try {
			for (String file : metamodels.files()) {
				Runner.Request request = new Runner.Request();
				request.metamodel = file;
				request.size = 5;
				request.seed = 0L;
				try {
					runner.run(request, RUN_TIMEOUT_MILLIS);
					break;
				} catch (Runner.Failure e) {
					/* try the next metamodel */
				}
			}
		} catch (Throwable t) {
			System.err.println("Warm-up falló (el servidor sigue disponible): " + t);
		} finally {
			ready = true;
		}
	}

	void register(HttpServer server) {
		server.createContext("/api/health", exchange -> handle(exchange, false, body -> Json.obj("ok", true, "ready", ready)));
		server.createContext("/api/metamodels", exchange -> handle(exchange, false, body -> Json.obj("directory", metamodels.directory().getPath(), "items", metamodels.describe())));
		server.createContext("/api/generate", exchange -> handle(exchange, true, this::generate));
	}

	private Object generate(Map<String, Object> body) {
		Runner.Request request = new Runner.Request();
		request.metamodel = string(body, "metamodel");
		request.size = integer(body, "size", request.size);
		request.degree = integer(body, "degree", request.degree);
		if (body.get("seed") instanceof Number) request.seed = ((Number) body.get("seed")).longValue();
		if (body.get("excluded") instanceof Iterable) {
			for (Object o : (Iterable<?>) body.get("excluded")) request.excluded.add(String.valueOf(o));
		}
		if (body.get("roots") instanceof Iterable) {
			for (Object o : (Iterable<?>) body.get("roots")) request.roots.add(String.valueOf(o));
		}
		try {
			return runner.run(request, RUN_TIMEOUT_MILLIS);
		} catch (Runner.Failure e) {
			return Json.obj("ok", false, "phase", e.phase, "error", e.getMessage());
		}
	}

	// --- plumbing ---

	private interface Endpoint {
		Object call(Map<String, Object> request) throws Exception;
	}

	private static String string(Map<String, Object> request, String key) {
		Object value = request.get(key);
		return value == null ? "" : String.valueOf(value);
	}

	private static int integer(Map<String, Object> request, String key, int fallback) {
		return request.get(key) instanceof Number ? ((Number) request.get(key)).intValue() : fallback;
	}

	private static byte[] readAll(InputStream in, int limit) throws IOException {
		ByteArrayOutputStream out = new ByteArrayOutputStream();
		byte[] buffer = new byte[8192];
		int read;
		while ((read = in.read(buffer)) >= 0) {
			out.write(buffer, 0, read);
			if (out.size() > limit) throw new IOException("Petición demasiado grande");
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
