export interface OnePasswordE2eTestConfig {
	readonly secretReferences: readonly string[];
	readonly serviceAccountToken: string;
	readonly vaultPrefix: string;
}

export type OnePasswordE2eTestEnvironment = Partial<
	Record<
		| 'AGENT_VM_TEST_OP_REFS'
		| 'AGENT_VM_TEST_OP_SERVICE_ACCOUNT_TOKEN'
		| 'AGENT_VM_TEST_OP_VAULT_PREFIX',
		string
	>
>;

export const defaultOnePasswordE2eVaultPrefix = 'op://agent-vm-testing/';

function readSecretReferences(rawReferences: string | undefined): readonly string[] {
	if (typeof rawReferences !== 'string' || rawReferences.trim().length === 0) {
		throw new Error('Set AGENT_VM_TEST_OP_REFS to at least one op:// test-vault reference.');
	}
	return rawReferences
		.split(',')
		.map((secretReference) => secretReference.trim())
		.filter((secretReference) => secretReference.length > 0);
}

export function readOnePasswordE2eTestConfig(
	env: OnePasswordE2eTestEnvironment = process.env,
): OnePasswordE2eTestConfig {
	const serviceAccountToken = env.AGENT_VM_TEST_OP_SERVICE_ACCOUNT_TOKEN;
	const vaultPrefix = env.AGENT_VM_TEST_OP_VAULT_PREFIX ?? defaultOnePasswordE2eVaultPrefix;
	const secretReferences = readSecretReferences(env.AGENT_VM_TEST_OP_REFS);

	if (typeof serviceAccountToken !== 'string' || serviceAccountToken.length === 0) {
		throw new Error('Set AGENT_VM_TEST_OP_SERVICE_ACCOUNT_TOKEN when AGENT_VM_1PASSWORD_E2E=1.');
	}
	if (!vaultPrefix.startsWith('op://')) {
		throw new Error('AGENT_VM_TEST_OP_VAULT_PREFIX must start with op://.');
	}
	for (const secretReference of secretReferences) {
		if (!secretReference.startsWith('op://')) {
			throw new Error('Every AGENT_VM_TEST_OP_REFS entry must be an op:// reference.');
		}
		if (!secretReference.startsWith(vaultPrefix)) {
			throw new Error(
				`Every AGENT_VM_TEST_OP_REFS entry must start with ${vaultPrefix} to avoid deployment vaults.`,
			);
		}
	}

	return { secretReferences, serviceAccountToken, vaultPrefix };
}
