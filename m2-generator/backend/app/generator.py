"""Generation with a trained model, recording every edit operation the network applies.

M2 grows a model from a single root object by repeatedly letting the network pick an *addition edit operation* (e.g. "Add State")
and the existing nodes it applies to (``sample_graph``). ``Pallete.apply_edit`` renumbers all nodes after every step, so to be able
to tell which nodes and edges each step added, the graph is sampled through a copy of the pallete that tags nodes with a stable
``uid`` and records what each successful edit added. M2's own code is used as is.
"""
import copy
import json
import os
import random
import tempfile
import threading
import time
from collections import Counter
from types import SimpleNamespace

import networkx as nx
import numpy as np
import torch
from networkx.algorithms.isomorphism import is_isomorphic
from pyecore.ecore import EClass, EReference
from pyecore.resources import ResourceSet, URI

from . import registry
from .datasets import DATASETS, load_training_graphs

_lock = threading.Lock()  # sampling uses the global random generators
_models = {}
_training_graphs = {}
_refs = {}


class _Recording:
    """Mixin applied to a copy of the pallete: see the module docstring."""

    def apply_edit(self, G, idd):
        before = {n: G.nodes[n]['uid'] for n in G}
        before_edges = Counter((before[u], before[v], d['type']) for u, v, d in G.edges(data=True))
        result = super().apply_edit(G, idd)
        if result is None:
            self.failed += 1
            return None
        new_nodes = []
        for n in result:
            if 'uid' not in result.nodes[n]:
                result.nodes[n]['uid'] = self.next_uid
                new_nodes.append(self.next_uid)
                self.next_uid += 1
        after = {n: result.nodes[n]['uid'] for n in result}
        after_edges = Counter((after[u], after[v], d['type']) for u, v, d in result.edges(data=True))
        self.steps.append(dict(op=self.edit_operations[idd].name, nodes=new_nodes,
                               edges=list((after_edges - before_edges).elements())))
        return result


def _recorder(pallete):
    from m2_generator.edit_operation.pallete import Pallete
    cls = type('RecordingPallete', (_Recording, Pallete), {})
    recorder = copy.copy(pallete)
    recorder.__class__ = cls
    recorder.steps, recorder.failed, recorder.next_uid = [], 0, 1
    return recorder


def _load(model_id):
    if model_id in _models:
        return _models[model_id]
    import main as m2main
    from m2_generator.neural_model.generative_model import GenerativeModel
    meta = registry.get(model_id)
    if meta is None or not meta['ready']:
        raise ValueError('El modelo no existe o no está terminado')
    ds = DATASETS[meta['dataset']]
    pallete = m2main.get_pallete(SimpleNamespace(
        metamodel=ds['metamodel'], root_object=ds['root'], complex_edit_operations=bool(meta['complex'])))
    directory = registry.model_dir(model_id)
    with open(os.path.join(directory, 'pallete.json')) as f:
        pallete.from_json(json.load(f))
    checkpoint = torch.load(os.path.join(directory, 'pytorch_model.bin'), map_location=torch.device('cpu'))
    state = checkpoint['model_state_dict']
    net = GenerativeModel(state['emb_nodes.weight'].shape[1], pallete.dic_nodes, pallete.dic_edges, pallete.edit_operations)
    net.load_state_dict(state)
    net.eval()
    _models[model_id] = dict(meta=meta, pallete=pallete, net=net)
    return _models[model_id]


def forget(model_id):
    _models.pop(model_id, None)


def _reference_info(path):
    if path not in _refs:
        info = {}
        root = ResourceSet().get_resource(URI(path)).contents[0]
        for c in root.eClassifiers:
            if isinstance(c, EClass):
                for f in c.eStructuralFeatures:
                    if isinstance(f, EReference):
                        info[f.name] = dict(containment=bool(f.containment), many=bool(f.many),
                                            opposite=f.eOpposite.name if f.eOpposite is not None else None)
        _refs[path] = info
    return _refs[path]


