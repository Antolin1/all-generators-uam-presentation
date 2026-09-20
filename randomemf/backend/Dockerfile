# syntax=docker/dockerfile:1
#
# Contexto de build: la raíz de este repositorio (generators/), porque hace falta el clon RandomEMF/ además de backend/.
#
# RandomEMF es un lenguaje Xtext 2.9 de 2015: se construye con JDK 8 y sin Eclipse. Maven hace todo:
#   1. copia RandomEMF/plugins/de.hub.rcore a target/ (el clon no se modifica),
#   2. ejecuta el workflow MWE2 para generar parser, EPackage, serializador... desde Rcore.xtext,
#   3. compila Xtend + Java (RandomEMF y el servidor HTTP de backend/).

FROM maven:3.9-eclipse-temurin-8 AS build
WORKDIR /build
COPY RandomEMF/plugins/de.hub.rcore RandomEMF/plugins/de.hub.rcore
COPY RandomEMF/plugins/de.hub.rcore.example/src/de/hub/rcore/example/RandomEcore.rcore RandomEMF/plugins/de.hub.rcore.example/src/de/hub/rcore/example/RandomEcore.rcore
COPY backend backend
WORKDIR /build/backend
RUN --mount=type=cache,target=/root/.m2 \
    mvn -B -q -DskipTests package \
 && mkdir /out && cp -r target/classes target/lib /out/

# JDK (no JRE): el servidor compila con javac el Java que RandomEMF genera de cada .rcore
FROM eclipse-temurin:8-jdk
RUN useradd --system --create-home --home-dir /app randomemf
WORKDIR /app
COPY --from=build /out/ /app/
USER randomemf

ENV PORT=8081 \
    METAMODELS_DIR=/metamodels \
    JAVA_OPTS="-Xmx1g"
EXPOSE 8081
HEALTHCHECK --interval=5s --timeout=3s --start-period=20s --retries=30 \
  CMD curl -fs http://localhost:8081/api/health | grep -q '"ready":true' || exit 1

CMD ["sh", "-c", "exec java $JAVA_OPTS -cp 'classes:lib/*' de.hub.randomemf.server.Main"]
