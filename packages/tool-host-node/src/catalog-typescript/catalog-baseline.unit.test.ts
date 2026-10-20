import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createCatalogToolPresentationName } from '#node-host/catalog-typescript/catalog-tool-presentation-name';
import { compileCatalogTypescriptModules } from '#node-host/catalog-typescript/catalog-typescript-compiler';
import { generateTypescriptCatalogArtifact } from '#node-host/configuration/typescript-artifact';
import {
	baselineInput,
	baselineBundleJson,
	baselineArtifactSource,
} from '#node-host/test-fixtures/catalog-v2-baseline';
// Oracle copied byte-for-byte from the committed S3a frozen baseline, never regenerated.
describe('frozen compiler v2 baseline', () => {
	it('pins the legacy TypeScript helper artifact source bytes', () => {
		const tools = baselineInput.tools.map((tool) => ({
			namespace: tool.namespace,
			toolName: tool.name,
			inputSchema: tool.inputSchema,
		}));
		expect(generateTypescriptCatalogArtifact({ tools })).toBe(baselineArtifactSource);
		expect(generateTypescriptCatalogArtifact({ tools: tools.toReversed() })).toBe(
			baselineArtifactSource,
		);
	});
	it('pins module sources, manifest, native names, fingerprints, file paths, lengths, hashes and versions', async () => {
		const expected: unknown = JSON.parse(baselineBundleJson);
		expect(
			z
				.object({
					manifest: z.object({
						generatorVersion: z.literal('2'),
						sdkContractVersion: z.literal('1'),
					}),
				})
				.safeParse(expected).success,
		).toBe(true);
		expect(await compileCatalogTypescriptModules(baselineInput)).toEqual(expected);
		expect(
			await compileCatalogTypescriptModules({ tools: [...baselineInput.tools].toReversed() }),
		).toEqual(expected);
	});
	it('portable native presentation names equal each frozen baseline name', async () => {
		const frozen = z
			.object({
				nativeTools: z.array(
					z.object({ namespace: z.string(), toolName: z.string(), registeredName: z.string() }),
				),
			})
			.parse(JSON.parse(baselineBundleJson));
		const actual = await Promise.all(
			frozen.nativeTools.map(async (tool) =>
				createCatalogToolPresentationName(tool.namespace, tool.toolName),
			),
		);
		expect(actual).toEqual(frozen.nativeTools.map((tool) => tool.registeredName));
	});
});
