export function shouldRunGondolinBuildPipelineE2e(
	env: Partial<Record<'AGENT_VM_GONDOLIN_E2E', string>> = process.env,
): boolean {
	return env.AGENT_VM_GONDOLIN_E2E === '1';
}
