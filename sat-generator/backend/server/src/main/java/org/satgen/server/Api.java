package org.satgen.server;

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

	private final Metamodels metamodels;
	private final Runner runner;
	private volatile boolean ready;

	Api(Metamodels metamodels) {
		this.metamodels = metamodels;
		this.runner = new Runner(metamodels);
	}

	/** The first request loads USE, EMF and SAT4J; do it before the first user request. */
	void warmUp() {
		try {
			for (String file : metamodels.files()) {
				try {
					metamodels.load(file);
					break;
				} catch (Exception e) {
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
		String metamodel = body == null ? null : String.valueOf(body.get("metamodel"));
		try {
			return runner.generate(metamodel, body);
		} catch (Runner.Failure e) {
			return Json.obj("ok", false, "phase", e.phase, "error", e.getMessage());
		} catch (RuntimeException e) {
			return Json.obj("ok", false, "phase", "server", "error", describe(e));
		}
	}

	// --- plumbing ---

	private interface Endpoint {
		Object call(Map<String, Object> request) throws Exception;
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
			send(exchange, 500, Json.obj("ok", false, "phase", "server", "error", describe(t)));
		} finally {
			exchange.close();
		}
	}

	private static String describe(Throwable t) {
		StringBuilder message = new StringBuilder(t.toString());
		int shown = 0;
		for (StackTraceElement frame : t.getStackTrace()) if (shown++ < 4) message.append("\n  en ").append(frame);
		return message.toString();
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
