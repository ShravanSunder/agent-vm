import { readOnePasswordE2eTestConfig } from '@agent-vm/secret-management';

type LiveModelRoundtripEnvironment = Partial<
	Record<
		| 'AGENT_VM_LLM_E2E'
		| 'AGENT_VM_TEST_OPENAI_API_KEY'
		| 'AGENT_VM_TEST_OP_REFS'
		| 'AGENT_VM_TEST_OP_SERVICE_ACCOUNT_TOKEN'
		| 'AGENT_VM_TEST_OP_VAULT_PREFIX',
		string
	>
>;

interface ShouldRunLiveModelRoundtripE2eOptions {
	readonly canReadConfiguredZoneSecretRefs: (options: {
		readonly serviceAccountToken: string;
		readonly vaultPrefix: string;
	}) => boolean;
	readonly env: LiveModelRoundtripEnvironment;
}

export function shouldRunLiveModelRoundtripE2e(
	options: ShouldRunLiveModelRoundtripE2eOptions,
): boolean {
	if (options.env.AGENT_VM_LLM_E2E !== '1') {
		return false;
	}
	if (
		typeof options.env.AGENT_VM_TEST_OPENAI_API_KEY !== 'string' ||
		options.env.AGENT_VM_TEST_OPENAI_API_KEY.length === 0
	) {
		return false;
	}

	try {
		const config = readOnePasswordE2eTestConfig(options.env);
		return options.canReadConfiguredZoneSecretRefs({
			serviceAccountToken: config.serviceAccountToken,
			vaultPrefix: config.vaultPrefix,
		});
	} catch {
		return false;
	}
}
