import type { SecretRef, SecretResolver } from 'gondolin-core';

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
		const ref = secretConfig.ref ?? process.env[`${secretName}_REF`]?.trim();
		if (!ref) {
			throw new Error(
				`Secret '${secretName}' has no ref in config and ${secretName}_REF is not set in environment.`,
			);
		}
		resolvedRefs[secretName] = {
			ref,
			source: secretConfig.source,
		};
	}

	return await options.secretResolver.resolveAll(resolvedRefs);
}
