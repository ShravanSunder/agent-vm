import type { z } from 'zod';

import { PORTABLE_REFINEMENT_DESCRIPTORS } from './portable-refinement-descriptors.js';

const portableRefinementIdentities: ReadonlySet<string> = new Set(
	PORTABLE_REFINEMENT_DESCRIPTORS.map((descriptor) => descriptor.identity),
);
const portableRefinementIdentityByCheck = new WeakMap<object, string>();

export interface PortableSuperRefinementProps<TSchema extends z.ZodType> {
	readonly refinement: (value: z.output<TSchema>, context: z.RefinementCtx) => void;
	readonly refinementIdentity: string;
	readonly schema: TSchema;
}

export function withPortableSuperRefinement<TSchema extends z.ZodType>(
	props: PortableSuperRefinementProps<TSchema>,
): TSchema {
	if (!portableRefinementIdentities.has(props.refinementIdentity)) {
		throw new Error(`Portable refinement ${props.refinementIdentity} is not registered.`);
	}
	// oxlint-disable-next-line no-underscore-dangle -- Zod v4 exposes schema definitions through its library-author core contract.
	const existingChecks = new Set(props.schema._zod.def.checks ?? []);
	const refinedSchema = props.schema.superRefine(props.refinement);
	// oxlint-disable-next-line no-underscore-dangle -- Match the one check added by the named authoring helper.
	const addedChecks = (refinedSchema._zod.def.checks ?? []).filter(
		(check) => !existingChecks.has(check),
	);
	if (addedChecks.length !== 1) {
		throw new Error(
			`Portable refinement ${props.refinementIdentity} must add exactly one Zod check.`,
		);
	}
	const addedCheck = addedChecks[0];
	if (addedCheck === undefined) {
		throw new Error(`Portable refinement ${props.refinementIdentity} added no Zod check.`);
	}
	portableRefinementIdentityByCheck.set(addedCheck, props.refinementIdentity);
	return refinedSchema;
}

export function portableRefinementIdentityForCheck(check: object): string | undefined {
	return portableRefinementIdentityByCheck.get(check);
}
