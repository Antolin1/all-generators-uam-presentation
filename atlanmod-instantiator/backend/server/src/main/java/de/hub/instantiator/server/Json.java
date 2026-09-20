package de.hub.instantiator.server;

import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;

import com.fasterxml.jackson.databind.ObjectMapper;

final class Json {

	static final ObjectMapper MAPPER = new ObjectMapper();

	private Json() {
	}

	static String write(Object value) {
		try {
			return MAPPER.writeValueAsString(value);
		} catch (IOException e) {
			throw new IllegalStateException(e);
		}
	}

	@SuppressWarnings("unchecked")
	static Map<String, Object> readObject(byte[] body) throws IOException {
		Object value = MAPPER.readValue(body, Object.class);
		if (!(value instanceof Map)) {
			throw new IOException("Se esperaba un objeto JSON");
		}
		return (Map<String, Object>) value;
	}

	/** Small helper to build ordered JSON objects: <code>obj("a", 1, "b", 2)</code>. */
	static Map<String, Object> obj(Object... keyValues) {
		Map<String, Object> map = new LinkedHashMap<String, Object>();
		for (int i = 0; i < keyValues.length; i += 2) {
			map.put((String) keyValues[i], keyValues[i + 1]);
		}
		return map;
	}
}
