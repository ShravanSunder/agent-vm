import type { SecretSpec } from '@agent-vm/gondolin-adapter';

import { targetsAudience, type RuntimeVmAudience } from './audience.js';
import type { GatewaySecretConfig, GatewayZoneConfig } from './gateway-lifecycle.js';

export interface SplitResolvedSecretsResult {
	readonly environmentSecrets: Record<string, string>;
	readonly mediatedSecrets: Record<string, SecretSpec>;
}

export type SecretInjectionConfig = GatewaySecretConfig;

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
			throw new Error(
				`[${logPrefix}] Secret '${secretName}' was resolved but has no matching secret config.`,
			);
		}
		if (!targetsAudience(secretConfig.audience, options.audience)) {
			continue;
		}

		if (secretConfig.injection === 'http-mediation') {
			if (secretConfig.hosts.length === 0) {
				throw new Error(
					`[${logPrefix}] Secret '${secretName}' uses http-mediation but declares no hosts.`,
				);
			}
			mediatedSecrets[secretName] = {
				hosts: [...secretConfig.hosts],
				value: secretValue,
			};
			continue;
		}

		const envSecretAudience = (secretConfig as { readonly audience: string }).audience;
		if (envSecretAudience !== 'gateway') {
			throw new Error(
				`[${logPrefix}] Secret '${secretName}' uses env injection with non-gateway audience '${envSecretAudience}'.`,
			);
		}
		if (options.audience === 'gateway') {
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
