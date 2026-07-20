import { readFile } from 'node:fs/promises';

import { parseDocument } from 'yaml';

export const managedHermesToolPortalPluginName = 'agent-vm-tool-portal';

export interface HermesManagedConfiguration {
	readonly source: string;
	readonly value: Readonly<Record<string, unknown>>;
}

class HermesManagedConfigurationError extends Error {}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireStringArray(value: unknown, fieldPath: string): readonly string[] {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
		throw new HermesManagedConfigurationError(
			`Hermes managed config '${fieldPath}' must be a string array.`,
		);
	}
	return value;
}

export function parseHermesManagedConfiguration(
	configurationSource: string,
): HermesManagedConfiguration {
	const document = parseDocument(configurationSource);
	if (document.errors.length > 0 || document.warnings.length > 0) {
		throw new HermesManagedConfigurationError('Hermes managed config is invalid YAML.');
	}
	let configuration: unknown;
	try {
		configuration = document.toJS({ maxAliasCount: 50 });
	} catch {
		throw new HermesManagedConfigurationError('Hermes managed config is invalid YAML.');
	}
	if (!isObjectRecord(configuration)) {
		throw new HermesManagedConfigurationError('Hermes managed config must be an object.');
	}
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

export async function loadHermesManagedConfiguration(
	configurationPath: string,
): Promise<HermesManagedConfiguration> {
	let configurationSource: string;
	try {
		configurationSource = await readFile(configurationPath, 'utf8');
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to read Hermes managed config '${configurationPath}': ${message}`, {
			cause: error,
		});
	}
	try {
		return parseHermesManagedConfiguration(configurationSource);
	} catch (error: unknown) {
		const safeDetail =
			error instanceof HermesManagedConfigurationError ? `: ${error.message}` : '.';
		// oxlint-disable-next-line eslint/preserve-caught-error -- the parser error can contain authored secret-bearing source excerpts.
		throw new Error(`Invalid Hermes managed config '${configurationPath}'${safeDetail}`);
	}
}
