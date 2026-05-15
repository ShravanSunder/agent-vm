import { describe, expect, it } from 'vitest';

import { portalToolRecordSchema } from './catalog-types.js';

describe('portal catalog records', () => {
	it('accepts safe upstream tool metadata and schemas', () => {
		expect(
			portalToolRecordSchema.parse({
				annotations: { destructiveHint: false, readOnlyHint: true },
				description: 'Create an issue',
				inputSchema: {
					properties: { title: { type: 'string' } },
					required: ['title'],
					type: 'object',
				},
				namespace: 'linear',
				toolName: 'create_issue',
			}),
		).toMatchObject({
			namespace: 'linear',
			toolName: 'create_issue',
		});
	});

	it('accepts legitimate tool metadata keys that look like API fields', () => {
		expect(
			portalToolRecordSchema.parse({
				inputSchema: { type: 'object' },
				metadata: {
					examples: [{ token: 'placeholder-token' }],
					upstream: {
						headers: {
							Authorization: 'Bearer EXAMPLE',
						},
					},
				},
				namespace: 'linear',
				toolName: 'create_issue',
			}),
		).toMatchObject({
			metadata: {
				examples: [{ token: 'placeholder-token' }],
			},
		});
	});

	it('rejects model-visible server identity metadata', () => {
		expect(() =>
			portalToolRecordSchema.parse({
				inputSchema: { type: 'object' },
				metadata: {
					bindingId: 'portal-secret',
				},
				namespace: 'linear',
				toolName: 'create_issue',
			}),
		).toThrow(/bindingId/);

		expect(() =>
			portalToolRecordSchema.parse({
				inputSchema: { type: 'object' },
				metadata: {
					upstream: {
						trace: {
							AgentId: 'agent-secret',
							SessionId: 'session-secret',
						},
					},
				},
				namespace: 'linear',
				toolName: 'create_issue',
			}),
		).toThrow(/AgentId/);
	});
});
