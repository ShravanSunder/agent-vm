import type { SecretSpec } from '@shravansunder/agent-vm-gondolin-core';

import type { GatewayZoneConfig } from './gateway-lifecycle.js';

export interface SplitResolvedGatewaySecretsResult {
	readonly environmentSecrets: Record<string, string>;
	readonly mediatedSecrets: Record<string, SecretSpec>;
}

export function splitResolvedGatewaySecrets(
	zone: GatewayZoneConfig,
	resolvedSecrets: Record<string, string>,
): SplitResolvedGatewaySecretsResult {
	const environmentSecrets: Record<string, string> = {};
	const mediatedSecrets: Record<string, SecretSpec> = {};

	for (const [secretName, secretValue] of Object.entries(resolvedSecrets)) {
		const secretConfig = zone.secrets[secretName];
		if (!secretConfig) {
			continue;
		}

		if (secretConfig.injection === 'http-mediation' && secretConfig.hosts) {
			mediatedSecrets[secretName] = {
				hosts: [...secretConfig.hosts],
				value: secretValue,
			};
			continue;
		}

		environmentSecrets[secretName] = secretValue;
	}

	return { environmentSecrets, mediatedSecrets };
}
