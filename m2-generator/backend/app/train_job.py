"""Training driver, run as a subprocess by the server: ``python -m m2app.train_job spec.json``.

It reuses M2's own code (``get_pallete`` from ``main.py`` and ``train_generator``) and only adds what ``main.py`` cannot do:
read datasets that need other meta-models than the simplified one, skip unreadable models, and report progress. Progress goes to
stdout as ``@@{json}`` lines, which the server parses; everything else is plain log output.
"""
import json
import logging
import os
import re
import sys
import time
from types import SimpleNamespace


def emit(**event):
    print('@@' + json.dumps(event), flush=True)


def main(spec_path):
    with open(spec_path) as f:
        spec = json.load(f)

    import torch
    import main as m2main  # M2/main.py (a script guarded by __main__, so importable)
    from m2_generator.neural_model import training_generation_evaluation as tge
    from m2app import datasets

    ds = datasets.DATASETS[spec['dataset']]
    p = spec['params']
    args = SimpleNamespace(
        metamodel=ds['metamodel'], root_object=ds['root'], complex_edit_operations=bool(p['complex']),
        hidden_dim=p['hidden_dim'], k=p['k'], epochs=p['epochs'], lr=p['lr'], batch_size=p['batch_size'],
        patience=p['patience'], pool=p['pool'], model_path=spec['model_path'], seed=p['seed'],
        device='cuda' if torch.cuda.is_available() else 'cpu')
    m2main.seed_everything(args.seed)
    emit(event='device', device=args.device, name=torch.cuda.get_device_name(0) if args.device == 'cuda' else 'cpu')

    # progress of the Monte Carlo decomposition: M2 iterates ``tqdm(range(k))``
    def progress_tqdm(iterable, desc=None, **_):
        total = len(iterable)
        emit(event='mc', done=0, k=total)
        for i, item in enumerate(iterable):
            yield item
            emit(event='mc', done=i + 1, k=total)
    tge.tqdm = progress_tqdm

    class EpochHandler(logging.Handler):
        def emit(self, record):
            match = re.match(r'Epoch (\d+), Loss = ([0-9.eE+-]+)', record.getMessage())
            if match:
                emit(event='epoch', epoch=int(match.group(1)) + 1, epochs=args.epochs, loss=float(match.group(2)))
    logging.getLogger().setLevel(logging.INFO)
    logging.getLogger().addHandler(EpochHandler())

    pallete = m2main.get_pallete(args)
    emit(event='phase', phase='loading')
    graphs, skipped = datasets.load_training_graphs(spec['dataset'], pallete, log=lambda m: print(m, flush=True))
    if not graphs:
        raise RuntimeError('No se pudo leer ningún modelo del dataset')
    emit(event='loaded', graphs=len(graphs), skipped=skipped,
         nodes=sum(len(g) for g in graphs) // len(graphs))
    emit(event='phase', phase='decomposition')
    started = time.time()
    tge.train_generator(graphs, pallete, args)
    emit(event='done', seconds=round(time.time() - started, 1))


if __name__ == '__main__':
    try:
        main(sys.argv[1])
    except Exception as error:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        emit(event='error', message=f'{type(error).__name__}: {error}')
        sys.exit(1)
