export interface ResolvedGondolinPluginConfig {
	readonly controllerUrl: string;
	readonly profileId?: string;
	readonly zoneGitToken?: string;
	readonly zoneGitTokenEnv?: string;
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
		...(typeof config.profileId === 'string' ? { profileId: config.profileId } : {}),
		...(typeof config.zoneGitToken === 'string' ? { zoneGitToken: config.zoneGitToken } : {}),
		...(typeof config.zoneGitTokenEnv === 'string'
			? { zoneGitTokenEnv: config.zoneGitTokenEnv }
			: {}),
		zoneId: config.zoneId,
	};
}
