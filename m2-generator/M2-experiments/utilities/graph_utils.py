import networkx as nx


def fix_dot_graph(G):
    G_new = nx.MultiDiGraph(G)
    for n in G_new:
        G_new.nodes[n]['type'] = G_new.nodes[n]['label']
        del G_new.nodes[n]['label']
    for e in list(G_new.edges(keys=True)):
        label = G_new[e[0]][e[1]][e[2]]['label']
        G_new.remove_edge(e[0], e[1], e[2])
        G_new.add_edge(e[0], e[1], e[2], type=label)
    new_map = {}
    j = 0
    for n in G_new:
        new_map[n] = j
        j = j + 1
    G_new = nx.relabel_nodes(G_new, new_map)
    return G_new
