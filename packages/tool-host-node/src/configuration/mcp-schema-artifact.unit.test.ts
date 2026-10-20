import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { createMcpConfigSchemaArtifact } from '#node-host/configuration/mcp-schema-artifact';

// Frozen from unchanged config-contracts createConfigContractSchemaArtifacts().mcp
// at baseline 22672ca9, including the existing family id and draft-07 representation.
describe('copied MCP provider schema bytes', () => {
	it('preserves the frozen schema document, id, defaults, transport union and secret reference shapes', async () => {
		const baseline = await readFile(
			new URL('../test-fixtures/mcp-schema-v1-baseline.txt', import.meta.url),
			'utf8',
		);
		expect(`${JSON.stringify(createMcpConfigSchemaArtifact(), null, '\t')}\n`).toBe(baseline);
	});
});
