import type { MediatedSecretSpec } from '@agent-vm/secrets';

import { targetsAudience, type RuntimeVmAudience } from './audience.js';
import type { GatewaySecretConfig, GatewayZoneConfig } from './gateway-lifecycle.js';

export interface SplitResolvedSecretsResult {
	readonly environmentSecrets: Record<string, string>;
	readonly mediatedSecrets: Record<string, MediatedSecretSpec>;
}

export interface MergeRuntimeGatewaySecretsOptions {
	readonly logPrefix?: string;
	readonly runtimeEnvironment?: Readonly<Record<string, string>> | undefined;
	readonly runtimeMediatedSecrets?: Readonly<Record<string, MediatedSecretSpec>> | undefined;
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
	const mediatedSecrets: Record<string, MediatedSecretSpec> = {};
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

function assertNoRuntimeSecretCollision(
	secretName: string,
	target: 'environment' | 'http-mediation',
	baseSecrets: SplitResolvedSecretsResult,
	runtimeSeen: Set<string>,
	logPrefix: string,
): void {
	if (runtimeSeen.has(secretName)) {
		throw new Error(
			`[${logPrefix}] Runtime gateway secret '${secretName}' is declared for both environment and http-mediation injection.`,
		);
	}
	if (secretName in baseSecrets.environmentSecrets) {
		throw new Error(
			`[${logPrefix}] Runtime gateway ${target} secret '${secretName}' would overwrite an authored environment secret.`,
		);
	}
	if (secretName in baseSecrets.mediatedSecrets) {
		throw new Error(
			`[${logPrefix}] Runtime gateway ${target} secret '${secretName}' would overwrite an authored http-mediation secret.`,
		);
	}
	runtimeSeen.add(secretName);
}

export function mergeRuntimeGatewaySecrets(
	baseSecrets: SplitResolvedSecretsResult,
	options: MergeRuntimeGatewaySecretsOptions = {},
): SplitResolvedSecretsResult {
	const logPrefix = options.logPrefix ?? 'merge-runtime-gateway-secrets';
	const runtimeSeen = new Set<string>();
	for (const secretName of Object.keys(options.runtimeEnvironment ?? {})) {
		assertNoRuntimeSecretCollision(secretName, 'environment', baseSecrets, runtimeSeen, logPrefix);
	}
	for (const secretName of Object.keys(options.runtimeMediatedSecrets ?? {})) {
		assertNoRuntimeSecretCollision(
			secretName,
			'http-mediation',
			baseSecrets,
			runtimeSeen,
			logPrefix,
		);
	}

	return {
		environmentSecrets: {
			...baseSecrets.environmentSecrets,
			...options.runtimeEnvironment,
		},
		mediatedSecrets: {
			...baseSecrets.mediatedSecrets,
			...options.runtimeMediatedSecrets,
		},
	};
}
