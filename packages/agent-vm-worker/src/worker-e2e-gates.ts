export function shouldRunWorkerRuntimeE2e(options: {
	readonly commandExists: (command: string) => boolean;
	readonly env: Partial<Record<'AGENT_VM_WORKER_E2E' | 'AGENT_VM_TEST_OPENAI_API_KEY', string>>;
}): boolean {
	return (
		options.env.AGENT_VM_WORKER_E2E === '1' &&
		typeof options.env.AGENT_VM_TEST_OPENAI_API_KEY === 'string' &&
		options.env.AGENT_VM_TEST_OPENAI_API_KEY.length > 0 &&
		options.commandExists('codex')
	);
}
