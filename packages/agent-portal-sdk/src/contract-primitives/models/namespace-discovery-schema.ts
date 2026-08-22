import { z } from 'zod';

import { NamespaceNameSchema } from './capability-reference-schema.js';

export const NamespaceDiscoverySummaryMaxLength = 500;

export const NamespaceDiscoverySchema = z
	.object({
		summary: z.string().min(1).max(NamespaceDiscoverySummaryMaxLength).optional(),
	})
	.strict();

export const EffectiveNamespaceDiscoverySchema = NamespaceDiscoverySchema.extend({
	namespace: NamespaceNameSchema,
}).strict();

export type NamespaceDiscovery = z.infer<typeof NamespaceDiscoverySchema>;
export type EffectiveNamespaceDiscovery = z.infer<typeof EffectiveNamespaceDiscoverySchema>;
