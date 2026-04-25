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

export async function resolveZoneSecrets(options: {
	readonly systemConfig: SystemConfig;
	readonly zoneId: string;
	readonly secretResolver: SecretResolver;
}): Promise<Record<string, string>> {
	const zone = findZone(options.systemConfig, options.zoneId);
	if (!zone) {
		throw new Error(`Unknown zone '${options.zoneId}'.`);
	}

	const resolvedSecrets: Record<string, string> = {};
	for (const [secretName, secretConfig] of Object.entries(zone.secrets)) {
		let secretRef: SecretRef;
		switch (secretConfig.source) {
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
				secretConfig.source === 'environment' ? secretConfig.envVar : secretConfig.ref;
			throw new Error(
				`Failed to resolve secret '${secretName}' for zone '${zone.id}' from '${sourceReference}': ${message}`,
				{ cause: error },
			);
		}
	}

	return resolvedSecrets;
}
