export interface ResolvedGondolinPluginConfig {
	readonly controlSession?: {
		readonly bootId: string;
		readonly controllerEpoch: string;
		readonly generationId: string;
		readonly peerId: string;
		readonly verifierPublicKeyPem: string;
	};
	readonly profileId?: string;
	readonly toolPortal?: {
		readonly configDir: string;
	};
	readonly zoneGitToken?: string;
	readonly zoneGitTokenEnv?: string;
	readonly zoneId: string;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveControlSessionConfig(
	config: Record<string, unknown>,
): ResolvedGondolinPluginConfig['controlSession'] {
	const rawControlSession = config.controlSession;
	if (!isObjectRecord(rawControlSession)) {
		return undefined;
	}
	for (const fieldName of [
		'bootId',
		'controllerEpoch',
		'generationId',
		'peerId',
		'verifierPublicKeyPem',
	] as const) {
		if (typeof rawControlSession[fieldName] !== 'string') {
			throw new Error(`Gondolin plugin controlSession requires string ${fieldName}.`);
		}
	}
	const bootId = rawControlSession.bootId;
	const controllerEpoch = rawControlSession.controllerEpoch;
	const generationId = rawControlSession.generationId;
	const peerId = rawControlSession.peerId;
	const verifierPublicKeyPem = rawControlSession.verifierPublicKeyPem;
	if (
		typeof bootId !== 'string' ||
		typeof controllerEpoch !== 'string' ||
		typeof generationId !== 'string' ||
		typeof peerId !== 'string' ||
		typeof verifierPublicKeyPem !== 'string'
	) {
		throw new Error('Gondolin plugin controlSession string fields failed validation.');
	}
	return {
		bootId,
		controllerEpoch,
		generationId,
		peerId,
		verifierPublicKeyPem,
	};
}

function resolveToolPortalConfig(
	config: Record<string, unknown>,
): ResolvedGondolinPluginConfig['toolPortal'] {
	const rawToolPortalConfig = config.toolPortal;
	if (!isObjectRecord(rawToolPortalConfig)) {
		return undefined;
	}
	if (typeof rawToolPortalConfig.configDir !== 'string') {
		throw new Error('Gondolin plugin toolPortal requires string configDir.');
	}
	return { configDir: rawToolPortalConfig.configDir };
}

export function resolveGondolinPluginConfig(
	config: Record<string, unknown>,
): ResolvedGondolinPluginConfig {
	if (typeof config.zoneId !== 'string') {
		throw new Error('Gondolin plugin config requires zoneId.');
	}
	if (config.controllerUrl !== undefined) {
		throw new Error('Gondolin plugin config no longer accepts controllerUrl.');
	}
	const controlSession = resolveControlSessionConfig(config);
	const toolPortal = resolveToolPortalConfig(config);

	return {
		...(controlSession === undefined ? {} : { controlSession }),
		...(typeof config.profileId === 'string' ? { profileId: config.profileId } : {}),
		...(toolPortal === undefined ? {} : { toolPortal }),
		...(typeof config.zoneGitToken === 'string' ? { zoneGitToken: config.zoneGitToken } : {}),
		...(typeof config.zoneGitTokenEnv === 'string'
			? { zoneGitTokenEnv: config.zoneGitTokenEnv }
			: {}),
		zoneId: config.zoneId,
	};
}
