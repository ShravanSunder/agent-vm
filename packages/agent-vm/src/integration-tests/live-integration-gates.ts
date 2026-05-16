export function shouldRunLiveVmIntegration(
	env: Partial<Record<'AGENT_VM_LIVE_VM_INTEGRATION', string>> = process.env,
): boolean {
	return env.AGENT_VM_LIVE_VM_INTEGRATION === '1';
}
