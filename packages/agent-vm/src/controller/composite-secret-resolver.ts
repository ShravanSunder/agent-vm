import type { SecretRef, SecretResolver } from '@agent-vm/gondolin-adapter';

export function createCompositeSecretResolver(
	onePasswordResolver: SecretResolver | null,
	env: NodeJS.ProcessEnv = process.env,
): SecretResolver {
	return {
		async resolve(ref: SecretRef): Promise<string> {
			switch (ref.source) {
				case 'environment': {
					const value = env[ref.ref];
					if (value === undefined) {
						throw new Error(`Environment variable '${ref.ref}' is not set.`);
					}
					if (value.trim().length === 0) {
						throw new Error(`Environment variable '${ref.ref}' is set but empty.`);
					}
					return value;
				}
				case '1password': {
					if (!onePasswordResolver) {
						throw new Error(
							"Secret with source '1password' requires host.secretsProvider to be configured.",
						);
					}
					return await onePasswordResolver.resolve(ref);
				}
				default: {
					const exhaustiveCheck: never = ref;
					throw new Error(`Unsupported secret source: ${JSON.stringify(exhaustiveCheck)}`);
				}
			}
		},

		async resolveAll(refs: Record<string, SecretRef>): Promise<Record<string, string>> {
			const resolved: Record<string, string> = {};
			for (const [name, ref] of Object.entries(refs)) {
				// Resolution is intentionally sequential to preserve exact per-secret error context.
				// oxlint-disable-next-line eslint/no-await-in-loop
				resolved[name] = await this.resolve(ref);
			}
			return resolved;
		},
	};
}
