export function shouldRunGondolinBuildPipelineSmoke(
	env: Partial<Record<'AGENT_VM_GONDOLIN_BUILD_PIPELINE_SMOKE', string>> = process.env,
): boolean {
	return env.AGENT_VM_GONDOLIN_BUILD_PIPELINE_SMOKE === '1';
}
