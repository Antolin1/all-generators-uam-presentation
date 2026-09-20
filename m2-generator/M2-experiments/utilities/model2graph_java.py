import subprocess

import pygraphviz
from networkx.drawing import nx_agraph

from utilities.graph_utils import fix_dot_graph


def model2graph_java(model_type, pathmodel, real_syn, jar_path):
    x = subprocess.Popen(["java", "-jar",
                          jar_path, model_type,
                          pathmodel, real_syn],
                         stderr=subprocess.PIPE,
                         stdout=subprocess.PIPE,
                         text=True)
    out, err = x.communicate()
    G = nx_agraph.from_agraph(pygraphviz.AGraph(out))
    G = fix_dot_graph(G)
    return G