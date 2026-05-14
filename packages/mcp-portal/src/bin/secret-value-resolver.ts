import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { SecretValue } from '@agent-vm/config-contracts';

const execFileAsync = promisify(execFile);

export interface ResolveSecretValueProps {
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly readOnePasswordSecret?: (ref: string) => Promise<string>;
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

	const readOnePasswordSecret = props.readOnePasswordSecret ?? readOnePasswordCliSecret;
	return await readOnePasswordSecret(secret.ref);
}

async function readOnePasswordCliSecret(ref: string): Promise<string> {
	const { stdout } = await execFileAsync('op', ['read', ref], { encoding: 'utf8' });
	return stdout.trimEnd();
}
