from m2_generator.model2graph.metafilter import MetaFilter

references_yakindu = ['Region.vertices',
                      'CompositeElement.regions',
                      'Vertex.outgoingTransitions',
                      'Vertex.incomingTransitions',
                      'Transition.target',
                      'Transition.source']

classes_yakindu = ['Transition',
                   'Region',
                   'Statechart',
                   'State',
                   'FinalState',
                   'Choice',
                   'Entry',
                   'Exit',
                   'Synchronization']

yakindu_metafilter = MetaFilter(references=references_yakindu,
                                attributes=None,
                                classes=classes_yakindu)
