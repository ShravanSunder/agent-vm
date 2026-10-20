// Copied from config-contracts/compiled-google-command-set.ts at 7cb295d1.
import {
	createGogOperationResolver,
	type GogOperationResolution,
} from '@agent-vm/oauth-broker-contracts';

import {
	compiledGoogleCommandSetSchema,
	type CompiledGoogleCommandSet,
} from '../contracts/compiled-google-command-set.js';
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
