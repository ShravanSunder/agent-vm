// Copied from agent-vm at 7cb295d1; existing packages remain unchanged until S4.
import {
	gogCommandDescriptorSchema,
	googleCatalogFamilyIdSchema,
} from '@agent-vm/oauth-broker-contracts';
import { z } from 'zod';

import { googleOAuthApplicationIdSchema } from '#tool-access/contracts/google-application-id';

/** Code-compiled effective data. The authored CLI schema deliberately has no such field. */
export const compiledGoogleCommandSetSchema = z
	.object({
		descriptors: z.array(gogCommandDescriptorSchema).max(512).readonly(),
		noOAuthPaths: z
			.array(
				z
					.array(z.enum(['--help', '--version', 'version']))
					.length(1)
					.readonly(),
			)
			.max(3)
			.readonly(),
		applicationIdsByFamily: z
			.record(googleCatalogFamilyIdSchema, googleOAuthApplicationIdSchema)
			.readonly(),
		revision: z.string().regex(/^[a-f0-9]{64}$/u),
	})
	.strict();
export type CompiledGoogleCommandSet = z.infer<typeof compiledGoogleCommandSetSchema>;
