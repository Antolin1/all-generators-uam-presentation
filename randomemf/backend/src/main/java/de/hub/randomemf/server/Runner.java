package de.hub.randomemf.server;

import java.lang.reflect.Constructor;
import java.lang.reflect.InvocationTargetException;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicReference;

import org.eclipse.emf.ecore.EObject;

import de.hub.randomemf.runtime.IGenerator;
import de.hub.randomemf.runtime.Random;
import de.hub.randomemf.runtime.Trace;

/** Executes a compiled generator once and records the rules it applies. */
final class Runner {

	static final class Result {
		final EObject model;
		final TraceRecorder trace;

		Result(EObject model, TraceRecorder trace) {
			this.model = model;
			this.trace = trace;
		}
	}

	static final class RunFailed extends Exception {
		private static final long serialVersionUID = 1L;

		RunFailed(String message) {
			super(message);
		}
	}

	private final ExecutorService pool = Executors.newCachedThreadPool(new ThreadFactory() {
		@Override
		public Thread newThread(Runnable runnable) {
			Thread thread = new Thread(runnable, "rcore-run");
			thread.setDaemon(true);
			return thread;
		}
	});

	/**
	 * RandomEMF keeps its random sources and the trace hook in static state, so runs are strictly one at a time.
	 */
	@SuppressWarnings("deprecation")
	synchronized Result run(final Class<?> generatorType, final List<Object> paramSpec, final Map<String, Object> args,
			final int seed, final int maxObjects, long timeoutMillis) throws RunFailed {
		final AtomicReference<Thread> worker = new AtomicReference<Thread>();
		Future<Result> future = pool.submit(new Callable<Result>() {
			@Override
			public Result call() throws Exception {
				worker.set(Thread.currentThread());
				TraceRecorder recorder = new TraceRecorder();
				Random.setSeed(seed);
				Trace.setListener(recorder);
				try {
					IGenerator generator = (IGenerator) instantiate(generatorType, paramSpec, args);
					EObject model = maxObjects >= 0 ? generator.generate(maxObjects) : generator.generate();
					return new Result(model, recorder);
				} finally {
					Trace.setListener(null);
				}
			}
		});
		try {
			return future.get(timeoutMillis, TimeUnit.MILLISECONDS);
		} catch (TimeoutException e) {
			// a rule that loops forever cannot be interrupted cooperatively
			Thread thread = worker.get();
			if (thread != null) {
				thread.stop();
			}
			throw new RunFailed("La generación superó el límite de " + (timeoutMillis / 1000) + " s y se abortó. Revisa expresiones que no terminan o reglas recursivas sin condición de parada.");
		} catch (InterruptedException e) {
			Thread.currentThread().interrupt();
			throw new RunFailed("Generación interrumpida");
		} catch (ExecutionException e) {
			Throwable cause = e.getCause();
			while (cause instanceof InvocationTargetException && cause.getCause() != null) {
				cause = cause.getCause();
			}
			if (cause instanceof RunFailed) {
				throw (RunFailed) cause;
			}
			throw new RunFailed(describe(cause));
		}
	}

	private static Object instantiate(Class<?> type, List<Object> paramSpec, Map<String, Object> args) throws Exception {
		Constructor<?> constructor = type.getConstructors()[0];
		Class<?>[] types = constructor.getParameterTypes();
		Object[] values = new Object[types.length];
		for (int i = 0; i < types.length; i++) {
			@SuppressWarnings("unchecked")
			String name = (String) ((Map<String, Object>) paramSpec.get(i)).get("name");
			Object raw = args == null ? null : args.get(name);
			if (raw == null || String.valueOf(raw).trim().isEmpty()) {
				throw new RunFailed("Falta el parámetro del generador «" + name + "»");
			}
			values[i] = convert(name, types[i], raw);
		}
		return constructor.newInstance(values);
	}

	private static Object convert(String name, Class<?> type, Object raw) throws RunFailed {
		String text = String.valueOf(raw).trim();
		try {
			if (type == int.class || type == Integer.class) return Integer.valueOf(text);
			if (type == long.class || type == Long.class) return Long.valueOf(text);
			if (type == double.class || type == Double.class) return Double.valueOf(text);
			if (type == float.class || type == Float.class) return Float.valueOf(text);
			if (type == short.class || type == Short.class) return Short.valueOf(text);
			if (type == byte.class || type == Byte.class) return Byte.valueOf(text);
			if (type == boolean.class || type == Boolean.class) return Boolean.valueOf(text);
			if (type == String.class) return String.valueOf(raw);
		} catch (NumberFormatException e) {
			throw new RunFailed("El parámetro «" + name + "» debe ser " + type.getSimpleName() + ", no «" + text + "»");
		}
		throw new RunFailed("El parámetro «" + name + "» tiene un tipo (" + type.getName() + ") que la interfaz no sabe rellenar");
	}

	private static String describe(Throwable cause) {
		if (cause instanceof StackOverflowError) {
			return "Recursión sin fin en las reglas (StackOverflowError). Una regla se llama a sí misma sin condición de parada; "
					+ "prueba a limitarla con «depth», p. ej. #(if (depth < 4) 1 else 0). «Máx. objetos» no lo evita: RandomEMF solo "
					+ "cuenta un objeto cuando termina de generarlo.";
		}
		StringBuilder message = new StringBuilder(cause.toString());
		int shown = 0;
		for (StackTraceElement frame : cause.getStackTrace()) {
			if (shown < 4) {
				message.append("\n  en ").append(frame);
				shown++;
			}
		}
		return message.toString();
	}
}
