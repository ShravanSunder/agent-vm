export function shouldRunOnePasswordSecretResolverSmoke(
	env: Partial<Record<'AGENT_VM_1PASSWORD_SMOKE', string>> = process.env,
): boolean {
	return env.AGENT_VM_1PASSWORD_SMOKE === '1';
}
