import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { parsePortalConfig } from './portal-config.js';

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
	it('requires an explicit managed config dir', () => {
		expect(() => parsePortalConfig({})).toThrow();
	});

	it('accepts explicit config dir', () => {
		expect(
			parsePortalConfig({
				configDir: '/config/gateways/sunclaw',
			}),
		).toEqual({
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

		expect(Object.keys(manifest.configSchema.properties).toSorted()).toEqual(['configDir']);
	});
});
