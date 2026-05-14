import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defaultPortalBinPath, parsePortalConfig } from './portal-config.js';

const pluginManifestSchema = z
	.object({
		configSchema: z
			.object({
				additionalProperties: z.literal(false),
				properties: z.record(z.string(), z.unknown()),
			})
			.passthrough(),
	})
	.passthrough();

describe('portal plugin launch config', () => {
	it('applies subprocess defaults', () => {
		expect(parsePortalConfig({})).toEqual({
			binPath: defaultPortalBinPath,
		});
	});

	it('accepts explicit config dir and bin path', () => {
		expect(
			parsePortalConfig({
				binPath: '/tmp/portal-server',
				configDir: '/config/gateways/sunclaw',
			}),
		).toEqual({
			binPath: '/tmp/portal-server',
			configDir: '/config/gateways/sunclaw',
		});
	});

	it('rejects old embedded access policy config fields', () => {
		expect(() => parsePortalConfig({ enabledNamespacesByAgent: { sun: ['linear'] } })).toThrow();
		expect(() => parsePortalConfig({ port: 18_790 })).toThrow();
	});

	it('keeps the OpenClaw plugin manifest launch-only', async () => {
		const manifestText = await readFile(
			new URL('../openclaw.plugin.json', import.meta.url),
			'utf8',
		);
		const manifest = pluginManifestSchema.parse(JSON.parse(manifestText));

		expect(Object.keys(manifest.configSchema.properties).toSorted()).toEqual([
			'binPath',
			'configDir',
		]);
	});
});
