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
});
