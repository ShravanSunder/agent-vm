import { describe, expect, it } from 'vitest';

import { resolveGondolinPluginConfig } from './gondolin-plugin-config.js';

describe('resolveGondolinPluginConfig', () => {
	it('parses the zone id from plugin config', () => {
		expect(
			resolveGondolinPluginConfig({
				profileId: 'gpu',
				zoneId: 'shravan',
			}),
		).toEqual({
			profileId: 'gpu',
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

	it('parses control session config without caller-context proof key material', () => {
		expect(
			resolveGondolinPluginConfig({
				controlSession: {
					bootId: 'boot-a',
					controllerEpoch: 'epoch-a',
					generationId: 'generation-a',
					peerId: 'gateway-shravan',
					verifierPublicKeyPem: 'public-key',
				},
				zoneId: 'shravan',
			}),
		).toEqual({
			controlSession: {
				bootId: 'boot-a',
				controllerEpoch: 'epoch-a',
				generationId: 'generation-a',
				peerId: 'gateway-shravan',
				verifierPublicKeyPem: 'public-key',
			},
			zoneId: 'shravan',
		});
	});

	it('rejects stale caller-context proof key config', () => {
		expect(() =>
			resolveGondolinPluginConfig({
				controlSession: {
					bootId: 'boot-a',
					callerContextProofKey: 'proof-key-that-should-stay-private',
					controllerEpoch: 'epoch-a',
					generationId: 'generation-a',
					peerId: 'gateway-shravan',
					verifierPublicKeyPem: 'public-key',
				},
				zoneId: 'shravan',
			}),
		).toThrow('Gondolin plugin controlSession no longer accepts callerContextProofKey.');
	});

	it('rejects the removed controller url config field', () => {
		expect(() =>
			resolveGondolinPluginConfig({
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId: 'shravan',
			}),
		).toThrow('Gondolin plugin config no longer accepts controllerUrl.');
	});

	it('rejects stale zone-git token config fields', () => {
		expect(() =>
			resolveGondolinPluginConfig({
				zoneGitTokenEnv: 'AGENT_VM_ZONE_GIT_TOKEN',
				zoneId: 'shravan',
			}),
		).toThrow('Gondolin plugin config no longer accepts zone git token fields.');
		expect(() =>
			resolveGondolinPluginConfig({
				zoneGitToken: 'push-token',
				zoneId: 'shravan',
			}),
		).toThrow('Gondolin plugin config no longer accepts zone git token fields.');
	});

	it('throws when zoneId is missing', () => {
		expect(() => resolveGondolinPluginConfig({})).toThrow(
			'Gondolin plugin config requires zoneId.',
		);
	});

	it('throws when string fields are empty', () => {
		expect(() => resolveGondolinPluginConfig({ zoneId: '' })).toThrow(
			'Gondolin plugin config requires non-empty zoneId.',
		);
		expect(() =>
			resolveGondolinPluginConfig({
				profileId: '',
				zoneId: 'shravan',
			}),
		).toThrow('Gondolin plugin config requires non-empty profileId.');
		expect(() =>
			resolveGondolinPluginConfig({
				toolPortal: { configDir: '' },
				zoneId: 'shravan',
			}),
		).toThrow('Gondolin plugin toolPortal requires non-empty configDir.');
		expect(() =>
			resolveGondolinPluginConfig({
				controlSession: {
					bootId: '',
					controllerEpoch: 'epoch-a',
					generationId: 'generation-a',
					peerId: 'gateway-shravan',
					verifierPublicKeyPem: 'public-key',
				},
				zoneId: 'shravan',
			}),
		).toThrow('Gondolin plugin controlSession requires non-empty bootId.');
	});

	it('throws when config objects contain unknown fields', () => {
		expect(() =>
			resolveGondolinPluginConfig({
				extraRoot: true,
				zoneId: 'shravan',
			}),
		).toThrow("Gondolin plugin config does not accept field 'extraRoot'.");
		expect(() =>
			resolveGondolinPluginConfig({
				controlSession: {
					bootId: 'boot-a',
					controllerEpoch: 'epoch-a',
					extraControl: true,
					generationId: 'generation-a',
					peerId: 'gateway-shravan',
					verifierPublicKeyPem: 'public-key',
				},
				zoneId: 'shravan',
			}),
		).toThrow("Gondolin plugin controlSession does not accept field 'extraControl'.");
		expect(() =>
			resolveGondolinPluginConfig({
				toolPortal: {
					configDir: '/home/openclaw/.openclaw/cache/tool-portal-effective',
					extraToolPortal: true,
				},
				zoneId: 'shravan',
			}),
		).toThrow("Gondolin plugin toolPortal does not accept field 'extraToolPortal'.");
	});

	it('throws when Tool Portal config is malformed', () => {
		expect(() =>
			resolveGondolinPluginConfig({
				toolPortal: { configDir: 42 },
				zoneId: 'shravan',
			}),
		).toThrow('Gondolin plugin toolPortal requires string configDir.');
	});

	it.each([
		{ fieldName: 'controlSession', value: true },
		{ fieldName: 'controlSession', value: null },
		{ fieldName: 'controlSession', value: 'control' },
		{ fieldName: 'controlSession', value: ['control'] },
		{ fieldName: 'toolPortal', value: true },
		{ fieldName: 'toolPortal', value: null },
		{ fieldName: 'toolPortal', value: 'portal' },
		{ fieldName: 'toolPortal', value: ['portal'] },
	] satisfies readonly {
		readonly fieldName: 'controlSession' | 'toolPortal';
		readonly value: boolean | null | string | readonly string[];
	}[])('throws when $fieldName is present but not an object', ({ fieldName, value }) => {
		expect(() =>
			resolveGondolinPluginConfig({
				[fieldName]: value,
				zoneId: 'shravan',
			}),
		).toThrow(`Gondolin plugin ${fieldName} must be an object when present.`);
	});
});
