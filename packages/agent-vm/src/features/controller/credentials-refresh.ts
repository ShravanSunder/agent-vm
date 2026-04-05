export async function runControllerCredentialsRefresh(
	options: {
		readonly zoneId: string;
	},
	dependencies: {
		readonly refreshZoneSecrets: (zoneId: string) => Promise<void>;
		readonly restartGatewayZone: (zoneId: string) => Promise<void>;
	},
): Promise<{
	readonly ok: true;
	readonly zoneId: string;
}> {
	await dependencies.refreshZoneSecrets(options.zoneId);
	await dependencies.restartGatewayZone(options.zoneId);

	return {
		ok: true,
		zoneId: options.zoneId,
	};
}
