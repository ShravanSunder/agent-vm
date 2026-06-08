import { describe, expect, it } from 'vitest';

import { createToolSummary } from './tool-summary.js';

describe('tool summaries', () => {
	it('extracts compact top-level schema shape without embedding full schemas', () => {
		const summary = createToolSummary({
			annotations: { destructiveHint: true, readOnlyHint: false },
			description: 'Create a Linear issue',
			inputSchema: {
				properties: {
					assignee: { type: 'string' },
					title: { description: 'Issue title', minLength: 1, type: 'string' },
				},
				required: ['title'],
				type: 'object',
			},
			namespace: 'linear',
			toolName: 'create_issue',
		});

		expect(summary).toMatchObject({
			description: 'Create a Linear issue',
			input: {
				optional: ['assignee'],
				propertyCount: 2,
				required: ['title'],
				type: 'object',
			},
			namespace: 'linear',
			safety: {
				destructiveHint: true,
				readOnlyHint: false,
			},
			toolName: 'create_issue',
		});
		expect(JSON.stringify(summary)).not.toContain('Issue title');
	});
});
