import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { parseDocument } from 'yaml';

export const managedHermesToolPortalPluginName = 'agent-vm-tool-portal';

const credentialFieldNames: ReadonlySet<string> = new Set([
	'api_key',
	'apiKey',
	'apikey',
	'key_env',
	'keyEnv',
	'api_key_env',
	'apiKeyEnv',
	'key',
	'token',
	'bot_token',
	'auth_token',
	'access_token',
	'refresh_token',
	'id_token',
	'secret',
	'client_secret',
	'clientSecret',
	'app_secret',
	'corp_secret',
	'signing_secret',
	'verification_token',
	'encrypt_key',
	'password',
	'password_hash',
	'passwd',
	'auth',
	'authorization',
	'private_key',
	'bearer',
	'jwt',
] as const);

const portBindingPlatformNames: ReadonlySet<string> = new Set([
	'webhook',
	'api_server',
	'msgraph_webhook',
	'feishu',
	'wecom_callback',
	'bluebubbles',
	'sms',
	'whatsapp_cloud',
	'line',
] as const);

export interface HermesManagedConfiguration {
	readonly source: string;
	readonly value: Readonly<Record<string, unknown>>;
}

class HermesManagedConfigurationError extends Error {}

function isObjectRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyValue(value: unknown): boolean {
	if (value === undefined || value === null) {
		return false;
	}
	if (typeof value === 'string') {
		return value.length > 0;
	}
	if (Array.isArray(value)) {
		return value.length > 0;
	}
	if (isObjectRecord(value)) {
		return Object.keys(value).length > 0;
	}
	return true;
}

function isExplicitlyDisabledPlatformConfiguration(value: unknown): boolean {
	return isObjectRecord(value) && value.enabled === false;
}

function hasExplicitlyDisabledApiServer(configuration: Readonly<Record<string, unknown>>): boolean {
	const gateway = configuration.gateway;
	const candidates = [
		configuration,
		configuration.platforms,
		isObjectRecord(gateway) ? gateway.platforms : undefined,
		gateway,
	];
	return candidates.some(
		(candidate) =>
			isObjectRecord(candidate) && isExplicitlyDisabledPlatformConfiguration(candidate.api_server),
	);
}

function requireStringArray(value: unknown, fieldPath: string): readonly string[] {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
		throw new HermesManagedConfigurationError(
			`Hermes managed config '${fieldPath}' must be a string array.`,
		);
	}
	return value;
}

function parseHermesConfigurationDocument(
	configurationSource: string,
): Readonly<Record<string, unknown>> {
	const document = parseDocument(configurationSource);
	if (document.errors.length > 0 || document.warnings.length > 0) {
		throw new HermesManagedConfigurationError('Hermes configuration is invalid YAML.');
	}
	let configuration: unknown;
	try {
		configuration = document.toJS({ maxAliasCount: 50 });
	} catch {
		throw new HermesManagedConfigurationError('Hermes configuration is invalid YAML.');
	}
	if (!isObjectRecord(configuration)) {
		throw new HermesManagedConfigurationError('Hermes configuration must be a mapping.');
	}
	return configuration;
}

function rejectCredentialFields(value: unknown): void {
	if (Array.isArray(value)) {
		for (const item of value) {
			rejectCredentialFields(item);
		}
		return;
	}
	if (!isObjectRecord(value)) {
		return;
	}
	for (const [fieldName, fieldValue] of Object.entries(value)) {
		if (credentialFieldNames.has(fieldName) && isNonEmptyValue(fieldValue)) {
			throw new HermesManagedConfigurationError(
				`Hermes configuration rejects credential field '${fieldName}'.`,
			);
		}
		if (fieldName === 'extra_headers' && isNonEmptyValue(fieldValue)) {
			throw new HermesManagedConfigurationError('Hermes configuration rejects extra_headers.');
		}
		rejectCredentialFields(fieldValue);
	}
}

function rejectDiscordEnablement(configuration: Readonly<Record<string, unknown>>): void {
	const platforms = configuration.platforms;
	const gateway = configuration.gateway;
	const gatewayPlatforms = isObjectRecord(gateway) ? gateway.platforms : undefined;
	const candidatePlatforms = [configuration, platforms, gatewayPlatforms];
	for (const candidate of candidatePlatforms) {
		if (!isObjectRecord(candidate)) {
			continue;
		}
		const discord = candidate.discord;
		if (isObjectRecord(discord) && Object.hasOwn(discord, 'enabled')) {
			throw new HermesManagedConfigurationError('Hermes configuration rejects Discord enablement.');
		}
	}
}

function rejectPortBindingPlatforms(
	configuration: Readonly<Record<string, unknown>>,
	options: { readonly allowDisabledApiServer: boolean },
): void {
	const gateway = configuration.gateway;
	const candidatePlatforms = [
		configuration,
		configuration.platforms,
		isObjectRecord(gateway) ? gateway.platforms : undefined,
		gateway,
	];
	for (const candidate of candidatePlatforms) {
		if (!isObjectRecord(candidate)) {
			continue;
		}
		for (const platformName of portBindingPlatformNames) {
			if (
				Object.hasOwn(candidate, platformName) &&
				!(
					options.allowDisabledApiServer &&
					platformName === 'api_server' &&
					isExplicitlyDisabledPlatformConfiguration(candidate[platformName])
				)
			) {
				throw new HermesManagedConfigurationError(
					`Hermes configuration rejects port-binding platform '${platformName}'.`,
				);
			}
		}
	}
}

