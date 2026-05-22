import type { SecretRef, SecretResolver } from './contracts.js';

export function createStaticSecretResolver(
	values: Readonly<Record<string, string>>,
): SecretResolver {
	const resolve = async (ref: SecretRef): Promise<string> => {
		if (ref.source === 'config') {
			return ref.value;
		}
		const value = values[ref.ref];
		if (value === undefined) {
			throw new Error(`No test secret value configured for '${ref.ref}'.`);
		}
		return value;
	};

	return {
		resolve,
		resolveAll: async (
			refs: Readonly<Record<string, SecretRef>>,
		): Promise<Record<string, string>> => {
			return Object.fromEntries(
				await Promise.all(
					Object.entries(refs).map(async ([name, ref]) => [name, await resolve(ref)] as const),
				),
			);
		},
	};
}
