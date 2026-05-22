import type { SecretValue } from '@agent-vm/config-contracts';
import type { SecretRef, SecretResolver } from '@agent-vm/secret-management';

export interface ResolveSecretValueProps {
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly secretResolver?: SecretResolver;
}

function secretRefFromSecretValue(secret: SecretValue): SecretRef {
	if (secret.source === 'environment') {
		return { ref: secret.name, source: 'environment' };
	}
	return { ref: secret.ref, source: '1password' };
}

export async function resolveSecretValue(
	secret: SecretValue,
	props: ResolveSecretValueProps,
): Promise<string> {
	if (secret.source === 'environment') {
		const value = props.env[secret.name];
		if (value === undefined || value.length === 0) {
			throw new Error(`Missing environment secret ${secret.name}.`);
		}
		return value;
	}

	if (props.secretResolver === undefined) {
		throw new Error("Secret with source '1password' requires a configured secret resolver.");
	}
	return await props.secretResolver.resolve(secretRefFromSecretValue(secret));
}
