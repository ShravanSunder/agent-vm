import fs from 'node:fs/promises';
import path from 'node:path';

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
		await fs.rm(path.join(options.systemConfig.runtimeDir, 'worker-tasks', zone.id), {
			force: true,
			recursive: true,
		});
		await fs.rm(path.join(options.systemConfig.runtimeDir, 'zones', zone.id, 'logs'), {
			force: true,
			recursive: true,
		});
		// Do NOT broaden this to `fs.rm(runtimeDir/zones/<zone>)`.
		// runtimeDir/zones/<zone>/zone-git/ holds the authoritative git store for
		// committed-but-unpushed zone work and is referenced via a `gitdir:` pointer
		// in the backed-up zoneFilesDir/.git. See
		// docs/architecture/storage-model.md "runtimeDir is two lifecycles".
		if (zone.gateway.type === 'openclaw') {
			await fs.rm(zone.gateway.zoneFilesDir, { force: true, recursive: true });
		}
	}

	return {
		ok: true,
		purged: options.purge,
		zoneId: options.zoneId,
	};
}
