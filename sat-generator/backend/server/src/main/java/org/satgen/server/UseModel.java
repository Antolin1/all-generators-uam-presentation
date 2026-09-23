package org.satgen.server;

import java.util.ArrayList;
import java.util.List;

import org.eclipse.emf.ecore.EClass;
import org.tzi.use.api.UseApiException;
import org.tzi.use.api.UseModelApi;
import org.tzi.use.uml.mm.MAggregationKind;
import org.tzi.use.uml.mm.MModel;

/**
 * Builds a real USE model (classes, generalizations, associations and invariants) out of the same
 * {@link MetaModel} the SAT encoder uses, so that a model USE can independently check is exactly the model
 * the Ecore metamodel and the OCL text describe — not a re-derivation of it. This is what turns "SAT found
 * some object graph" into "SAT found a graph USE agrees is a valid instance", once the found objects are
 * replayed into a {@code UseSystemApi} system (see {@code Runner}).
 */
final class UseModel {

	final MModel model;
	final List<String> invariantErrors = new ArrayList<>();

	private UseModel(MModel model) {
		this.model = model;
	}

	static UseModel build(MetaModel mm, List<Ocl2Sat.Constraint> constraints) throws UseApiException {
		UseModelApi api = new UseModelApi("SatGen");

		for (EClass c : allClasses(mm)) api.createClass(c.getName(), c.isAbstract() || c.isInterface());
		for (EClass c : allClasses(mm)) {
			for (EClass parent : c.getESuperTypes()) {
				if (mm.byName.get(parent.getName()) != null) api.createGeneralization(c.getName(), parent.getName());
			}
		}
		// UML/USE convention: the role name and multiplicity written alongside a class describe navigation
		// FROM THE OTHER END *to* that class — so the "owner" end carries the backward role/bounds (how many
		// owners a target has) and the "target" end carries the forward role/bounds (how many targets an owner has).
		for (MetaModel.Ref ref : mm.refs) {
			String backRole = ref.roleFromTarget != null ? ref.roleFromTarget : "_back" + ref.index;
			String backMult = ref.roleFromTarget != null ? multStr(ref.targetLower, ref.targetUpper) : ref.containment ? "1" : "0..*";
			api.createAssociation("Ref" + ref.index,
					ref.owner.getName(), backRole, backMult, MAggregationKind.NONE,
					ref.target.getName(), ref.roleFromOwner, multStr(ref.ownerLower, ref.ownerUpper),
					ref.containment ? MAggregationKind.COMPOSITION : MAggregationKind.NONE);
		}

		UseModel useModel = new UseModel(api.getModel());
		for (Ocl2Sat.Constraint c : constraints) {
			try {
				api.createInvariant(c.name, c.context, c.source, false);
			} catch (UseApiException e) {
				useModel.invariantErrors.add(c.context + "::" + c.name + ": " + e.getMessage());
			}
		}
		return useModel;
	}

	private static List<EClass> allClasses(MetaModel mm) {
		return new ArrayList<>(mm.byName.values());
	}

	private static String multStr(int lower, int upper) {
		if (upper < 0) return lower + "..*";
		if (lower == upper) return String.valueOf(lower);
		return lower + ".." + upper;
	}
}
