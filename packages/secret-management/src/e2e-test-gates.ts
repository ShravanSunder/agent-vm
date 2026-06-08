export function shouldRunOnePasswordSecretResolverE2e(
	env: Partial<Record<'AGENT_VM_1PASSWORD_E2E', string>> = process.env,
): boolean {
	return env.AGENT_VM_1PASSWORD_E2E === '1';
}
