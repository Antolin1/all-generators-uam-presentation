"""The models that can generate: those shipped with M2 (read-only) and those trained here."""
import json
import os
import re
import shutil
import threading
import time

from .config import MODELS_DIR, PRETRAINED_DIR
from .datasets import DATASETS

_lock = threading.Lock()
PRETRAINED_PREFIX = 'pretrained:'


def _read(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def slugify(name):
    slug = re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')
    return slug[:40] or 'modelo'


def model_dir(model_id):
    if model_id.startswith(PRETRAINED_PREFIX):
        return os.path.join(PRETRAINED_DIR, model_id[len(PRETRAINED_PREFIX):])
    return os.path.join(MODELS_DIR, model_id)


def is_ready(model_id):
    d = model_dir(model_id)
    return os.path.isfile(os.path.join(d, 'pytorch_model.bin')) and os.path.isfile(os.path.join(d, 'pallete.json'))


def _pretrained():
    models = []
    for dataset_id, d in DATASETS.items():
        name = d['pretrained']
        if not name:
            continue
        path = os.path.join(PRETRAINED_DIR, name)
        pallete = _read(os.path.join(path, 'pallete.json'))
        if pallete is None or not os.path.isfile(os.path.join(path, 'pytorch_model.bin')):
            continue
        models.append(dict(
            id=PRETRAINED_PREFIX + name, name='M2 preentrenado', source='pretrained', dataset=dataset_id,
            status='done', ready=True, complex=bool(pallete.get('complex_edit_operations')),
            params={}, losses=[], created=None, seconds=None))
    return models


def list_models():
    models = _pretrained()
    if os.path.isdir(MODELS_DIR):
        for entry in sorted(os.listdir(MODELS_DIR)):
            meta = _read(os.path.join(MODELS_DIR, entry, 'meta.json'))
            if not meta:
                continue
            meta['id'] = entry
            meta['source'] = 'trained'
            meta['ready'] = meta.get('status') == 'done' and is_ready(entry)
            models.append(meta)
    return models


def get(model_id):
    for model in list_models():
        if model['id'] == model_id:
            return model
    return None


def write_meta(model_id, meta):
    path = os.path.join(model_dir(model_id), 'meta.json')
    tmp = path + '.tmp'
    with _lock:
        with open(tmp, 'w') as f:
            json.dump(meta, f, indent=1)
        os.replace(tmp, path)


def new_model_dir(name):
    """Creates a fresh directory for a model, with a unique id derived from its name."""
    os.makedirs(MODELS_DIR, exist_ok=True)
    base = slugify(name)
    candidate, n = base, 2
    with _lock:
        while os.path.exists(os.path.join(MODELS_DIR, candidate)):
            candidate = f'{base}-{n}'
            n += 1
        os.makedirs(os.path.join(MODELS_DIR, candidate))
    return candidate


def delete(model_id):
    if model_id.startswith(PRETRAINED_PREFIX) or '/' in model_id or model_id in ('', '.', '..'):
        raise ValueError('Solo se pueden borrar los modelos entrenados aquí')
    path = os.path.join(MODELS_DIR, model_id)
    if not os.path.isdir(path):
        raise ValueError('El modelo no existe')
    shutil.rmtree(path)


def now():
    return time.time()
