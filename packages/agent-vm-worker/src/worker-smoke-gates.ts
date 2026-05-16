export function shouldRunWorkerRuntimeSmoke(options: {
	readonly commandExists: (command: string) => boolean;
	readonly env: Partial<Record<'AGENT_VM_WORKER_RUNTIME_SMOKE' | 'OPEN_AI_TEST_KEY', string>>;
}): boolean {
	return (
		options.env.AGENT_VM_WORKER_RUNTIME_SMOKE === '1' &&
		typeof options.env.OPEN_AI_TEST_KEY === 'string' &&
		options.env.OPEN_AI_TEST_KEY.length > 0 &&
		options.commandExists('codex')
	);
}
