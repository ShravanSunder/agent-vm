import fs from 'node:fs/promises';

import type { SystemConfig } from '../config/system-config.js';

export async function runControllerDestroy(
	options: {
		readonly purge: boolean;
		readonly systemConfig: SystemConfig;
		readonly zoneId: string;
	},
	dependencies: {
		readonly releaseZoneLeases: (zoneId: string) => Promise<void>;
		readonly stopGatewayZone: (zoneId: string) => Promise<void>;
	},
): Promise<{
	readonly ok: true;
	readonly purged: boolean;
	readonly zoneId: string;
}> {
	const zone = options.systemConfig.zones.find(
		(candidateZone) => candidateZone.id === options.zoneId,
	);
	if (!zone) {
		throw new Error(`Unknown zone '${options.zoneId}'.`);
	}

	await dependencies.stopGatewayZone(options.zoneId);
	await dependencies.releaseZoneLeases(options.zoneId);

	if (options.purge) {
		await fs.rm(zone.gateway.stateDir, { force: true, recursive: true });
		await fs.rm(zone.gateway.workspaceDir, { force: true, recursive: true });
	}

	return {
		ok: true,
		purged: options.purge,
		zoneId: options.zoneId,
	};
}
