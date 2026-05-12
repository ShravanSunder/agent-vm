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

	it('rejects model-visible server identity and auth metadata', () => {
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
						headers: {
							Authorization: 'Bearer secret',
						},
					},
				},
				namespace: 'linear',
				toolName: 'create_issue',
			}),
		).toThrow(/headers/);

		expect(() =>
			portalToolRecordSchema.parse({
				inputSchema: { type: 'object' },
				metadata: {
					examples: [{ token: 'secret' }],
				},
				namespace: 'linear',
				toolName: 'create_issue',
			}),
		).toThrow(/token/);

		expect(() =>
			portalToolRecordSchema.parse({
				inputSchema: { type: 'object' },
				metadata: {
					upstream: {
						Headers: {
							AgentId: 'agent-secret',
							SessionId: 'session-secret',
						},
					},
				},
				namespace: 'linear',
				toolName: 'create_issue',
			}),
		).toThrow(/Headers/);
	});
});
