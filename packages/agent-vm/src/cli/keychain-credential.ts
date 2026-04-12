import { execFileSync } from 'node:child_process';

const KEYCHAIN_SERVICE = 'agent-vm';
const KEYCHAIN_ACCOUNT = '1p-service-account';

export interface KeychainCredentialDependencies {
	readonly execFileSync?: (command: string, args: readonly string[]) => string;
}

function defaultExecFileSync(command: string, args: readonly string[]): string {
	return execFileSync(command, [...args], { encoding: 'utf8' });
}

/**
 * Store the 1Password service account token in macOS Keychain.
 * Uses `security add-generic-password -U` which creates or updates.
 * No password prompt when logged in — Keychain is unlocked.
 */
export function storeServiceAccountToken(
	token: string,
	dependencies: KeychainCredentialDependencies = {},
): void {
	const exec = dependencies.execFileSync ?? defaultExecFileSync;
	exec('security', [
		'add-generic-password',
		'-s',
		KEYCHAIN_SERVICE,
		'-a',
		KEYCHAIN_ACCOUNT,
		'-w',
		token,
		'-U',
	]);
}

/**
 * Check whether a service account token exists in macOS Keychain.
 */
export function hasServiceAccountToken(dependencies: KeychainCredentialDependencies = {}): boolean {
	const exec = dependencies.execFileSync ?? defaultExecFileSync;
	try {
		exec('security', [
			'find-generic-password',
			'-s',
			KEYCHAIN_SERVICE,
			'-a',
			KEYCHAIN_ACCOUNT,
			'-w',
		]);
		return true;
	} catch {
		return false;
	}
}

export function getKeychainTokenSource(): {
	readonly type: 'keychain';
	readonly service: string;
	readonly account: string;
} {
	return {
		type: 'keychain',
		service: KEYCHAIN_SERVICE,
		account: KEYCHAIN_ACCOUNT,
	};
}
