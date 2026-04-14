import type { SecretSpec } from '@shravansunder/gondolin-core';

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

	function writeStderr(message: string): void {
		process.stderr.write(`${message}\n`);
	}

	for (const [secretName, secretValue] of Object.entries(resolvedSecrets)) {
		const secretConfig = zone.secrets[secretName];
		if (!secretConfig) {
			writeStderr(
				`[split-resolved-gateway-secrets] Secret '${secretName}' was resolved but has no matching zone secret config.`,
			);
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
