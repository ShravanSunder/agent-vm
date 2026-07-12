import { z } from 'zod';

export const NamespaceNameSchema = z.string().min(1);
export const CapabilityNameSchema = z.string().min(1);

export const CapabilityReferenceSchema = z
	.object({
		namespace: NamespaceNameSchema,
		name: CapabilityNameSchema,
	})
	.strict();

export type CapabilityReference = z.infer<typeof CapabilityReferenceSchema>;
