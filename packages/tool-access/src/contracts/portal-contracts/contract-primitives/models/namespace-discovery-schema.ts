import { z } from 'zod';

import { withPortableSuperRefinement } from '../../portable-contracts/portable-refinement-authoring.js';
import { NamespaceNameSchema } from './capability-reference-schema.js';

export const NamespaceDiscoverySummaryMaxLength = 500;
const NamespaceDiscoverySummarySchema = withPortableSuperRefinement({
	refinement: (summary, context) => {
		if (Array.from(summary).length > NamespaceDiscoverySummaryMaxLength) {
			context.addIssue({
				code: 'custom',
				message: `Namespace discovery summary must contain at most ${String(NamespaceDiscoverySummaryMaxLength)} Unicode characters.`,
			});
		}
	},
	refinementIdentity: 'portal.namespace-discovery.summary-code-points',
	schema: z.string().min(1).meta({ maxLength: NamespaceDiscoverySummaryMaxLength }),
});

export const NamespaceDiscoverySchema = z
	.object({
		summary: NamespaceDiscoverySummarySchema.optional(),
	})
	.strict();

export const EffectiveNamespaceDiscoverySchema = NamespaceDiscoverySchema.extend({
	namespace: NamespaceNameSchema,
}).strict();

export type NamespaceDiscovery = z.infer<typeof NamespaceDiscoverySchema>;
export type EffectiveNamespaceDiscovery = z.infer<typeof EffectiveNamespaceDiscoverySchema>;
