"""The datasets of M2-experiments and how M2 has to read them.

M2's own ``main.py`` loads every dataset with the single meta-model given by ``--metamodel``; that only works for models
that already conform to it. The real-world datasets conform to bigger meta-models (Yakindu's ``sgraph``, the GenMyModel
RDS meta-model, Ecore itself), so here each dataset says which meta-models to register when *reading* the models, while
the *simplified* meta-model (the one M2 generates for) is the one the neural network works on: models are read with the
full meta-model and then ``Pallete.remove_out_of_scope`` drops what the simplified one does not know.
"""
import glob
import logging
import os
from collections import OrderedDict

from .config import DATA_DIR, M2_DIR

logger = logging.getLogger(__name__)

_M2_DATA = os.path.join(M2_DIR, 'data')
_MM = os.path.join(DATA_DIR, 'metamodels')

DATASETS = OrderedDict([
    ('yakindu-exercise', dict(
        label='Yakindu · ejercicio',
        description='Máquinas de estados Yakindu simplificadas, de un ejercicio de modelado (~100 elementos por modelo).',
        metamodel=os.path.join(_M2_DATA, 'yakindu_simplified.ecore'),
        read_metamodels=[os.path.join(_M2_DATA, 'yakindu_simplified.ecore')],
        root='Statechart', complex=True, constraints='yakindu', pretrained='yakindu_exercise')),
    ('yakindu-github', dict(
        label='Yakindu · GitHub',
        description='Máquinas de estados Yakindu reales (.sct) recogidas de GitHub, reducidas al metamodelo simplificado.',
        metamodel=os.path.join(_M2_DATA, 'yakindu_simplified.ecore'),
        read_metamodels=[os.path.join(_MM, 'yakinduComplete', n + '.ecore')
                         for n in ('base', 'types', 'Expressions', 'sgraph', 'SText', 'sexec', 'sgen', 'sexec_trace')],
        root='Statechart', complex=True, constraints='yakindu', pretrained=None)),
    ('ecore-github', dict(
        label='Ecore · GitHub',
        description='Metamodelos Ecore reales de GitHub, reducidos a un Ecore simplificado (paquetes, clases, atributos, referencias).',
        metamodel=os.path.join(_M2_DATA, 'ecore_simplified.ecore'),
        read_metamodels=[],
        root='EPackage', complex=True, constraints='ecore', pretrained='ecore_github')),
    ('rds-genmymodel', dict(
        label='Bases de datos (GenMyModel)',
        description='Esquemas relacionales (tablas, columnas, claves, índices) de GenMyModel, reducidos a un metamodelo simplificado.',
        metamodel=os.path.join(_MM, 'rdsSimplified.ecore'),
        read_metamodels=[os.path.join(_MM, 'rds_manual.ecore')],
        root='Database', complex=False, constraints=None, pretrained=None)),
])


def train_dir(dataset_id):
    return os.path.join(DATA_DIR, dataset_id, 'train')


def describe():
    result = []
    for dataset_id, d in DATASETS.items():
        available = os.path.isdir(train_dir(dataset_id))
        count = lambda sub: len(os.listdir(os.path.join(DATA_DIR, dataset_id, sub))) if available else 0
        result.append(dict(
            id=dataset_id, label=d['label'], description=d['description'], available=available,
            train=count('train'), test=count('test'), root=d['root'],
            metamodel=os.path.basename(d['metamodel']), complex=d['complex'],
            constraints=d['constraints'] is not None, pretrained=d['pretrained']))
    return result


def load_training_graphs(dataset_id, pallete, log=None):
    """Reads the training models of a dataset as graphs restricted to what the pallete knows.

    Returns (graphs, skipped): some real-world models cannot be read by pyecore and are left out.
    """
    from m2_generator.model2graph.model2graph import get_graph_from_model
    d = DATASETS[dataset_id]
    graphs, skipped = [], 0
    for path in sorted(glob.glob(os.path.join(train_dir(dataset_id), '*'))):
        try:
            # M2 only uses node types and references; the attribute values of real-world models are not needed
            # (and some are pyecore objects that cannot be sent to the Monte Carlo worker processes)
            graphs.append(pallete.remove_out_of_scope(get_graph_from_model(path, d['read_metamodels'], consider_atts=False)))
        except Exception as error:  # noqa: BLE001 - pyecore raises assorted errors on malformed models
            skipped += 1
            (log or logger.warning)(f'Omitido {os.path.basename(path)}: {type(error).__name__}')
    return graphs, skipped
