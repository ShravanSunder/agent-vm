export function resolveCanonicalOpenClawAgentWorkspaceDir(agentId: string): string {
	return `/zone/agents/${agentId}`;
}

export function assertCanonicalOpenClawAgentWorkspaceDir(options: {
	readonly agentId: string;
	readonly agentWorkspaceDir: string;
	readonly context: string;
}): void {
	const expectedAgentWorkspaceDir = resolveCanonicalOpenClawAgentWorkspaceDir(options.agentId);
	if (options.agentWorkspaceDir !== expectedAgentWorkspaceDir) {
		throw new Error(
			`${options.context} rejected agentWorkspaceDir '${options.agentWorkspaceDir}' for agent '${options.agentId}': expected '${expectedAgentWorkspaceDir}'.`,
		);
	}
}
