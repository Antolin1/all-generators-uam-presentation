import os

# The M2 code (unmodified clone of Antolin1/M2), which the image ships under /opt/M2
M2_DIR = os.environ.get('M2_DIR', '/opt/M2')
# M2-experiments/data: the datasets (train/test) and the meta-models they conform to
DATA_DIR = os.environ.get('DATA_DIR', '/data')
# Models trained here (read-write, persisted on the host)
MODELS_DIR = os.environ.get('MODELS_DIR', '/models')
# Models that ship with M2 (M2/models), read-only
PRETRAINED_DIR = os.environ.get('PRETRAINED_DIR', '/pretrained')
