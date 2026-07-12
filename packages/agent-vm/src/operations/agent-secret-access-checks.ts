import { targetsAudience } from '@agent-vm/gateway-contracts';

import type { SystemConfig } from '../config/system-config.js';

export interface AgentSecretAccessCheck {
	readonly hint: string;
	readonly name: string;
	readonly ok: boolean;
}

type ZoneSecretConfig = SystemConfig['zones'][number]['secrets'][string];
type AgentAccessConfig = 'all' | readonly string[];

function formatAgentAccessHint(agentAccess: AgentAccessConfig): string {
	return agentAccess === 'all' ? 'all declared agents' : agentAccess.join(', ');
}

function formatToolVmSecretAccessHint(
	secret: ZoneSecretConfig,
	agentAccess: AgentAccessConfig | undefined,
): string {
	if (agentAccess === undefined) {
		return `missing agentAccess; audience: ${secret.audience}`;
	}
	const toolVmHint = `tool-vm: ${formatAgentAccessHint(agentAccess)}`;
	return secret.audience === 'both' ? `${toolVmHint}; gateway: zone-wide` : toolVmHint;
}

function getAgentAccess(secret: ZoneSecretConfig): AgentAccessConfig | undefined {
	return 'agentAccess' in secret ? secret.agentAccess : undefined;
}

export function buildOpenClawAgentSecretAccessChecks(
	systemConfig: Pick<SystemConfig, 'zones'>,
): readonly AgentSecretAccessCheck[] {
	return systemConfig.zones.flatMap((zone) => {
		if (zone.gateway.type !== 'openclaw') {
			return [];
		}
		return Object.entries(zone.secrets).flatMap(([secretName, secret]) => {
			if (secret.injection !== 'http-mediation' || !targetsAudience(secret.audience, 'tool-vm')) {
				return [];
			}
			const agentAccess = getAgentAccess(secret);
			return [
				{
					name: `zone-agent-secret-access-${zone.id}-${secretName}`,
					ok: agentAccess !== undefined,
					hint: formatToolVmSecretAccessHint(secret, agentAccess),
				},
			] as const satisfies readonly AgentSecretAccessCheck[];
		});
	});
}
