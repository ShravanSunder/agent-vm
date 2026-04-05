export interface ResolvedGondolinPluginConfig {
	readonly controllerUrl: string;
	readonly profileId: string;
	readonly zoneId: string;
}

export function resolveGondolinPluginConfig(
	config: Record<string, unknown>,
): ResolvedGondolinPluginConfig {
	if (typeof config.controllerUrl !== 'string' || typeof config.zoneId !== 'string') {
		throw new Error('Gondolin plugin config requires controllerUrl and zoneId.');
	}

	return {
		controllerUrl: config.controllerUrl,
		profileId: typeof config.profileId === 'string' ? config.profileId : 'standard',
		zoneId: config.zoneId,
	};
}
