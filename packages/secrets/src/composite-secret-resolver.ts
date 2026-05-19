import type { SecretRef, SecretResolver } from './contracts.js';

function resolveEnvironmentSecret(ref: SecretRef, env: NodeJS.ProcessEnv): string {
	const value = env[ref.ref];
	if (value === undefined) {
		throw new Error(`Environment variable '${ref.ref}' is not set.`);
	}
	if (value.trim().length === 0) {
		throw new Error(`Environment variable '${ref.ref}' is set but empty.`);
	}
	return value;
}

function formatUnknownError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function createSecretResolutionError(options: {
	readonly cause: unknown;
	readonly ref: SecretRef;
	readonly secretName: string;
}): Error {
	return new Error(
		`Failed to resolve secret '${options.secretName}' from '${options.ref.ref}': ${formatUnknownError(options.cause)}`,
		{ cause: options.cause },
	);
}

function throwAggregateSecretResolutionError(failures: readonly Error[]): void {
	if (failures.length > 0) {
		throw new AggregateError(failures, `Failed to resolve ${String(failures.length)} secret(s).`);
	}
}

function extractAggregateErrors(error: AggregateError): readonly Error[] {
	const failures: readonly unknown[] = Array.isArray(error.errors) ? error.errors : [error];
	return failures.map((failure: unknown) =>
		failure instanceof Error ? failure : new Error(formatUnknownError(failure), { cause: failure }),
	);
}

export function createCompositeSecretResolver(
	onePasswordResolver: SecretResolver | null,
	env: NodeJS.ProcessEnv = process.env,
): SecretResolver {
	return {
		async resolve(ref: SecretRef): Promise<string> {
			switch (ref.source) {
				case 'environment':
					return resolveEnvironmentSecret(ref, env);
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
			const onePasswordRefs: Record<
				string,
				Extract<SecretRef, { readonly source: '1password' }>
			> = {};
			const failures: Error[] = [];

			for (const [name, ref] of Object.entries(refs)) {
				switch (ref.source) {
					case 'environment':
						try {
							resolved[name] = resolveEnvironmentSecret(ref, env);
						} catch (error) {
							failures.push(
								createSecretResolutionError({
									cause: error,
									ref,
									secretName: name,
								}),
							);
						}
						break;
					case '1password':
						onePasswordRefs[name] = ref;
						break;
					default: {
						const exhaustiveCheck: never = ref;
						throw new Error(`Unsupported secret source: ${JSON.stringify(exhaustiveCheck)}`);
					}
				}
			}

			if (Object.keys(onePasswordRefs).length > 0) {
				if (!onePasswordResolver) {
					failures.push(
						...Object.entries(onePasswordRefs).map(([name, ref]) =>
							createSecretResolutionError({
								cause: new Error(
									"Secret with source '1password' requires host.secretsProvider to be configured.",
								),
								ref,
								secretName: name,
							}),
						),
					);
				} else {
					const resolver = onePasswordResolver;
					try {
						Object.assign(resolved, await resolver.resolveAll(onePasswordRefs));
					} catch (error) {
						if (error instanceof AggregateError) {
							failures.push(...extractAggregateErrors(error));
						} else {
							failures.push(
								...Object.entries(onePasswordRefs).map(([name, ref]) =>
									createSecretResolutionError({
										cause: error,
										ref,
										secretName: name,
									}),
								),
							);
						}
					}
				}
			}
			throwAggregateSecretResolutionError(failures);
			return resolved;
		},
	};
}
