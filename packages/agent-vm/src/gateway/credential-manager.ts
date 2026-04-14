import type { SecretRef, SecretResolver } from '@shravansunder/gondolin-core';

import type { SystemConfig } from '../config/system-config.js';

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

	const resolvedRefs: Record<string, SecretRef> = {};
	for (const [secretName, secretConfig] of Object.entries(zone.secrets)) {
		resolvedRefs[secretName] =
			secretConfig.source === 'environment'
				? {
						ref: secretConfig.envVar,
						source: 'environment',
					}
				: {
						ref: secretConfig.ref,
						source: '1password',
					};
	}

	return await options.secretResolver.resolveAll(resolvedRefs);
}
