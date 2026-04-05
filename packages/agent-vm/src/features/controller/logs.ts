export async function runControllerLogs(
	options: {
		readonly zoneId: string;
	},
	dependencies: {
		readonly readGatewayLogs: (zoneId: string) => Promise<string>;
	},
): Promise<{
	readonly output: string;
	readonly zoneId: string;
}> {
	return {
		output: await dependencies.readGatewayLogs(options.zoneId),
		zoneId: options.zoneId,
	};
}