def _displayed_edges(G, refs):
    """The edges worth drawing, as (u, v, type, drawn_source, drawn_target, drawn_name).

    M2 graphs may carry both directions of an opposite pair (Transition.source / Vertex.outgoingTransitions) or only one of them.
    Container references are implied by the containment; of two opposite references the single-valued one is drawn (and if only
    the many-valued side exists, it is drawn reversed with the name of its opposite, so a Vertex.incomingTransitions edge shows as
    Transition.target).
    """
    edges = {(u, v, d['type']) for u, v, d in G.edges(data=True)}
    shown = []
    for u, v, t in sorted(edges, key=lambda e: (G.nodes[e[0]]['uid'], G.nodes[e[1]]['uid'], e[2])):
        ref = refs.get(t)
        opposite = ref['opposite'] if ref else None
        other = refs.get(opposite) if opposite else None
        if ref is None or ref['containment'] or other is None:
            shown.append((u, v, t, u, v, t))
            continue
        if (v, u, opposite) in edges:
            if other['containment']:
                continue  # container reference: implied by the containment
            if ref['many'] and not other['many']:
                continue  # the single-valued side is drawn
            if ref['many'] == other['many'] and t > opposite:
                continue  # both sides alike: draw one
            shown.append((u, v, t, u, v, t))
        elif ref['many'] and not other['many'] and not other['containment']:
            shown.append((u, v, t, v, u, opposite))
        else:
            shown.append((u, v, t, u, v, t))
    return shown


def _constraints(kind, G):
    """Which of the domain constraints M2 uses to judge consistency are violated (all return True when violated)."""
    if kind == 'yakindu':
        from constraints import yakindu as c
        checks = [
            ('no_entry_region', 'Todas las regiones tienen estado inicial', c.no_entry_region),
            ('multiple_entry_region', 'Ninguna región tiene varios estados iniciales', c.multiple_entry_region),
            ('incoming_to_entry', 'Ninguna transición llega a un estado inicial', c.incoming_to_entry),
            ('no_state_region', 'Todas las regiones tienen algún estado', c.no_state_region),
            ('choice', 'Los Choice tienen transiciones de entrada y de salida', c.choice),
            ('exit_final', 'Los estados Exit/Final no tienen transiciones de salida', c.exit_final),
            ('entry_out_tran', 'Cada estado inicial tiene exactamente una transición de salida', c.entry_out_tran),
            ('meta_model_constraint', 'Cada transición tiene su origen y su destino', c.meta_model_constraint),
        ]
    elif kind == 'ecore':
        from constraints import ecore as c
        checks = [
            ('has_cycles', 'Sin ciclos de herencia', c.has_cycles),
            ('reference_does_not_have_type', 'Las referencias tienen tipo (una clase)', c.reference_does_not_have_type),
            ('attribute_does_not_have_type', 'Los atributos tienen tipo (un tipo de dato)', c.attribute_does_not_have_type),
            ('oposite_of_itself', 'Ninguna referencia es opuesta de sí misma', c.oposite_of_itself),
            ('restriction_opposite', 'Las opuestas lo son en los dos sentidos', c.restriction_opposite),
            ('restriction_same_classes', 'Las opuestas conectan las mismas clases', c.restriction_same_classes),
        ]
    else:
        return None
    return [dict(id=i, label=label, ok=not bool(fn(G))) for i, label, fn in checks]


def _training_set(dataset_id, pallete):
    if dataset_id not in _training_graphs:
        _training_graphs[dataset_id] = load_training_graphs(dataset_id, pallete)[0]
    return _training_graphs[dataset_id]


def _is_novel(G, dataset_id, pallete):
    from m2_generator.edit_operation.pallete import node_match, edge_match
    plain = nx.MultiDiGraph()
    plain.add_nodes_from((n, {'type': d['type']}) for n, d in G.nodes(data=True))
    plain.add_edges_from((u, v, {'type': d['type']}) for u, v, d in G.edges(data=True))
    for g in _training_set(dataset_id, pallete):
        if len(g) == len(plain) and g.number_of_edges() == plain.number_of_edges() and \
                is_isomorphic(plain, g, node_match, edge_match):
            return False
    return True


