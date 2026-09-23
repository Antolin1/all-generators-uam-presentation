# syntax=docker/dockerfile:1
#
# Contexto de build: la raíz de este proyecto (m2-generator/), porque hace falta el clon M2/ además de backend/.
# M2-experiments/ (los datasets) NO se copia a la imagen: se monta como volumen.
#
# Es el entorno que pide M2: Python 3.8, PyTorch 1.11 con CUDA 11.3 (cu102 no trae kernels sm_86,
# necesarios para GPUs Ampere como la RTX 3050), PyG 2.0.4.
#
# Base nvidia/cuda (no python:3.8-slim): las wheels de torch-sparse/torch-scatter no llevan
# libcusparse/libcublas/libcudnn consigo (a diferencia del propio paquete torch, que sí embebe
# libcudart), así que hacen falta las librerías de runtime de CUDA/cuDNN instaladas en la imagen.

FROM nvidia/cuda:11.3.1-cudnn8-runtime-ubuntu20.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3.8 python3-pip python3.8-dev \
      build-essential graphviz libgraphviz-dev pkg-config curl \
 && rm -rf /var/lib/apt/lists/* \
 && ln -sf /usr/bin/python3.8 /usr/bin/python
RUN pip install --no-cache-dir torch==1.11.0+cu113 -f https://download.pytorch.org/whl/torch_stable.html
RUN pip install --no-cache-dir torch-scatter==2.0.9 torch-sparse==0.6.13 torch-cluster==1.6.0 torch-spline-conv==1.2.1 -f https://data.pyg.org/whl/torch-1.11.0+cu113.html \
 && pip install --no-cache-dir torch-geometric==2.0.4
COPY M2/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

# El código de M2, sin modificar
COPY M2 /opt/M2
# La aplicación
COPY backend/app /app/m2app

RUN useradd --uid 1000 --create-home m2 && mkdir -p /models && chown m2 /models
USER m2
WORKDIR /opt/M2

ENV PYTHONPATH=/opt/M2:/app \
    M2_DIR=/opt/M2 \
    DATA_DIR=/data \
    MODELS_DIR=/models \
    PRETRAINED_DIR=/pretrained \
    PORT=8081
EXPOSE 8081
HEALTHCHECK --interval=5s --timeout=3s --start-period=40s --retries=60 \
  CMD curl -fs http://localhost:8081/api/health | grep -q '"ready": true' || exit 1

CMD ["python", "-u", "-m", "m2app.server"]
