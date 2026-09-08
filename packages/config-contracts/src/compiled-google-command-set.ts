import {
	createGogOperationResolver,
	gogCommandDescriptorSchema,
	googleCatalogFamilyIdSchema,
	type GogOperationResolution,
} from '@agent-vm/oauth-broker-contracts';
import { z } from 'zod';

import { googleOAuthApplicationIdSchema } from './oauth-config.js';

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

export function resolveCompiledGoogleCommand(
	set: CompiledGoogleCommandSet,
	argv: readonly string[],
): GogOperationResolution {
	const parsed = compiledGoogleCommandSetSchema.safeParse(set);
	if (!parsed.success) return { kind: 'denied' };
	if (
		parsed.data.noOAuthPaths.some(
			(path) => path.length === argv.length && path.every((part, index) => part === argv[index]),
		)
	)
		return { kind: 'no-oauth' };
	try {
		const resolved = createGogOperationResolver(parsed.data.descriptors)(argv);
		return resolved.kind === 'no-oauth' ? { kind: 'denied' } : resolved;
	} catch {
		return { kind: 'denied' };
	}
}
