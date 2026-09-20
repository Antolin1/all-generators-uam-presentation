import glob
import os.path
from argparse import ArgumentParser

from utilities.model2graph_java import model2graph_java

BASELINES = ['viatra', 'randomEMF', 'randomInstantiator']


def main(args):
    pass


def get_graphs_test(args):
    files = glob.glob(args.path_test_set + "/*")
    if args.backend == 'java':
        model2graph_java


if __name__ == '__main__':
    parser = ArgumentParser(description='Script for evaluating the generators')
    parser.add_argument('--dataset', default='yakindu-exercise', choices=['ecore-github', 'rds-genmymodel',
                                                                          'yakindu-github', 'yakindu-exercise'],
                        help='Dataset considered')
    parser.add_argument('--n_samples', default=500, type=int, help='Number of syn models')
    parser.add_argument('--max_size', help='Maximum size of the generated models (for M2)', type=int, default=150)
    parser.add_argument('--backend', help='Where to generate the graphs', choices=['emf', 'python'], default='python')
    parser.add_argument('--jar_path', default='model2graph_jar/model2graph.jar')
    args = parser.parse_args()

    args.path_test_set = os.path.join('data', args.dataset, 'test')
    args.path_train_set = os.path.join('data', args.dataset, 'train')

    main(args)
