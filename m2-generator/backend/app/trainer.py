"""Runs at most one training at a time in a subprocess, keeps its progress and lets you cancel it."""
import json
import os
import signal
import subprocess
import sys
import threading
import time

from . import registry
from .config import M2_DIR
from .datasets import DATASETS, train_dir

DEFAULTS = dict(epochs=10, k=3, hidden_dim=64, lr=0.001, batch_size=128, patience=10, seed=123, complex=True)
LIMITS = dict(epochs=(1, 300), k=(1, 30), hidden_dim=(8, 512), batch_size=(8, 2048), patience=(1, 100))


class Trainer:
    def __init__(self):
        self.lock = threading.Lock()
        self.job = None
        self.process = None
        self._recover()

    def _recover(self):
        """A model left 'training' by a previous server run cannot still be running: mark it interrupted."""
        for model in registry.list_models():
            if model['source'] == 'trained' and model.get('status') == 'training':
                model['status'] = 'interrupted'
                model['error'] = 'El servidor se detuvo durante el entrenamiento'
                registry.write_meta(model['id'], {k: v for k, v in model.items() if k not in ('id', 'source', 'ready')})

    # --- public ---

    def status(self):
        with self.lock:
            if self.job is None:
                return None
            job = dict(self.job)
            job['log'] = list(job['log'])[-200:]
            job['losses'] = list(job['losses'])
            job['elapsed'] = round((job['finished'] or time.time()) - job['started'], 1)
            return job

    def running(self):
        return self.process is not None and self.process.poll() is None

    def start(self, request):
        dataset_id = request.get('dataset')
        if dataset_id not in DATASETS:
            raise ValueError('Dataset desconocido')
        dataset = DATASETS[dataset_id]
        name = str(request.get('name') or '').strip()
        if not name or len(name) > 60:
            raise ValueError('Ponle un nombre al modelo (máx. 60 caracteres)')
        params = dict(DEFAULTS)
        for key in ('epochs', 'k', 'hidden_dim', 'batch_size', 'patience', 'seed'):
            if request.get(key) is not None:
                params[key] = int(request[key])
        for key in LIMITS:
            low, high = LIMITS[key]
            if not low <= params[key] <= high:
                raise ValueError(f'«{key}» debe estar entre {low} y {high}')
        if request.get('lr') is not None:
            params['lr'] = float(request['lr'])
            if not 0 < params['lr'] < 1:
                raise ValueError('La tasa de aprendizaje debe estar entre 0 y 1')
        params['complex'] = bool(request.get('complex', True)) and dataset['complex']
        params['pool'] = max(1, min(8, os.cpu_count() or 1))

        with self.lock:
            if self.running():
                raise RuntimeError('Ya hay un entrenamiento en curso: espera a que termine o cancélalo')
            if not os.path.isdir(train_dir(dataset_id)):
                raise ValueError('El dataset no está disponible (¿está montada la carpeta M2-experiments/data?)')
            model_id = registry.new_model_dir(name)
            model_path = registry.model_dir(model_id)
            spec_path = os.path.join(model_path, 'spec.json')
            with open(spec_path, 'w') as f:
                json.dump(dict(dataset=dataset_id, params=params, model_path=model_path), f)
            self.job = dict(
                id=model_id, name=name, dataset=dataset_id, status='running', phase='starting', params=params,
                mc_done=0, k=params['k'], epoch=0, epochs=params['epochs'], losses=[], graphs=None, skipped=None,
                device=None, device_name=None, error=None, started=time.time(), finished=None, log=[])
            self._persist('training')
            env = dict(os.environ, PYTHONPATH=os.pathsep.join([M2_DIR, os.path.dirname(os.path.dirname(__file__))]),
                       PYTHONUNBUFFERED='1')
            self.process = subprocess.Popen(
                [sys.executable, '-u', '-m', 'm2app.train_job', spec_path], cwd=M2_DIR, env=env,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True, bufsize=1,
                start_new_session=True)
            threading.Thread(target=self._pump, args=(self.process,), daemon=True).start()
            return dict(self.job)

    def cancel(self):
        with self.lock:
            process = self.process
            if process is None or process.poll() is not None:
                return False
            self.job['status'] = 'cancelling'
        try:
            os.killpg(os.getpgid(process.pid), signal.SIGTERM)
        except ProcessLookupError:
            return True

        def kill_later():
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(os.getpgid(process.pid), signal.SIGKILL)
                except ProcessLookupError:
                    pass
        threading.Thread(target=kill_later, daemon=True).start()
        return True

    # --- internals ---

    def _persist(self, status):
        job = self.job
        meta = dict(
            name=job['name'], dataset=job['dataset'], status=status, params=job['params'], losses=job['losses'],
            graphs=job['graphs'], skipped=job['skipped'], device=job['device_name'], error=job['error'],
            complex=job['params']['complex'], created=job['started'],
            seconds=round((job['finished'] or time.time()) - job['started'], 1))
        registry.write_meta(job['id'], meta)

    def _pump(self, process):
        model_path = registry.model_dir(self.job['id'])
        with open(os.path.join(model_path, 'train.log'), 'w') as log_file:
            for raw in process.stdout:
                line = raw.rstrip('\n')
                if line.startswith('@@'):
                    try:
                        self._event(json.loads(line[2:]))
                    except ValueError:
                        pass
                    continue
                log_file.write(line + '\n')
                log_file.flush()
                with self.lock:
                    self.job['log'].append(line[:500])
                    if len(self.job['log']) > 1000:
                        del self.job['log'][:500]
        code = process.wait()
        with self.lock:
            job = self.job
            job['finished'] = time.time()
            if job['status'] == 'cancelling':
                job['status'] = 'cancelled'
            elif code == 0 and registry.is_ready(job['id']):
                job['status'] = 'done'
                job['phase'] = 'done'
            else:
                job['status'] = 'failed'
                job['error'] = job['error'] or f'El proceso terminó con código {code}'
            self._persist({'done': 'done', 'cancelled': 'cancelled', 'failed': 'failed'}[job['status']])

    def _event(self, e):
        with self.lock:
            job = self.job
            kind = e.get('event')
            if kind == 'device':
                job['device'], job['device_name'] = e['device'], e['name']
            elif kind == 'phase':
                job['phase'] = e['phase']
            elif kind == 'loaded':
                job['graphs'], job['skipped'] = e['graphs'], e['skipped']
            elif kind == 'mc':
                job['phase'] = 'decomposition' if e['done'] < e['k'] else 'training'
                job['mc_done'], job['k'] = e['done'], e['k']
            elif kind == 'epoch':
                job['phase'] = 'training'
                job['epoch'] = e['epoch']
                job['losses'].append(e['loss'])
                self._persist('training')
            elif kind == 'error':
                job['error'] = e['message']
