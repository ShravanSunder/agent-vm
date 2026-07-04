import { describe, expect, it } from 'vitest';

import { resolveGondolinPluginConfig } from './gondolin-plugin-config.js';

describe('resolveGondolinPluginConfig', () => {
	it('parses the zone id from plugin config', () => {
		expect(
			resolveGondolinPluginConfig({
				profileId: 'gpu',
				zoneGitToken: 'push-token',
				zoneGitTokenEnv: 'AGENT_VM_ZONE_GIT_TOKEN',
				zoneId: 'shravan',
			}),
		).toEqual({
			profileId: 'gpu',
			zoneGitToken: 'push-token',
			zoneGitTokenEnv: 'AGENT_VM_ZONE_GIT_TOKEN',
			zoneId: 'shravan',
		});
	});

	it('does not require the legacy controller url', () => {
		expect(resolveGondolinPluginConfig({ zoneId: 'shravan' })).toEqual({
			zoneId: 'shravan',
		});
	});

	it('parses Tool Portal native tool config', () => {
		expect(
			resolveGondolinPluginConfig({
				toolPortal: { configDir: '/home/openclaw/.openclaw/cache/tool-portal-effective' },
				zoneId: 'shravan',
			}),
		).toEqual({
			toolPortal: { configDir: '/home/openclaw/.openclaw/cache/tool-portal-effective' },
			zoneId: 'shravan',
		});
	});

	it('rejects the removed controller url config field', () => {
		expect(() =>
			resolveGondolinPluginConfig({
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId: 'shravan',
			}),
		).toThrow('Gondolin plugin config no longer accepts controllerUrl.');
	});

	it('throws when zoneId is missing', () => {
		expect(() => resolveGondolinPluginConfig({})).toThrow(
			'Gondolin plugin config requires zoneId.',
		);
	});

	it('throws when Tool Portal config is malformed', () => {
		expect(() =>
			resolveGondolinPluginConfig({
				toolPortal: { configDir: 42 },
				zoneId: 'shravan',
			}),
		).toThrow('Gondolin plugin toolPortal requires string configDir.');
	});
});
