import { targetsAudience, type RuntimeVmAudience } from '@agent-vm/gateway-interface';
import type { SecretRef, SecretResolver } from '@agent-vm/gondolin-adapter';

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

	const resolvedSecrets: Record<string, string> = {};
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
		let secretRef: SecretRef;
		switch (secretConfig.source) {
			case 'config':
				secretRef = {
					source: 'config',
					value: secretConfig.value,
				};
				break;
			case 'environment':
				if (!secretConfig.envVar) {
					throw new Error(
						`Zone '${zone.id}' secret '${secretName}' is missing 'envVar'. Add an explicit environment variable name.`,
					);
				}
				secretRef = {
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
				secretRef = {
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

		try {
			// Sequential resolution gives the user exact secret context on failure.
			// oxlint-disable-next-line eslint/no-await-in-loop
			resolvedSecrets[secretName] = await options.secretResolver.resolve(secretRef);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const sourceReference =
				secretConfig.source === 'environment'
					? secretConfig.envVar
					: secretConfig.source === 'config'
						? 'config value'
						: secretConfig.ref;
			throw new Error(
				`Failed to resolve secret '${secretName}' for zone '${zone.id}' from '${sourceReference}': ${message}`,
				{ cause: error },
			);
		}
	}

	return resolvedSecrets;
}
