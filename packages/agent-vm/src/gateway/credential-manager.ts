import { targetsAudience, type RuntimeVmAudience } from '@agent-vm/gateway-interface';
import type { SecretRef, SecretResolver } from '@agent-vm/secrets';

import type { SystemConfig } from '../config/system-config.js';

function buildSuggestedSecretRef(zoneId: string, secretName: string): string {
	switch (secretName) {
		case 'DISCORD_BOT_TOKEN':
			return `op://agent-vm/${zoneId}-discord/bot-token`;
		case 'PERPLEXITY_API_KEY':
			return `op://agent-vm/${zoneId}-perplexity/credential`;
		case 'OPENCLAW_GATEWAY_TOKEN':
			return `op://agent-vm/${zoneId}-gateway-auth/password`;
		case 'OPENAI_API_KEY':
			return `op://agent-vm/${zoneId}-openai/credential`;
		case 'ANTHROPIC_API_KEY':
			return `op://agent-vm/${zoneId}-anthropic/credential`;
		default:
			return `op://agent-vm/${zoneId}-${secretName.toLowerCase().replace(/_/gu, '-')}/credential`;
	}
}

function findZone(
	systemConfig: SystemConfig,
	zoneId: string,
): SystemConfig['zones'][number] | undefined {
	return systemConfig.zones.find((zone) => zone.id === zoneId);
}

function formatUnknownError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatSecretResolutionFailure(zoneId: string, error: unknown): string {
	const message = formatUnknownError(error);
	if (error instanceof AggregateError && error.errors.length > 0) {
		const details = Array.from<unknown>(error.errors).map(formatUnknownError).join('; ');
		const separator = message.endsWith('.') ? '' : '.';
		return `Failed to resolve zone secrets for zone '${zoneId}': ${message}${separator} Details: ${details}`;
	}
	return `Failed to resolve zone secrets for zone '${zoneId}': ${message}`;
}

type ResolveZoneSecretsOptions =
	| {
			readonly systemConfig: SystemConfig;
			readonly zoneId: string;
			readonly secretResolver: SecretResolver;
			readonly audience: 'gateway';
			readonly injection?: 'env' | 'http-mediation';
	  }
	| {
			readonly systemConfig: SystemConfig;
			readonly zoneId: string;
			readonly secretResolver: SecretResolver;
			readonly audience: 'tool-vm';
			readonly injection: 'http-mediation';
	  };

export async function resolveZoneSecrets(
	options: ResolveZoneSecretsOptions,
): Promise<Record<string, string>> {
	if (options.audience === 'tool-vm' && options.injection !== 'http-mediation') {
		throw new Error("Tool VM secret resolution requires injection 'http-mediation'.");
	}
	const runtimeAudience: RuntimeVmAudience = options.audience;
	const injectionFilter = options.injection;
	const zone = findZone(options.systemConfig, options.zoneId);
	if (!zone) {
		throw new Error(`Unknown zone '${options.zoneId}'.`);
	}

	const secretRefs: Record<string, SecretRef> = {};
	for (const [secretName, secretConfig] of Object.entries(zone.secrets)) {
		if (!targetsAudience(secretConfig.audience, runtimeAudience)) {
			continue;
		}
		if (options.audience === 'tool-vm' && secretConfig.injection !== 'http-mediation') {
			throw new Error(
				`Tool VM secret '${secretName}' in zone '${zone.id}' must use injection 'http-mediation'.`,
			);
		}
		if (injectionFilter && secretConfig.injection !== injectionFilter) {
			continue;
		}
		switch (secretConfig.source) {
			case 'environment':
				if (!secretConfig.envVar) {
					throw new Error(
						`Zone '${zone.id}' secret '${secretName}' is missing 'envVar'. Add an explicit environment variable name.`,
					);
				}
				secretRefs[secretName] = {
					ref: secretConfig.envVar,
					source: 'environment',
				};
				break;
			case '1password':
				if (!secretConfig.ref) {
					throw new Error(
						`Zone '${zone.id}' secret '${secretName}' is missing 'ref'. Add an explicit 1Password reference such as '${buildSuggestedSecretRef(zone.id, secretName)}'.`,
					);
				}
				secretRefs[secretName] = {
					ref: secretConfig.ref,
					source: '1password',
				};
				break;
			default: {
				const exhaustiveCheck: never = secretConfig;
				throw new Error(
					`Unsupported secret config for '${secretName}': ${JSON.stringify(exhaustiveCheck)}`,
				);
			}
		}
	}

	try {
		return await options.secretResolver.resolveAll(secretRefs);
	} catch (error) {
		throw new Error(formatSecretResolutionFailure(zone.id, error), { cause: error });
	}
}
