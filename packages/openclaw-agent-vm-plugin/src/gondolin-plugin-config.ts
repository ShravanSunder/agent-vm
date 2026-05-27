export interface ResolvedGondolinPluginConfig {
	readonly controllerUrl: string;
	readonly gatewayControlLinkMonitor?: {
		readonly baseIntervalMs: number;
		readonly enabled: boolean;
		readonly maxIntervalMs: number;
	};
	readonly profileId?: string;
	readonly zoneGitToken?: string;
	readonly zoneGitTokenEnv?: string;
	readonly zoneId: string;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function resolveGondolinPluginConfig(
	config: Record<string, unknown>,
): ResolvedGondolinPluginConfig {
	if (typeof config.controllerUrl !== 'string' || typeof config.zoneId !== 'string') {
		throw new Error('Gondolin plugin config requires controllerUrl and zoneId.');
	}
	const rawGatewayControlLinkMonitor = config.gatewayControlLinkMonitor;
	const gatewayControlLinkMonitor = isObjectRecord(rawGatewayControlLinkMonitor)
		? {
				baseIntervalMs:
					typeof rawGatewayControlLinkMonitor.baseIntervalMs === 'number'
						? rawGatewayControlLinkMonitor.baseIntervalMs
						: 10_000,
				enabled:
					typeof rawGatewayControlLinkMonitor.enabled === 'boolean'
						? rawGatewayControlLinkMonitor.enabled
						: true,
				maxIntervalMs:
					typeof rawGatewayControlLinkMonitor.maxIntervalMs === 'number'
						? rawGatewayControlLinkMonitor.maxIntervalMs
						: 120_000,
			}
		: undefined;

	return {
		controllerUrl: config.controllerUrl,
		...(gatewayControlLinkMonitor ? { gatewayControlLinkMonitor } : {}),
		...(typeof config.profileId === 'string' ? { profileId: config.profileId } : {}),
		...(typeof config.zoneGitToken === 'string' ? { zoneGitToken: config.zoneGitToken } : {}),
		...(typeof config.zoneGitTokenEnv === 'string'
			? { zoneGitTokenEnv: config.zoneGitTokenEnv }
			: {}),
		zoneId: config.zoneId,
	};
}
