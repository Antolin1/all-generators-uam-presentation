package de.hub.instantiator.server;

import java.util.Set;

import org.apache.commons.lang3.Range;
import org.eclipse.emf.ecore.EClass;
import org.eclipse.emf.ecore.resource.Resource;

import com.google.common.collect.ImmutableSet;

import fr.inria.atlanmod.instantiator.GenericMetamodelConfig;

/**
 * The instantiator's default configuration, plus the per-metaclass choices its {@code ISpecimenConfiguration} interface
 * leaves open and that the README describes as "metaclasses that should (not) be involved": classes never instantiated
 * and the classes that may be roots.
 */
final class ConfigurableConfig extends GenericMetamodelConfig {

	private final Set<EClass> excluded;
	private final Set<EClass> roots;

	ConfigurableConfig(Resource metamodel, Range<Integer> elements, long seed, Set<EClass> excluded, Set<EClass> roots) {
		super(metamodel, elements, seed);
		this.excluded = excluded;
		this.roots = roots;
	}

	@Override
	public ImmutableSet<EClass> ignoredEClasses() {
		ImmutableSet.Builder<EClass> all = ImmutableSet.builder();
		all.addAll(super.ignoredEClasses()); // abstract classes and interfaces
		all.addAll(excluded);
		return all.build();
	}

	@Override
	public ImmutableSet<EClass> possibleRootEClasses() {
		return roots.isEmpty() ? super.possibleRootEClasses() : ImmutableSet.copyOf(roots);
	}

}
