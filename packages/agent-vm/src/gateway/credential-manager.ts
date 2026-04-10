import type { SecretResolver } from 'gondolin-core';

import type { SystemConfig } from '../controller/system-config.js';

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

	return await options.secretResolver.resolveAll(zone.secrets);
}