def generate(model_id, max_size, seed):
    from m2_generator.neural_model.generative_model import sample_graph
    from m2_generator.model2graph.model2graph import serialize_graph_model
    with _lock:
        loaded = _load(model_id)
        pallete, net, meta = loaded['pallete'], loaded['net'], loaded['meta']
        ds = DATASETS[meta['dataset']]

        random.seed(seed)
        np.random.seed(seed)
        torch.manual_seed(seed)

        recorder = _recorder(pallete)
        start = nx.MultiDiGraph(pallete.initial_graphs[0])
        for n in start:
            start.nodes[n]['uid'] = 0
        started = time.time()
        with torch.no_grad():
            G = sample_graph(start, recorder, net, max_size)
        elapsed = time.time() - started

        # node ids as the graph shows them, and the step that created each node/edge
        uid_step = {0: 0}
        for i, step in enumerate(recorder.steps, 1):
            for uid in step['nodes']:
                uid_step[uid] = i
        refs = _reference_info(ds['metamodel'])
        nodes = [dict(id=f"n{d['uid']}", type=d['type'], abstract=False, name=None, external=False, implicit=False,
                      attributes=[], rule=d['type'], app=None, step=uid_step[d['uid']])
                 for _, d in sorted(G.nodes(data=True), key=lambda x: x[1]['uid'])]
        uid_of = {n: G.nodes[n]['uid'] for n in G}
        shown = _displayed_edges(G, refs)
        edge_step = {}
        for i, step in enumerate(recorder.steps, 1):
            for key in step['edges']:
                edge_step.setdefault(key, i)
        edges, edge_ids = [], {}
        for u, v, t, ds_, dt_, name in shown:
            key = (uid_of[u], uid_of[v], t)
            edge_ids[key] = f'e{len(edges)}'
            info = refs.get(name)
            edges.append(dict(id=edge_ids[key], source=f'n{uid_of[ds_]}', target=f'n{uid_of[dt_]}', name=name,
                              kind='containment' if info and info['containment'] else 'reference',
                              step=edge_step.get(key, 0)))
        steps = [dict(index=0, op='Objeto raíz', nodes=['n0'], edges=[])]
        for i, step in enumerate(recorder.steps, 1):
            steps.append(dict(index=i, op=step['op'], nodes=[f'n{u}' for u in step['nodes']],
                              edges=[edge_ids[k] for k in step['edges'] if k in edge_ids]))

        by_type = Counter(n['type'] for n in nodes)
        constraints = _constraints(ds['constraints'], G)
        novel = None
        try:
            novel = _is_novel(G, meta['dataset'], pallete)
        except Exception:  # noqa: BLE001 - the training set may not be readable; the rest still works
            pass

        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, 'model.xmi')
            xmi = None
            try:
                serialize_graph_model(path, [ds['metamodel']], ds['root'], G)
                with open(path) as f:
                    xmi = f.read()
            except Exception:  # noqa: BLE001
                pass

        if len(G) >= max_size:
            stop = 'size'
        elif recorder.failed >= 100:
            stop = 'stuck'
        else:
            stop = 'finished'
        return dict(
            ok=True, seed=seed, max_size=max_size, stop=stop,
            graph=dict(root='n0', nodes=nodes, edges=edges, stats=dict(
                objects=len(nodes), external=0, edges=len(edges),
                containments=sum(1 for e in edges if e['kind'] == 'containment'), byType=dict(by_type))),
            steps=steps, failed_attempts=recorder.failed,
            consistency=None if constraints is None else dict(
                consistent=all(c['ok'] for c in constraints), checks=constraints),
            novel=novel, xmi=xmi, dataset=meta['dataset'], model=dict(id=model_id, name=meta['name']),
            millis=round(elapsed * 1000))
