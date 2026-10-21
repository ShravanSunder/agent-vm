import { createCatalogToolPresentationName } from '@agent-collaboration/tool-engine/mcp-gateway';
import { generateTypescriptCatalogArtifact } from '@agent-collaboration/tool-engine/mcp-gateway';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
	compileCatalogTypescriptModules,
	fingerprintCatalogTypescriptInput,
} from '#node-host/catalog-typescript/catalog-typescript-compiler';
import {
	baselineInput,
	baselineBundleJson,
	baselineArtifactSource,
} from '#node-host/test-fixtures/catalog-v2-baseline';
// Oracle copied byte-for-byte from the committed S3a frozen baseline, never regenerated.
describe('frozen compiler v2 baseline', () => {
	it('pins the legacy TypeScript helper artifact source bytes', async () => {
		const tools = baselineInput.tools.map((tool) => ({
			namespace: tool.namespace,
			toolName: tool.name,
			inputSchema: tool.inputSchema,
		}));
		expect(await generateTypescriptCatalogArtifact({ tools })).toBe(baselineArtifactSource);
		expect(await generateTypescriptCatalogArtifact({ tools: tools.toReversed() })).toBe(
			baselineArtifactSource,
		);
	});
	it('pins module sources, manifest, native names, fingerprints, file paths, lengths, hashes and versions', async () => {
		const expected: unknown = JSON.parse(baselineBundleJson);
		expect(await fingerprintCatalogTypescriptInput(baselineInput)).toBe(
			'a61c3ff1d9806028ca41523237939dadc7f1015f03b0e7a9987ee198a9cc8ad3',
		);
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
