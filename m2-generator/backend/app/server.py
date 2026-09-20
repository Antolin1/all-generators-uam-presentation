import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from . import datasets, generator, registry
from .trainer import DEFAULTS, LIMITS, Trainer

MAX_BODY = 1 << 20
MAX_SIZE = 500
state = {'ready': False, 'device': None, 'gpu': None}
trainer = None


def _device():
    import torch
    cuda = torch.cuda.is_available()
    return ('cuda' if cuda else 'cpu'), (torch.cuda.get_device_name(0) if cuda else None)


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        sys.stdout.write('%s %s\n' % (self.command, self.path))

    def _send(self, status, body):
        data = json.dumps(body).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        length = int(self.headers.get('Content-Length') or 0)
        if length > MAX_BODY:
            raise ValueError('Petición demasiado grande')
        raw = self.rfile.read(length) if length else b'{}'
        value = json.loads(raw or b'{}')
        if not isinstance(value, dict):
            raise ValueError('Se esperaba un objeto JSON')
        return value

    def do_GET(self):
        self._route('GET')

    def do_POST(self):
        self._route('POST')

    def _route(self, method):
        path = urlparse(self.path).path
        try:
            handler = ROUTES.get((method, path))
            if handler is None:
                self._send(404, dict(ok=False, error='No encontrado'))
                return
            body = self._body() if method == 'POST' else {}
            self._send(200, handler(body))
        except (ValueError, RuntimeError) as error:
            self._send(400 if isinstance(error, ValueError) else 409, dict(ok=False, error=str(error)))
        except Exception as error:  # noqa: BLE001
            import traceback
            traceback.print_exc()
            self._send(500, dict(ok=False, error=f'{type(error).__name__}: {error}'))


def health(_):
    return dict(ok=True, ready=state['ready'], device=state['device'], gpu=state['gpu'])


def list_datasets(_):
    return dict(datasets=datasets.describe(), defaults=DEFAULTS, limits=LIMITS)


def list_models(_):
    return dict(models=registry.list_models())


def delete_model(body):
    model_id = str(body.get('id', ''))
    job = trainer.status()
    if job and job['id'] == model_id and trainer.running():
        raise RuntimeError('Ese modelo se está entrenando: cancélalo antes de borrarlo')
    registry.delete(model_id)
    generator.forget(model_id)
    return dict(ok=True)


def train(body):
    job = trainer.start(body)
    return dict(ok=True, id=job['id'])


def train_status(_):
    return dict(job=trainer.status())


def train_cancel(_):
    return dict(ok=trainer.cancel())


def generate(body):
    model_id = str(body.get('model', ''))
    size = int(body.get('max_size', 30))
    if not 2 <= size <= MAX_SIZE:
        raise ValueError(f'El tamaño máximo debe estar entre 2 y {MAX_SIZE}')
    seed = int(body['seed']) if body.get('seed') is not None else int.from_bytes(os.urandom(3), 'big')
    return generator.generate(model_id, size, seed)


ROUTES = {
    ('GET', '/api/health'): health,
    ('GET', '/api/datasets'): list_datasets,
    ('GET', '/api/models'): list_models,
    ('POST', '/api/models/delete'): delete_model,
    ('POST', '/api/train'): train,
    ('GET', '/api/train'): train_status,
    ('POST', '/api/train/cancel'): train_cancel,
    ('POST', '/api/generate'): generate,
}


def warm_up():
    """Import torch and M2 (a few seconds) and generate once, so the first user request is not the slow one."""
    try:
        state['device'], state['gpu'] = _device()
        for model in registry.list_models():
            if model['ready']:
                generator.generate(model['id'], 10, 0)
                break
    except Exception as error:  # noqa: BLE001
        print('Warm-up falló (el servidor sigue disponible):', error, flush=True)
    finally:
        state['ready'] = True
        print('M2 server listo', flush=True)


def main():
    global trainer
    import torch
    torch.set_num_threads(4)
    trainer = Trainer()
    port = int(os.environ.get('PORT', '8081'))
    server = ThreadingHTTPServer(('0.0.0.0', port), Handler)
    print(f'M2 server escuchando en :{port} (calentando…)', flush=True)
    threading.Thread(target=warm_up, daemon=True).start()
    server.serve_forever()


if __name__ == '__main__':
    main()
