import type { SecretSpec } from '@agent-vm/gondolin-adapter';

import { targetsAudience, type RuntimeVmAudience, type VmAudience } from './audience.js';
import type { GatewayZoneConfig } from './gateway-lifecycle.js';

export interface SplitResolvedSecretsResult {
	readonly environmentSecrets: Record<string, string>;
	readonly mediatedSecrets: Record<string, SecretSpec>;
}

export interface SecretInjectionConfig {
	readonly audience: VmAudience;
	readonly injection: 'env' | 'http-mediation';
	readonly hosts?: readonly string[] | undefined;
}

export interface SplitResolvedSecretsOptions {
	readonly audience: RuntimeVmAudience;
	readonly logPrefix?: string;
}

export function splitResolvedSecretsByInjection(
	secretConfigs: Readonly<Record<string, SecretInjectionConfig>>,
	resolvedSecrets: Record<string, string>,
	options: SplitResolvedSecretsOptions,
): SplitResolvedSecretsResult {
	const environmentSecrets: Record<string, string> = {};
	const mediatedSecrets: Record<string, SecretSpec> = {};
	const logPrefix = options.logPrefix ?? 'split-resolved-secrets';

	for (const [secretName, secretValue] of Object.entries(resolvedSecrets)) {
		const secretConfig = secretConfigs[secretName];
		if (!secretConfig) {
			process.stderr.write(
				`[${logPrefix}] Secret '${secretName}' was resolved but has no matching secret config.\n`,
			);
			continue;
		}
		if (!targetsAudience(secretConfig.audience, options.audience)) {
			continue;
		}

		if (secretConfig.injection === 'http-mediation' && secretConfig.hosts) {
			mediatedSecrets[secretName] = {
				hosts: [...secretConfig.hosts],
				value: secretValue,
			};
			continue;
		}

		if (options.audience === 'gateway' && secretConfig.injection === 'env') {
			environmentSecrets[secretName] = secretValue;
		}
	}

	return { environmentSecrets, mediatedSecrets };
}

export type SplitResolvedGatewaySecretsResult = SplitResolvedSecretsResult;

export function splitResolvedGatewaySecrets(
	zone: GatewayZoneConfig,
	resolvedSecrets: Record<string, string>,
): SplitResolvedGatewaySecretsResult {
	return splitResolvedSecretsByInjection(zone.secrets, resolvedSecrets, {
		audience: 'gateway',
		logPrefix: 'split-resolved-gateway-secrets',
	});
}
