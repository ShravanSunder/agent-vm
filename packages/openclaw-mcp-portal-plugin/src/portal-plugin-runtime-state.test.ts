import { describe, expect, it, vi } from 'vitest';

import { createPortalPluginRuntimeState } from './portal-plugin-runtime-state.js';

describe('createPortalPluginRuntimeState', () => {
	it('loads portal config from the conventional file once', async () => {
		const loadPortalConfig = vi.fn(async () => ({
			agents: {},
			profiles: { default: {} },
			schemaVersion: 1 as const,
		}));
		const state = createPortalPluginRuntimeState({
			configDir: '/config/gateways/sunclaw',
			loadPortalConfig,
		});

		await expect(state.loadPortalConfig()).resolves.toMatchObject({ schemaVersion: 1 });
		await state.loadPortalConfig();

		expect(loadPortalConfig).toHaveBeenCalledTimes(1);
		expect(loadPortalConfig).toHaveBeenCalledWith(
			'/config/gateways/sunclaw/mcp-portal.config.jsonc',
		);
	});

	it('retries config loading after a rejected load', async () => {
		const loadPortalConfig = vi
			.fn()
			.mockRejectedValueOnce(new Error('temporary config read failure'))
			.mockResolvedValueOnce({
				agents: {},
				profiles: { default: {} },
				schemaVersion: 1 as const,
			});
		const state = createPortalPluginRuntimeState({
			configDir: '/config/gateways/sunclaw',
			loadPortalConfig,
		});

		await expect(state.loadPortalConfig()).rejects.toThrow(/temporary config/u);
		await expect(state.loadPortalConfig()).resolves.toMatchObject({ schemaVersion: 1 });

		expect(loadPortalConfig).toHaveBeenCalledTimes(2);
	});

	it('tracks fatal portal availability separately from config loading', () => {
		const state = createPortalPluginRuntimeState({ configDir: '/config' });

		expect(state.getPortalUnavailableReason()).toBeNull();
		state.markPortalUnavailable('backoff-exhausted');
		expect(state.getPortalUnavailableReason()).toBe('backoff-exhausted');
		state.markPortalAvailable();
		expect(state.getPortalUnavailableReason()).toBeNull();
	});
});
