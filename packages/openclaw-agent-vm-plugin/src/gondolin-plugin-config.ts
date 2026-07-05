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
	readonly zoneId: string;
}

export type GondolinPluginConfigJsonValue =
	| boolean
	| null
	| number
	| string
	| GondolinPluginConfigJsonObject
	| readonly GondolinPluginConfigJsonValue[];

export interface GondolinPluginConfigJsonObject {
	readonly [fieldName: string]: GondolinPluginConfigJsonValue;
}

export type GondolinPluginConfigInput = GondolinPluginConfigJsonObject;

function isConfigObject(
	value: GondolinPluginConfigJsonValue | undefined,
): value is GondolinPluginConfigJsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalConfigObject(options: {
	readonly fieldName: string;
	readonly record: GondolinPluginConfigInput;
}): GondolinPluginConfigJsonObject | undefined {
	if (!Object.hasOwn(options.record, options.fieldName)) {
		return undefined;
	}
	const value = options.record[options.fieldName];
	if (!isConfigObject(value)) {
		throw new Error(`Gondolin plugin ${options.fieldName} must be an object when present.`);
	}
	return value;
}

function assertNoUnknownFields(options: {
	readonly allowedFields: ReadonlySet<string>;
	readonly label: string;
	readonly record: GondolinPluginConfigJsonObject;
}): void {
	for (const fieldName of Object.keys(options.record)) {
		if (!options.allowedFields.has(fieldName)) {
			throw new Error(`Gondolin plugin ${options.label} does not accept field '${fieldName}'.`);
		}
	}
}

function requireNonEmptyString(options: {
	readonly fieldName: string;
	readonly label: string;
	readonly value: GondolinPluginConfigJsonValue | undefined;
}): string {
	if (typeof options.value !== 'string') {
		throw new Error(`Gondolin plugin ${options.label} requires string ${options.fieldName}.`);
	}
	if (options.value.trim() === '') {
		throw new Error(`Gondolin plugin ${options.label} requires non-empty ${options.fieldName}.`);
	}
	return options.value;
}

const rootConfigFields = new Set([
	'controlSession',
	'controllerUrl',
	'profileId',
	'toolPortal',
	'zoneGitToken',
	'zoneGitTokenEnv',
	'zoneId',
]);

const controlSessionConfigFields = new Set([
	'bootId',
	'callerContextProofKey',
	'controllerEpoch',
	'generationId',
	'peerId',
	'verifierPublicKeyPem',
]);

const toolPortalConfigFields = new Set(['configDir']);

function resolveControlSessionConfig(
	config: GondolinPluginConfigInput,
): ResolvedGondolinPluginConfig['controlSession'] {
	const rawControlSession = optionalConfigObject({
		fieldName: 'controlSession',
		record: config,
	});
	if (rawControlSession === undefined) {
		return undefined;
	}
	if (Object.hasOwn(rawControlSession, 'callerContextProofKey')) {
		throw new Error('Gondolin plugin controlSession no longer accepts callerContextProofKey.');
	}
	assertNoUnknownFields({
		allowedFields: controlSessionConfigFields,
		label: 'controlSession',
		record: rawControlSession,
	});
	const bootId = requireNonEmptyString({
		fieldName: 'bootId',
		label: 'controlSession',
		value: rawControlSession.bootId,
	});
	const controllerEpoch = requireNonEmptyString({
		fieldName: 'controllerEpoch',
		label: 'controlSession',
		value: rawControlSession.controllerEpoch,
	});
	const generationId = requireNonEmptyString({
		fieldName: 'generationId',
		label: 'controlSession',
		value: rawControlSession.generationId,
	});
	const peerId = requireNonEmptyString({
		fieldName: 'peerId',
		label: 'controlSession',
		value: rawControlSession.peerId,
	});
	const verifierPublicKeyPem = requireNonEmptyString({
		fieldName: 'verifierPublicKeyPem',
		label: 'controlSession',
		value: rawControlSession.verifierPublicKeyPem,
	});
	return {
		bootId,
		controllerEpoch,
		generationId,
		peerId,
		verifierPublicKeyPem,
	};
}

function resolveToolPortalConfig(
	config: GondolinPluginConfigInput,
): ResolvedGondolinPluginConfig['toolPortal'] {
	const rawToolPortalConfig = optionalConfigObject({
		fieldName: 'toolPortal',
		record: config,
	});
	if (rawToolPortalConfig === undefined) {
		return undefined;
	}
	assertNoUnknownFields({
		allowedFields: toolPortalConfigFields,
		label: 'toolPortal',
		record: rawToolPortalConfig,
	});
	return {
		configDir: requireNonEmptyString({
			fieldName: 'configDir',
			label: 'toolPortal',
			value: rawToolPortalConfig.configDir,
		}),
	};
}

export function resolveGondolinPluginConfig(
	config: GondolinPluginConfigInput,
): ResolvedGondolinPluginConfig {
	if (typeof config.zoneId !== 'string') {
		throw new Error('Gondolin plugin config requires zoneId.');
	}
	if (config.zoneId.trim() === '') {
		throw new Error('Gondolin plugin config requires non-empty zoneId.');
	}
	if (Object.hasOwn(config, 'controllerUrl')) {
		throw new Error('Gondolin plugin config no longer accepts controllerUrl.');
	}
	if (Object.hasOwn(config, 'zoneGitToken') || Object.hasOwn(config, 'zoneGitTokenEnv')) {
		throw new Error('Gondolin plugin config no longer accepts zone git token fields.');
	}
	assertNoUnknownFields({
		allowedFields: rootConfigFields,
		label: 'config',
		record: config,
	});
	const controlSession = resolveControlSessionConfig(config);
	const toolPortal = resolveToolPortalConfig(config);

	return {
		...(controlSession === undefined ? {} : { controlSession }),
		...(config.profileId === undefined
			? {}
			: {
					profileId: requireNonEmptyString({
						fieldName: 'profileId',
						label: 'config',
						value: config.profileId,
					}),
				}),
		...(toolPortal === undefined ? {} : { toolPortal }),
		zoneId: config.zoneId,
	};
}
