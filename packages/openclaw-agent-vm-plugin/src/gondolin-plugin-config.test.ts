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
			zoneId: 'shravan',
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
