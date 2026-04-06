import { describe, expect, it } from 'vitest';

import { resolveGondolinPluginConfig } from './config.js';

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
});
