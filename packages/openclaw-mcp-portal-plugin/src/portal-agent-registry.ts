export interface PortalAgentRecord {
	readonly id: string;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function resolvePortalAgents(config: unknown): readonly PortalAgentRecord[] {
	if (!isObjectRecord(config) || !isObjectRecord(config.agents)) {
		return [];
	}

	const agentsValue = config.agents.list;
	if (!Array.isArray(agentsValue)) {
		return [];
	}

	return agentsValue
		.map((agent): PortalAgentRecord | null => {
			if (!isObjectRecord(agent)) {
				return null;
			}
			const id = agent.id ?? agent.name;
			return typeof id === 'string' && id.length > 0 ? { id } : null;
		})
		.filter((agent): agent is PortalAgentRecord => agent !== null)
		.toSorted((left, right) => left.id.localeCompare(right.id));
}
