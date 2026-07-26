import { describe, expect, it } from 'vitest';

import {
	managedHermesToolPortalPluginName,
	parseHermesManagedConfiguration,
} from './hermes-managed-configuration.js';

describe('Hermes managed configuration', () => {
	it('preserves authored process-wide configuration while requiring the managed plugin', () => {
		const configuration = parseHermesManagedConfiguration(`
model:
  default: provider/model
plugins:
  enabled:
    - ${managedHermesToolPortalPluginName}
    - operator-plugin
  disabled:
    - retired-plugin
`);

		expect(configuration).toEqual({
			source: expect.stringContaining('operator-plugin'),
			value: {
				model: { default: 'provider/model' },
				plugins: {
					disabled: ['retired-plugin'],
					enabled: [managedHermesToolPortalPluginName, 'operator-plugin'],
				},
			},
		});
	});

	it.each([
		['missing plugins policy', 'model: {}', /complete 'plugins' policy/u],
		['missing enabled list', 'plugins:\n  disabled: []', /plugins.enabled/u],
		[
			'missing disabled list',
			`plugins:\n  enabled: [${managedHermesToolPortalPluginName}]`,
			/plugins.disabled/u,
		],
		['plugin not enabled', 'plugins:\n  enabled: []\n  disabled: []', /must enable/u],
		[
			'plugin explicitly disabled',
			`plugins:\n  enabled: [${managedHermesToolPortalPluginName}]\n  disabled: [${managedHermesToolPortalPluginName}]`,
			/must not disable/u,
		],
		['malformed YAML', 'plugins: [', /invalid YAML/u],
		[
			'unsupported YAML tag',
			`plugins:\n  enabled: [${managedHermesToolPortalPluginName}]\n  disabled: []\ncustom: !unsupported value`,
			/invalid YAML/u,
		],
	] as const)('rejects %s', (_caseName, configurationSource, expectedMessage) => {
		expect(() => parseHermesManagedConfiguration(configurationSource)).toThrow(expectedMessage);
	});

	it('does not include malformed authored values in parser errors', () => {
		const secretCanary = 'hermes-config-secret-canary';

		let thrownError: unknown;
		try {
			parseHermesManagedConfiguration(`plugins: [${secretCanary}`);
		} catch (error: unknown) {
			thrownError = error;
		}

		expect(thrownError).toBeInstanceOf(Error);
		expect((thrownError as Error).message).not.toContain(secretCanary);
	});

	it('does not include alias-conversion values in parser errors', () => {
		const opaqueMarker = 'opaque-alias-marker';
		const repeatedAliases = Array.from({ length: 51 }, () => '*policy').join(', ');

		expect(() =>
			parseHermesManagedConfiguration(`
plugins:
  enabled: [${managedHermesToolPortalPluginName}]
  disabled: []
policy: &policy
  marker: ${opaqueMarker}
aliases: [${repeatedAliases}]
`),
		).toThrow('invalid YAML');
		try {
			parseHermesManagedConfiguration(`
plugins:
  enabled: [${managedHermesToolPortalPluginName}]
  disabled: []
policy: &policy
  marker: ${opaqueMarker}
aliases: [${repeatedAliases}]
`);
		} catch (error: unknown) {
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).not.toContain(opaqueMarker);
		}
	});

	it.each([
		[
			'credential field',
			'providers:\n  primary:\n    api_key: opaque-marker',
			/credential field 'api_key'/u,
		],
		[
			'credential environment reference',
			'providers:\n  primary:\n    key_env: OPAQUE_ENV_NAME',
			/credential field 'key_env'/u,
		],
		[
			'extra headers',
			'providers:\n  primary:\n    extra_headers:\n      Authorization: opaque-marker',
			/extra_headers/u,
		],
		['Discord enablement', 'platforms:\n  discord:\n    enabled: true', /Discord enablement/u],
		['port-binding platform', 'platforms:\n  webhook: {}', /port-binding platform 'webhook'/u],
		['native secret sources', 'secrets: {}', /native secrets/u],
	] as const)(
		'rejects %s without exposing the authored value',
		(_caseName, forbiddenPolicy, expectedMessage) => {
			const opaqueMarker = 'opaque-marker';
			const configurationSource = `
plugins:
  enabled: [${managedHermesToolPortalPluginName}]
  disabled: []
${forbiddenPolicy}
`;

			let thrownError: unknown;
			try {
				parseHermesManagedConfiguration(configurationSource);
			} catch (error: unknown) {
				thrownError = error;
			}

			expect(thrownError).toBeInstanceOf(Error);
			expect((thrownError as Error).message).toMatch(expectedMessage);
			expect((thrownError as Error).message).not.toContain(opaqueMarker);
			expect((thrownError as Error).message).not.toContain('OPAQUE_ENV_NAME');
		},
	);

	it.each([
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
	] as const)('rejects non-empty exact credential field %s', (fieldName) => {
		expect(() =>
			parseHermesManagedConfiguration(`
plugins:
  enabled: [${managedHermesToolPortalPluginName}]
  disabled: []
provider:
  ${fieldName}: opaque-marker
`),
		).toThrow(`credential field '${fieldName}'`);
	});

	it.each([
		['discord.enabled', 'discord:\n  enabled: true'],
		['platforms.discord.enabled', 'platforms:\n  discord:\n    enabled: true'],
		[
			'gateway.platforms.discord.enabled',
			'gateway:\n  platforms:\n    discord:\n      enabled: true',
		],
	] as const)('rejects explicit Discord enablement at %s', (_path, forbiddenPolicy) => {
		expect(() =>
			parseHermesManagedConfiguration(`
plugins:
  enabled: [${managedHermesToolPortalPluginName}]
  disabled: []
${forbiddenPolicy}
`),
		).toThrow('Discord enablement');
	});

	it.each([
		'webhook',
		'api_server',
		'msgraph_webhook',
		'feishu',
		'wecom_callback',
		'bluebubbles',
		'sms',
		'whatsapp_cloud',
		'line',
	] as const)('rejects port-binding platform %s', (platformName) => {
		expect(() =>
			parseHermesManagedConfiguration(`
plugins:
  enabled: [${managedHermesToolPortalPluginName}]
  disabled: []
platforms:
  ${platformName}: {}
`),
		).toThrow(`port-binding platform '${platformName}'`);
	});

	it.each([
		['top-level', 'api_server: {}'],
		['platforms', 'platforms:\n  api_server: {}'],
		['gateway.platforms', 'gateway:\n  platforms:\n    api_server: {}'],
	] as const)('rejects port-binding presence under %s', (_location, forbiddenPolicy) => {
		expect(() =>
			parseHermesManagedConfiguration(`
plugins:
  enabled: [${managedHermesToolPortalPluginName}]
  disabled: []
${forbiddenPolicy}
`),
		).toThrow("port-binding platform 'api_server'");
	});
});
