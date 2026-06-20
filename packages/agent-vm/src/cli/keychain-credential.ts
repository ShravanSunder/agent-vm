import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';

const KEYCHAIN_SERVICE = 'agent-vm';
const KEYCHAIN_ACCOUNT = '1p-service-account';
const SECURITY_COMMAND = '/usr/bin/security';
const safeKeychainIdentifierPattern = /^[\w.@-]+$/u;

export interface KeychainCredentialDependencies {
	readonly account?: string;
	readonly accountName?: string;
	readonly execFileSync?: (command: string, args: readonly string[]) => string;
	readonly securityCommand?: string;
	readonly service?: string;
	readonly spawnSync?: (
		command: string,
		args: readonly string[],
		options: { readonly encoding: 'utf8'; readonly input: string },
	) => Pick<SpawnSyncReturns<string>, 'error' | 'status' | 'stderr' | 'stdout'>;
}

interface KeychainCredentialTarget {
	readonly account: string;
	readonly service: string;
}

function defaultExecFileSync(command: string, args: readonly string[]): string {
	return execFileSync(command, [...args], { encoding: 'utf8' });
}

function defaultSpawnSync(
	command: string,
	args: readonly string[],
	options: { readonly encoding: 'utf8'; readonly input: string },
): Pick<SpawnSyncReturns<string>, 'error' | 'status' | 'stderr' | 'stdout'> {
	return spawnSync(command, [...args], options);
}

function resolveSecurityCommand(dependencies: KeychainCredentialDependencies): string {
	if (dependencies.securityCommand !== undefined) {
		return dependencies.securityCommand;
	}
	if (process.env.NODE_ENV === 'test' && process.env.AGENT_VM_TEST_SECURITY_COMMAND) {
		return process.env.AGENT_VM_TEST_SECURITY_COMMAND;
	}
	return SECURITY_COMMAND;
}

export function assertSafeKeychainIdentifier(value: string, label: string): void {
	if (!safeKeychainIdentifierPattern.test(value)) {
		throw new Error(
			`Invalid 1Password Keychain ${label} '${value}'. Expected only letters, digits, underscore, dot, at-sign, or dash.`,
		);
	}
}

export function resolveServiceAccountKeychainTarget(
	options: Pick<KeychainCredentialDependencies, 'account' | 'accountName' | 'service'> = {},
): KeychainCredentialTarget {
	if (options.account !== undefined || options.service !== undefined) {
		const service = options.service ?? KEYCHAIN_SERVICE;
		const account = options.account ?? KEYCHAIN_ACCOUNT;
		assertSafeKeychainIdentifier(service, 'service');
		assertSafeKeychainIdentifier(account, 'account');
		return { account, service };
	}
	const account =
		options.accountName === undefined
			? KEYCHAIN_ACCOUNT
			: `${KEYCHAIN_ACCOUNT}--${options.accountName}`;
	assertSafeKeychainIdentifier(KEYCHAIN_SERVICE, 'service');
	if (options.accountName !== undefined) {
		assertSafeKeychainIdentifier(options.accountName, 'account name');
	}
	assertSafeKeychainIdentifier(account, 'account');
	return {
		account,
		service: KEYCHAIN_SERVICE,
	};
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
	const runSecurity = dependencies.spawnSync ?? defaultSpawnSync;
	const target = resolveServiceAccountKeychainTarget(dependencies);
	const result = runSecurity(
		resolveSecurityCommand(dependencies),
		['add-generic-password', '-s', target.service, '-a', target.account, '-U', '-w'],
		{ encoding: 'utf8', input: token },
	);
	if (result.error !== undefined || result.status !== 0) {
		throw new Error('Failed to store 1Password service account token in macOS Keychain.');
	}
}

/**
 * Check whether a service account token exists in macOS Keychain.
 */
export function hasServiceAccountToken(dependencies: KeychainCredentialDependencies = {}): boolean {
	const exec = dependencies.execFileSync ?? defaultExecFileSync;
	const target = resolveServiceAccountKeychainTarget(dependencies);
	try {
		exec(resolveSecurityCommand(dependencies), [
			'find-generic-password',
			'-s',
			target.service,
			'-a',
			target.account,
			'-w',
		]);
		return true;
	} catch {
		return false;
	}
}

export function getKeychainTokenSource(
	options?: Pick<KeychainCredentialDependencies, 'accountName'>,
): {
	readonly type: 'keychain';
	readonly service: string;
	readonly account: string;
} {
	const target = resolveServiceAccountKeychainTarget(options);
	return {
		type: 'keychain',
		service: target.service,
		account: target.account,
	};
}
