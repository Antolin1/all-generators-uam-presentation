# syntax=docker/dockerfile:1
#
# Contexto de build: la raíz de este proyecto (atlanmod-instantiator/), porque hace falta el clon
# mondo-atlzoo-benchmark/ además de backend/.
#
# Maven compila en dos módulos: el código original del instantiator (sin modificar, Latin-1) y el servidor HTTP.

FROM maven:3.9-eclipse-temurin-17 AS build
WORKDIR /build
COPY mondo-atlzoo-benchmark/fr.inria.atlanmod.instantiator/src mondo-atlzoo-benchmark/fr.inria.atlanmod.instantiator/src
COPY backend backend
WORKDIR /build/backend
RUN --mount=type=cache,target=/root/.m2 \
    mvn -B -q -DskipTests install \
 && mkdir /out && cp -r server/target/classes server/target/lib /out/

# No hace falta JDK: aquí no se compila nada en tiempo de ejecución (el instantiator trabaja sobre el metamodelo como datos)
FROM eclipse-temurin:17-jre
RUN useradd --system --create-home --home-dir /app instantiator
WORKDIR /app
COPY --from=build /out/ /app/
USER instantiator

ENV PORT=8081 \
    METAMODELS_DIR=/metamodels \
    JAVA_OPTS="-Xmx1g"
EXPOSE 8081
HEALTHCHECK --interval=5s --timeout=3s --start-period=15s --retries=30 \
  CMD curl -fs http://localhost:8081/api/health | grep -q '"ready":true' || exit 1

CMD ["sh", "-c", "exec java $JAVA_OPTS -cp 'classes:lib/*' de.hub.instantiator.server.Main"]
