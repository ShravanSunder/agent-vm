import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
	JsonArrayMaxItems,
	JsonObjectKeyMaxLength,
	JsonObjectMaxEntries,
	JsonStringMaxLength,
} from '../contract-primitives/index.js';
import {
	ApprovalDecisionReferenceSchema,
	ApprovalRequiredResultSchema,
	CapabilityDescriptorSchema,
	PortalAdapterEnvelopeSchema,
	PortalArtifactReadRequestSchema,
	PortalDiagnosticEventSchema,
	TrustedAgentScopeSchema,
} from '../index.js';
import { createPortalCallRequestFixture, createPortalCallResultFixture } from '../testing/index.js';
import {
	createPortalCallSurfaceJsonSchemas,
	PortalCallRequestSchema,
	PortalCallResultSchema,
	PortalDescribeRequestSchema,
	PortalListRequestSchema,
	PortalSearchRequestSchema,
} from './index.js';

describe('portal call surface contracts', () => {
	it('rejects hidden backend and approval fields before dispatch', () => {
		expect(
			PortalCallRequestSchema.safeParse({
				calls: [
					{
						arguments: { title: 'Fix deploy' },
						id: 'call-1',
						namespace: 'github',
						toolName: 'create_issue',
					},
				],
				portalApprovalToken: 'model-visible-token',
			}).success,
		).toBe(false);

		expect(
			PortalCallRequestSchema.safeParse({
				calls: [
					{
						arguments: { title: 'Fix deploy' },
						backendKind: 'ssh-sandbox',
						id: 'call-1',
						namespace: 'github',
						toolName: 'create_issue',
					},
				],
			}).success,
		).toBe(false);

		expect(
			PortalCallResultSchema.safeParse({
				items: [
					{
						executionFingerprint: 'hidden',
						id: 'call-1',
						status: 'ok',
						value: { issue: 123 },
					},
				],
				ok: true,
			}).success,
		).toBe(false);
	});

	it('requires call arguments to be JSON objects', () => {
		expect(
			PortalCallRequestSchema.safeParse({
				calls: [
					{
						arguments: ['not-object'],
						id: 'call-1',
						namespace: 'github',
						toolName: 'create_issue',
					},
				],
			}).success,
		).toBe(false);
	});

	it('accepts request ids and rejects oversized batches across every operation', () => {
		const requests = Array.from({ length: 51 }, (_, index) => ({ id: `item-${index}` }));
		const calls = Array.from({ length: 51 }, (_, index) => ({
			arguments: {},
			id: `call-${index}`,
			namespace: 'github',
			toolName: 'get_issue',
		}));

		expect(
			PortalListRequestSchema.parse({ requestId: 'batch-1', requests: [{ id: 'item' }] }),
		).toMatchObject({ requestId: 'batch-1' });
		expect(
			PortalSearchRequestSchema.parse({ requestId: 'batch-1', requests: [{ id: 'item' }] }),
		).toMatchObject({ requestId: 'batch-1' });
		expect(
			PortalDescribeRequestSchema.parse({
				requestId: 'batch-1',
				requests: [{ id: 'item', tools: [{ namespace: 'github', toolName: 'get_issue' }] }],
			}),
		).toMatchObject({ requestId: 'batch-1' });
		expect(
			PortalCallRequestSchema.parse({
				calls: [{ arguments: {}, id: 'call-1', namespace: 'github', toolName: 'get_issue' }],
				requestId: 'batch-1',
			}),
		).toMatchObject({ requestId: 'batch-1' });

		expect(PortalListRequestSchema.safeParse({ requests }).success).toBe(false);
		expect(PortalSearchRequestSchema.safeParse({ requests }).success).toBe(false);
		expect(PortalDescribeRequestSchema.safeParse({ requests }).success).toBe(false);
		expect(PortalCallRequestSchema.safeParse({ calls }).success).toBe(false);
	});

	it('rejects duplicate and reserved item ids across every batch request', () => {
		for (const { duplicatePayload, reservedPayload, schema } of [
			{
				duplicatePayload: { requests: [{ id: 'same' }, { id: 'same' }] },
				reservedPayload: { requests: [{ id: '__proto__' }] },
				schema: PortalListRequestSchema,
			},
			{
				duplicatePayload: { requests: [{ id: 'same' }, { id: 'same' }] },
				reservedPayload: { requests: [{ id: '__proto__' }] },
				schema: PortalSearchRequestSchema,
			},
			{
				duplicatePayload: { requests: [{ id: 'same' }, { id: 'same' }] },
				reservedPayload: { requests: [{ id: '__proto__' }] },
				schema: PortalDescribeRequestSchema,
			},
			{
				duplicatePayload: {
					calls: [
						{ arguments: {}, id: 'same', namespace: 'github', toolName: 'get_issue' },
						{ arguments: {}, id: 'same', namespace: 'github', toolName: 'get_issue' },
					],
				},
				reservedPayload: {
					calls: [{ arguments: {}, id: '__proto__', namespace: 'github', toolName: 'get_issue' }],
				},
				schema: PortalCallRequestSchema,
			},
		]) {
			expect(schema.safeParse(duplicatePayload).success).toBe(false);
			expect(schema.safeParse(reservedPayload).success).toBe(false);
		}
	});

	it('parses approval-required item errors without exposing approval tokens', () => {
		const result = PortalCallResultSchema.parse({
			items: [
				{
					error: {
						code: 'approval_required',
						message: 'Ask operator to approve github.create_issue.',
						safeDiagnostic: {
							code: 'approval_required',
							level: 'warn',
							safeMessage: 'Operator approval is required.',
						},
					},
					id: 'call-1',
					status: 'error',
				},
			],
			ok: false,
		});

		expect(JSON.stringify(result)).not.toContain('approvalToken');
	});

	it('rejects unsafe error codes, long messages, and inconsistent batch status', () => {
		expect(
			PortalCallResultSchema.safeParse({
				items: [
					{
						error: {
							code: 'raw_provider_secret_error',
							message: 'Nope',
						},
						id: 'call-1',
						status: 'error',
					},
				],
				ok: false,
			}).success,
		).toBe(false);
		expect(
			PortalCallResultSchema.safeParse({
				items: [
					{
						error: {
							code: 'execution_failed',
							message: 'x'.repeat(501),
						},
						id: 'call-1',
						status: 'error',
					},
				],
				ok: false,
			}).success,
		).toBe(false);
		expect(
			PortalCallResultSchema.safeParse({
				items: [
					{
						error: {
							code: 'execution_failed',
							message: 'Failed safely.',
						},
						id: 'call-1',
						status: 'error',
					},
				],
				ok: true,
			}).success,
		).toBe(false);
	});

	it('caps recursive JSON payload size before portal dispatch', () => {
		expect(
			PortalCallRequestSchema.safeParse({
				calls: [
					{
						arguments: { body: 'x'.repeat(JsonStringMaxLength + 1) },
						id: 'call-1',
						namespace: 'github',
						toolName: 'create_issue',
					},
				],
			}).success,
		).toBe(false);
		expect(
			PortalCallRequestSchema.safeParse({
				calls: [
					{
						arguments: { items: Array.from({ length: JsonArrayMaxItems + 1 }, () => null) },
						id: 'call-1',
						namespace: 'github',
						toolName: 'create_issue',
					},
				],
			}).success,
		).toBe(false);
		expect(
			PortalCallRequestSchema.safeParse({
				calls: [
					{
						arguments: Object.fromEntries(
							Array.from({ length: JsonObjectMaxEntries + 1 }, (_, index) => [
								`key-${index}`,
								null,
							]),
						),
						id: 'call-1',
						namespace: 'github',
						toolName: 'create_issue',
					},
				],
			}).success,
		).toBe(false);
		expect(
			PortalCallRequestSchema.safeParse({
				calls: [
					{
						arguments: { ['x'.repeat(JsonObjectKeyMaxLength + 1)]: null },
						id: 'call-1',
						namespace: 'github',
						toolName: 'create_issue',
					},
				],
			}).success,
		).toBe(false);
	});

	it('exports useful testing fixtures instead of empty public testing modules', () => {
		expect(createPortalCallRequestFixture()).toMatchObject({
			calls: [{ id: 'call-1', namespace: 'github', toolName: 'get_issue' }],
		});
		expect(createPortalCallResultFixture()).toMatchObject({
			items: [{ id: 'call-1', status: 'ok' }],
			ok: true,
		});
	});

	it('exports the first-slice public SDK contract surfaces', () => {
		expect(
			CapabilityDescriptorSchema.parse({
				approval: 'not_required',
				description: 'Read GitHub issue metadata.',
				inputJsonSchema: { type: 'object' },
				name: 'get_issue',
				namespace: 'github',
				result: {
					canReturnArtifacts: false,
					canStream: false,
					kind: 'json',
					truncation: 'possible',
				},
				safeCallingHints: [{ code: 'read_only', message: 'No external write.' }],
				title: 'Get Issue',
			}),
		).toMatchObject({ namespace: 'github' });
		expect(
			TrustedAgentScopeSchema.parse({
				agentId: 'agent-a',
				profileId: 'code-builder',
				source: 'tool-portal',
			}),
		).toMatchObject({ agentId: 'agent-a' });
		expect(
			PortalAdapterEnvelopeSchema.parse({
				adapter: 'mcp-provider',
				auditCorrelationId: 'audit-1',
				trustedScope: {
					agentId: 'agent-a',
					profileId: 'code-builder',
					source: 'tool-portal',
				},
			}),
		).toMatchObject({ adapter: 'mcp-provider' });
		expect(
			ApprovalDecisionReferenceSchema.parse({
				approvalId: 'approval-1',
				callId: 'call-1',
				expiresAt: '2026-06-20T20:00:00.000Z',
				status: 'approved',
			}),
		).toMatchObject({ status: 'approved' });
		expect(
			ApprovalRequiredResultSchema.parse({
				error: {
					code: 'approval_required',
					message: 'Ask operator to approve github.create_issue.',
				},
				id: 'call-1',
				status: 'error',
			}),
		).toMatchObject({ status: 'error' });
		expect(
			PortalArtifactReadRequestSchema.parse({
				artifactId: 'artifact-1',
				maxBytes: 1024,
			}),
		).toMatchObject({ artifactId: 'artifact-1' });
		expect(
			PortalDiagnosticEventSchema.parse({
				diagnostic: {
					code: 'execution_failed',
					level: 'error',
					safeMessage: 'Execution failed.',
				},
				id: 'event-1',
				kind: 'diagnostic',
			}),
		).toMatchObject({ kind: 'diagnostic' });
	});

	it('generates JSON Schema from the Zod request contracts', () => {
		const schemas = createPortalCallSurfaceJsonSchemas();

		expect(schemas.call).toEqual(z.toJSONSchema(PortalCallRequestSchema, { io: 'input' }));
		expect(JSON.stringify(schemas.call)).toContain('"maxItems":50');
		expect(schemas.describe).toEqual(z.toJSONSchema(PortalDescribeRequestSchema, { io: 'input' }));
		expect(schemas.list).toEqual(z.toJSONSchema(PortalListRequestSchema, { io: 'input' }));
		expect(schemas.search).toEqual(z.toJSONSchema(PortalSearchRequestSchema, { io: 'input' }));
	});
});
