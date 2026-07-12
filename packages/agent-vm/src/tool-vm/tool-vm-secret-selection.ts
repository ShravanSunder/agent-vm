import { targetsAudience } from '@agent-vm/gateway-lifecycle';

import type { SystemConfig } from '../config/system-config.js';

type ZoneConfig = SystemConfig['zones'][number];
type ZoneSecretConfig = ZoneConfig['secrets'][string];

function secretTargetsToolVm(secret: ZoneSecretConfig): boolean {
	return secret.injection === 'http-mediation' && targetsAudience(secret.audience, 'tool-vm');
}

function zoneDeclaresAgent(zone: ZoneConfig, agentId: string): boolean {
	return (zone.agents ?? []).some((agent) => agent.id === agentId);
}

export function secretTargetsToolVmAgent(options: {
	readonly agentId: string;
	readonly agentIsDeclared: boolean;
	readonly secret: ZoneSecretConfig;
	readonly secretName: string;
	readonly zoneId: string;
}): boolean {
	const { agentId, agentIsDeclared, secret, secretName, zoneId } = options;
	if (!secretTargetsToolVm(secret)) {
		return false;
	}
	if (!agentIsDeclared) {
		throw new Error(
			`Tool VM mediated secrets in zone '${zoneId}' require declared agent '${agentId}' in zones[].agents before secret access can be selected.`,
		);
	}
	if (!('agentAccess' in secret)) {
		throw new Error(
			`Tool VM mediated secret '${secretName}' in zone '${zoneId}' is missing required agentAccess.`,
		);
	}
	if (secret.agentAccess === 'all') {
		return true;
	}
	return secret.agentAccess.includes(agentId);
}

export function selectToolVmMediatedSecretNamesForAgent(options: {
	readonly agentId: string;
	readonly zone: ZoneConfig;
}): ReadonlySet<string> {
	const toolVmMediatedSecrets = Object.entries(options.zone.secrets).filter(([, secret]) =>
		secretTargetsToolVm(secret),
	);
	if (toolVmMediatedSecrets.length === 0) {
		return new Set();
	}
	const agentIsDeclared = zoneDeclaresAgent(options.zone, options.agentId);
	if (!agentIsDeclared) {
		throw new Error(
			`Tool VM mediated secrets in zone '${options.zone.id}' require declared agent '${options.agentId}' in zones[].agents before secret access can be selected.`,
		);
	}
	const selectedNames = new Set<string>();
	for (const [secretName, secret] of toolVmMediatedSecrets) {
		if (
			secretTargetsToolVmAgent({
				agentId: options.agentId,
				secret,
				secretName,
				agentIsDeclared,
				zoneId: options.zone.id,
			})
		) {
			selectedNames.add(secretName);
		}
	}
	return selectedNames;
}
