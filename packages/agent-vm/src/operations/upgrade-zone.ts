import type { SystemConfig } from '../config/system-config.js';

export async function runControllerUpgrade(
	options: {
		readonly systemConfig: SystemConfig;
		readonly zoneId: string;
	},
	dependencies: {
		readonly rebuildGatewayImage: (zoneId: string) => Promise<void>;
		readonly restartGatewayZone: (zoneId: string) => Promise<void>;
		readonly stopGatewayZone: (zoneId: string) => Promise<void>;
	},
): Promise<{
	readonly ok: true;
	readonly zoneId: string;
}> {
	void options.systemConfig;
	await dependencies.rebuildGatewayImage(options.zoneId);
	await dependencies.stopGatewayZone(options.zoneId);
	await dependencies.restartGatewayZone(options.zoneId);

	return {
		ok: true,
		zoneId: options.zoneId,
	};
}
