import { describe, expect, it } from 'vitest';

import { resolveGondolinPluginConfig } from './gondolin-plugin-config.js';

describe('resolveGondolinPluginConfig', () => {
	it('parses the controller url and zone id from plugin config', () => {
		expect(
			resolveGondolinPluginConfig({
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId: 'shravan',
			}),
		).toEqual({
			controllerUrl: 'http://controller.vm.host:18800',
			profileId: 'standard',
			zoneId: 'shravan',
		});
	});

	it('uses a custom profileId when provided', () => {
		expect(
			resolveGondolinPluginConfig({
				controllerUrl: 'http://controller.vm.host:18800',
				profileId: 'heavy',
				zoneId: 'shravan-lab',
			}),
		).toEqual({
			controllerUrl: 'http://controller.vm.host:18800',
			profileId: 'heavy',
			zoneId: 'shravan-lab',
		});
	});

	it('throws when controllerUrl is missing', () => {
		expect(() => resolveGondolinPluginConfig({ zoneId: 'shravan' })).toThrow(
			'Gondolin plugin config requires controllerUrl and zoneId.',
		);
	});

	it('throws when zoneId is missing', () => {
		expect(() =>
			resolveGondolinPluginConfig({ controllerUrl: 'http://controller.vm.host:18800' }),
		).toThrow('Gondolin plugin config requires controllerUrl and zoneId.');
	});
});
