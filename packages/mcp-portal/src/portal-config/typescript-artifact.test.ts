import { describe, expect, it } from 'vitest';

import { generateTypescriptCatalogArtifact } from './typescript-artifact.js';

describe('TypeScript catalog artifact generation', () => {
	it('emits deterministic Zod-from-JSON-Schema helper source without auth material', () => {
		const source = generateTypescriptCatalogArtifact({
			tools: [
				{
					description: 'Create an issue',
					inputSchema: {
						properties: { title: { type: 'string' } },
						required: ['title'],
						type: 'object',
					},
					metadata: { examples: ['safe'] },
					namespace: 'linear',
					toolName: 'create_issue',
				},
			],
		});

		expect(source).toContain('JSON Schema is canonical');
		expect(source).toContain('z.fromJSONSchema');
		expect(source).toMatch(/linearCreateIssue[a-f0-9]{8}Tool/u);
		expect(source).not.toContain('Authorization');
		expect(source).not.toContain('Bearer');
	});

	it('keeps helper constant names unique for sanitized-name collisions', () => {
		const source = generateTypescriptCatalogArtifact({
			tools: [
				{
					inputSchema: { type: 'object' },
					namespace: 'foo-bar',
					toolName: 'a_b',
				},
				{
					inputSchema: { type: 'object' },
					namespace: 'foo_bar',
					toolName: 'a-b',
				},
			],
		});
		const exportNames = [...source.matchAll(/export const ([A-Za-z0-9_]+) =/gu)]
			.map((match) => match[1])
			.filter((exportName) => exportName !== 'portalCatalog');

		expect(exportNames).toHaveLength(2);
		expect(new Set(exportNames)).toHaveProperty('size', 2);
	});
});
