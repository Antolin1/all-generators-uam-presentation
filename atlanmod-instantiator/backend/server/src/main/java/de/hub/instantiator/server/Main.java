package de.hub.instantiator.server;

import java.io.File;
import java.net.InetSocketAddress;
import java.util.concurrent.Executors;

import com.sun.net.httpserver.HttpServer;

public final class Main {

	public static void main(String[] args) throws Exception {
		int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "8081"));
		Metamodels metamodels = new Metamodels(new File(System.getenv().getOrDefault("METAMODELS_DIR", "/metamodels")));
		Api api = new Api(metamodels);

		HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);
		api.register(server);
		server.setExecutor(Executors.newFixedThreadPool(8));
		server.start();
		System.out.println("Instantiator server escuchando en :" + port + " (calentando…)");

		api.warmUp();
		System.out.println("Instantiator server listo");
	}
}