export function validateHermesConfigurationAdmission(
	configurationSource: string,
	options: { readonly allowDisabledApiServer?: boolean } = {},
): Readonly<Record<string, unknown>> {
	const configuration = parseHermesConfigurationDocument(configurationSource);
	if (Object.hasOwn(configuration, 'secrets')) {
		throw new HermesManagedConfigurationError('Hermes configuration rejects native secrets.');
	}
	rejectCredentialFields(configuration);
	rejectDiscordEnablement(configuration);
	rejectPortBindingPlatforms(configuration, {
		allowDisabledApiServer: options.allowDisabledApiServer ?? false,
	});
	return configuration;
}

export function parseHermesManagedConfiguration(
	configurationSource: string,
): HermesManagedConfiguration {
	const configuration = validateHermesConfigurationAdmission(configurationSource);
	const plugins = configuration.plugins;
	if (!isObjectRecord(plugins)) {
		throw new HermesManagedConfigurationError(
			"Hermes managed config must declare the complete 'plugins' policy.",
		);
	}
	const enabledPluginNames = requireStringArray(plugins.enabled, 'plugins.enabled');
	const disabledPluginNames = requireStringArray(plugins.disabled, 'plugins.disabled');
	if (!enabledPluginNames.includes(managedHermesToolPortalPluginName)) {
		throw new HermesManagedConfigurationError(
			`Hermes managed config must enable '${managedHermesToolPortalPluginName}' in plugins.enabled.`,
		);
	}
	if (disabledPluginNames.includes(managedHermesToolPortalPluginName)) {
		throw new HermesManagedConfigurationError(
			`Hermes managed config must not disable '${managedHermesToolPortalPluginName}'.`,
		);
	}
	return Object.freeze({ source: configurationSource, value: Object.freeze(configuration) });
}

async function validateManagedConfigurationPath(configurationPath: string): Promise<void> {
	if (path.basename(configurationPath) !== 'config.yaml') {
		throw new Error('Hermes managed configuration must be named config.yaml.');
	}
	let configurationStatus: Awaited<ReturnType<typeof lstat>>;
	let directoryStatus: Awaited<ReturnType<typeof lstat>>;
	try {
		[configurationStatus, directoryStatus] = await Promise.all([
			lstat(configurationPath),
			lstat(path.dirname(configurationPath)),
		]);
	} catch {
		throw new Error('Hermes managed configuration path is unreadable.');
	}
	if (configurationStatus.isSymbolicLink() || !configurationStatus.isFile()) {
		throw new Error('Hermes managed configuration must be a regular file.');
	}
	if (directoryStatus.isSymbolicLink() || !directoryStatus.isDirectory()) {
		throw new Error('Hermes managed configuration directory must be a real directory.');
	}
	let directoryEntries: readonly string[];
	try {
		directoryEntries = (await readdir(path.dirname(configurationPath))).toSorted();
	} catch {
		throw new Error('Hermes managed configuration directory is unreadable.');
	}
	if (directoryEntries.length !== 1 || directoryEntries[0] !== 'config.yaml') {
		throw new Error('Hermes managed configuration directory must contain only config.yaml.');
	}
}

async function readAndValidateHermesNativeConfigurationFile(
	configurationPath: string,
	options: { readonly allowDisabledApiServer: boolean },
): Promise<Readonly<Record<string, unknown>>> {
	let configurationStatus: Awaited<ReturnType<typeof lstat>>;
	try {
		configurationStatus = await lstat(configurationPath);
	} catch {
		throw new Error('Hermes native configuration is unreadable.');
	}
	if (configurationStatus.isSymbolicLink() || !configurationStatus.isFile()) {
		throw new Error('Hermes native configuration must be a regular file.');
	}
	let configurationSource: string;
	try {
		configurationSource = await readFile(configurationPath, 'utf8');
	} catch {
		throw new Error('Hermes native configuration is unreadable.');
	}
	try {
		return validateHermesConfigurationAdmission(configurationSource, options);
	} catch (error: unknown) {
		const safeDetail =
			error instanceof HermesManagedConfigurationError ? `: ${error.message}` : '.';
		throw new Error(`Invalid Hermes native configuration${safeDetail}`);
	}
}

export async function validateHermesNativeConfigurationFile(
	configurationPath: string,
): Promise<void> {
	await readAndValidateHermesNativeConfigurationFile(configurationPath, {
		allowDisabledApiServer: false,
	});
}

export async function validateHermesNativeProfileConfigurationFile(
	configurationPath: string,
): Promise<void> {
	const configuration = await readAndValidateHermesNativeConfigurationFile(configurationPath, {
		allowDisabledApiServer: true,
	});
	if (!hasExplicitlyDisabledApiServer(configuration)) {
		throw new Error(
			`Managed Hermes named profile config '${configurationPath}' must explicitly disable platforms.api_server.enabled because the default profile owns the shared listener.`,
		);
	}
}

export async function loadHermesManagedConfiguration(
	configurationPath: string,
): Promise<HermesManagedConfiguration> {
	await validateManagedConfigurationPath(configurationPath);
	let configurationSource: string;
	try {
		configurationSource = await readFile(configurationPath, 'utf8');
	} catch {
		throw new Error('Hermes managed configuration is unreadable.');
	}
	try {
		return parseHermesManagedConfiguration(configurationSource);
	} catch (error: unknown) {
		const safeDetail =
			error instanceof HermesManagedConfigurationError ? `: ${error.message}` : '.';
		throw new Error(`Invalid Hermes managed configuration${safeDetail}`);
	}
}
