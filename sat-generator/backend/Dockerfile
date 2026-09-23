# syntax=docker/dockerfile:1
#
# Contexto de build: la raíz de este proyecto (sat-generator/), porque hace falta el clon use/ además de backend/.
#
# Maven compila en dos pasos: use-core (el motor de USE, sin modificar, tal cual se clonó) y el servidor HTTP,
# que depende de él (además de EMF, para el .ecore, y SAT4J, el resolutor SAT).

FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /build
COPY use use
RUN --mount=type=cache,target=/root/.m2 \
    cd use && mvn -q -B -pl use-core -am install -DskipTests
COPY backend backend
WORKDIR /build/backend
RUN --mount=type=cache,target=/root/.m2 \
    mvn -B -q -DskipTests install \
 && mkdir /out && cp -r server/target/classes server/target/lib /out/

FROM eclipse-temurin:21-jre
RUN useradd --system --create-home --home-dir /app satgen
WORKDIR /app
COPY --from=build /out/ /app/
USER satgen

ENV PORT=8081 \
    METAMODELS_DIR=/metamodels \
    JAVA_OPTS="-Xmx1g"
EXPOSE 8081
HEALTHCHECK --interval=5s --timeout=3s --start-period=15s --retries=30 \
  CMD curl -fs http://localhost:8081/api/health | grep -q '"ready":true' || exit 1

CMD ["sh", "-c", "exec java $JAVA_OPTS -cp 'classes:lib/*' org.satgen.server.Main"]
