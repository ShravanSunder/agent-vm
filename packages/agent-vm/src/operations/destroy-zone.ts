import fs from 'node:fs/promises';
import path from 'node:path';

import type { SystemConfig } from '../config/system-config.js';
import { scanLegacyControllerRecordEvidence as scanGatewayStateAuthorityEvidenceDefault } from '../controller/durable-state/legacy-controller-record-evidence.js';

type GatewayStateAuthorityEvidence = Awaited<
	ReturnType<typeof scanGatewayStateAuthorityEvidenceDefault>
>[number];

function formatGatewayStateAuthorityEvidence(evidence: GatewayStateAuthorityEvidence): string {
	return `${evidence.family}:${evidence.kind}:${evidence.absolutePath}`;
}

export async function runControllerDestroy(
	options: {
		readonly purge: boolean;
		readonly systemConfig: SystemConfig;
		readonly zoneId: string;
	},
	dependencies: {
		readonly releaseZoneLeases: (zoneId: string) => Promise<void>;
		readonly scanGatewayStateAuthorityEvidence?: typeof scanGatewayStateAuthorityEvidenceDefault;
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
	const gatewayStateEvidence = await (
		dependencies.scanGatewayStateAuthorityEvidence ?? scanGatewayStateAuthorityEvidenceDefault
	)({ gatewayStateDirectoryPath: path.resolve(zone.gateway.stateDir) });
	if (gatewayStateEvidence.length > 0) {
		throw new Error(
			`Legacy controller record evidence exists under Gateway state for zone '${zone.id}': ${gatewayStateEvidence.map(formatGatewayStateAuthorityEvidence).join('; ')}`,
		);
	}

	await dependencies.stopGatewayZone(options.zoneId);
	await dependencies.releaseZoneLeases(options.zoneId);

	if (options.purge) {
		await fs.rm(zone.gateway.stateDir, { force: true, recursive: true });
		await fs.rm(path.join(options.systemConfig.runtimeDir, 'worker-tasks', zone.id), {
			force: true,
			recursive: true,
		});
		await fs.rm(path.join(options.systemConfig.runtimeDir, 'zones', zone.id), {
			force: true,
			recursive: true,
		});
		if (zone.gateway.type !== 'worker') {
			await fs.rm(zone.gateway.zoneFilesDir, { force: true, recursive: true });
		}
	}

	return {
		ok: true,
		purged: options.purge,
		zoneId: options.zoneId,
	};
}
