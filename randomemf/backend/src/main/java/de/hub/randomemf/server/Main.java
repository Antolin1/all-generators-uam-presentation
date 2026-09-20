package de.hub.randomemf.server;

import java.net.InetSocketAddress;
import java.nio.file.Paths;
import java.util.concurrent.Executors;

import org.apache.log4j.BasicConfigurator;
import org.apache.log4j.Level;
import org.apache.log4j.Logger;

import com.sun.net.httpserver.HttpServer;

public final class Main {

	public static void main(String[] args) throws Exception {
		BasicConfigurator.configure();
		Logger.getRootLogger().setLevel(Level.WARN);

		int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "8081"));
		Metamodels metamodels = new Metamodels(Paths.get(System.getenv().getOrDefault("METAMODELS_DIR", "/metamodels")));
		metamodels.refresh(true);
		Api api = new Api(new RcoreEngine(metamodels), metamodels);

		HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);
		api.register(server);
		server.setExecutor(Executors.newFixedThreadPool(8));
		server.start();
		System.out.println("RandomEMF server escuchando en :" + port + " (calentando…)");

		// the first parse/compile loads Xtext and Xbase, which takes a few seconds: do it before the first user request
		api.warmUp();
		System.out.println("RandomEMF server listo");
	}
}
