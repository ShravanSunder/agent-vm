import type { SecretRef, SecretResolver } from './contracts.js';
import { redactOnePasswordReferences } from './secret-redaction.js';

type SecretEnvironment = Readonly<Record<string, string | undefined>>;

function resolveEnvironmentSecret(
	ref: Extract<SecretRef, { readonly source: 'environment' }>,
	env: SecretEnvironment,
): string {
	const value = env[ref.ref];
	if (value === undefined) {
		throw new Error(`Environment variable '${ref.ref}' is not set.`);
	}
	if (value.trim().length === 0) {
		throw new Error(`Environment variable '${ref.ref}' is set but empty.`);
	}
	return value;
}

function resolveConfigSecret(ref: Extract<SecretRef, { readonly source: 'config' }>): string {
	if (ref.value.trim().length === 0) {
		throw new Error('Config secret value is empty.');
	}
	return ref.value;
}

function redactKnownSecretValues(message: string, secretValues: readonly string[]): string {
	return secretValues.reduce((redactedMessage, secretValue) => {
		if (secretValue.length === 0) {
			return redactedMessage;
		}
		return redactedMessage.replaceAll(secretValue, '<redacted>');
	}, message);
}

function formatUnknownError(error: unknown, secretValues: readonly string[] = []): string {
	return redactKnownSecretValues(
		redactOnePasswordReferences(error instanceof Error ? error.message : String(error)),
		secretValues,
	);
}

function describeSecretRef(ref: SecretRef): string {
	switch (ref.source) {
		case '1password':
			return '<1password-ref>';
		case 'environment':
			return ref.ref;
		case 'config':
			return '<config>';
		default: {
			const exhaustiveCheck: never = ref;
			return JSON.stringify(exhaustiveCheck);
		}
	}
}

function createSecretResolutionError(options: {
	readonly cause: unknown;
	readonly ref: SecretRef;
	readonly secretValues?: readonly string[];
	readonly secretName: string;
}): Error {
	return new Error(
		`Failed to resolve secret '${options.secretName}' from '${describeSecretRef(options.ref)}': ${formatUnknownError(options.cause, options.secretValues ?? [])}`,
		{ cause: options.cause },
	);
}

function throwAggregateSecretResolutionError(failures: readonly Error[]): void {
	if (failures.length > 0) {
		throw new AggregateError(failures, `Failed to resolve ${String(failures.length)} secret(s).`);
	}
}

function extractAggregateErrors(
	error: AggregateError,
	secretValues: readonly string[],
): readonly Error[] {
	const failures: readonly unknown[] = Array.isArray(error.errors) ? error.errors : [error];
	return failures.map((failure: unknown) => new Error(formatUnknownError(failure, secretValues)));
}

export function createCompositeSecretResolver(
	onePasswordResolver: SecretResolver | null,
	env: SecretEnvironment = process.env,
): SecretResolver {
	return {
		async resolve(ref: SecretRef): Promise<string> {
			switch (ref.source) {
				case 'environment':
					return resolveEnvironmentSecret(ref, env);
				case 'config':
					return resolveConfigSecret(ref);
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
			const resolvedSecretValues = new Set<string>();
			const onePasswordRefs: Record<
				string,
				Extract<SecretRef, { readonly source: '1password' }>
			> = {};
			const failures: Error[] = [];

			for (const [name, ref] of Object.entries(refs)) {
				switch (ref.source) {
					case 'environment':
						try {
							const value = resolveEnvironmentSecret(ref, env);
							resolved[name] = value;
							resolvedSecretValues.add(value);
						} catch (error) {
							failures.push(
								createSecretResolutionError({
									cause: error,
									ref,
									secretValues: [...resolvedSecretValues],
									secretName: name,
								}),
							);
						}
						break;
					case 'config':
						try {
							const value = resolveConfigSecret(ref);
							resolved[name] = value;
							resolvedSecretValues.add(value);
						} catch (error) {
							failures.push(
								createSecretResolutionError({
									cause: error,
									ref,
									secretValues: [...resolvedSecretValues],
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
								secretValues: [...resolvedSecretValues],
								secretName: name,
							}),
						),
					);
				} else {
					const resolver = onePasswordResolver;
					try {
						Object.assign(resolved, await resolver.resolveAll(onePasswordRefs));
					} catch (error) {
						const secretValues = [...resolvedSecretValues];
						if (error instanceof AggregateError) {
							failures.push(...extractAggregateErrors(error, secretValues));
						} else {
							failures.push(
								...Object.entries(onePasswordRefs).map(([name, ref]) =>
									createSecretResolutionError({
										cause: error,
										ref,
										secretValues,
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
