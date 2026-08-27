type LiveModelRoundtripEnvironment = Partial<
	Record<'AGENT_VM_LLM_E2E' | 'AGENT_VM_TEST_OPENAI_API_KEY', string>
>;

interface ShouldRunLiveModelRoundtripE2eOptions {
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

	return true;
}
