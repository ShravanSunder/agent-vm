import { describe, expect, it, vi } from 'vitest';

import { createGondolinPlugin } from './plugin.js';

describe('createGondolinPlugin', () => {
	it('registers the gondolin backend when OpenClaw loads the plugin in full mode', () => {
		const registerSandboxBackend = vi.fn();
		const plugin = createGondolinPlugin({
			registerSandboxBackend,
		});

		plugin.register({
			pluginConfig: {
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId: 'shravan',
			},
			registrationMode: 'full',
		});

		expect(registerSandboxBackend).toHaveBeenCalledWith(
			'gondolin',
			expect.objectContaining({
				factory: expect.any(Function),
			}),
		);
	});
});
