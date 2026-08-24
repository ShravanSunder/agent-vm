import { readFile } from 'node:fs/promises';

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
	PortalArtifactReadResultSchema,
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
	PortalListResultSchema,
	PortalSearchRequestSchema,
} from './index.js';

async function readJsonSchemaArtifact(relativePath: string): Promise<unknown> {
	return JSON.parse(await readFile(new URL(relativePath, import.meta.url), 'utf8')) as unknown;
}

describe('portal call surface contracts', () => {
	it('rejects hidden backend and approval fields before dispatch', () => {
		expect(
			PortalCallRequestSchema.safeParse({
				calls: [
					{
						arguments: { title: 'Fix deploy' },
						id: 'call-1',
						namespace: 'github',
						name: 'create_issue',
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
						name: 'create_issue',
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
						name: 'create_issue',
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
			name: 'get_issue',
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
				requests: [{ id: 'item', tools: [{ namespace: 'github', name: 'get_issue' }] }],
			}),
		).toMatchObject({ requestId: 'batch-1' });
		expect(
			PortalCallRequestSchema.parse({
				calls: [{ arguments: {}, id: 'call-1', namespace: 'github', name: 'get_issue' }],
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
						{ arguments: {}, id: 'same', namespace: 'github', name: 'get_issue' },
						{ arguments: {}, id: 'same', namespace: 'github', name: 'get_issue' },
					],
				},
				reservedPayload: {
					calls: [{ arguments: {}, id: '__proto__', namespace: 'github', name: 'get_issue' }],
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
					operationId: 'operation-1',
					outcome: {
						certainty: 'proven',
						kind: 'not-dispatched',
						retryClass: 'safe-before-dispatch',
					},
					owningGeneration: 'gateway-generation-1',
					status: 'error',
				},
			],
			ok: false,
		});

		expect(JSON.stringify(result)).not.toContain('approvalToken');
	});

	it('requires represented namespace discovery on successful read results', () => {
		const successfulListItem = {
			id: 'list-1',
			status: 'ok',
			value: {
				namespaceDiscovery: [{ namespace: 'github', summary: 'GitHub repository tools.' }],
				namespaces: ['github'],
				tools: [],
			},
		} as const;

		expect(
			PortalListResultSchema.safeParse({ items: [successfulListItem], ok: true }).success,
		).toBe(true);
		const { namespaceDiscovery: _namespaceDiscovery, ...valueWithoutDiscovery } =
			successfulListItem.value;
		expect(
			PortalListResultSchema.safeParse({
				items: [{ ...successfulListItem, value: valueWithoutDiscovery }],
				ok: true,
			}).success,
		).toBe(false);
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
						name: 'create_issue',
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
						name: 'create_issue',
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
						name: 'create_issue',
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
						name: 'create_issue',
					},
				],
			}).success,
		).toBe(false);
	});

	it('exports useful testing fixtures instead of empty public testing modules', () => {
		expect(createPortalCallRequestFixture()).toMatchObject({
			calls: [{ id: 'call-1', namespace: 'github', name: 'get_issue' }],
		});
		expect(createPortalCallResultFixture()).toMatchObject({
			items: [{ id: 'call-1', status: 'ok' }],
			ok: true,
		});
	});

	it('exports the first-slice public SDK contract surfaces', () => {
		expect(
			CapabilityDescriptorSchema.parse({
				annotations: {},
				inputSchema: { type: 'object' },
				namespace: 'github',
				related: [],
				schemaHint: {
					message: 'Full input schema included.',
					next: 'call_ready',
				},
				name: 'get_issue',
				toolRef: 'github:get_issue',
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
				approvalChallenge: {
					challengeId: '9f9f3b26-f20d-4c63-a1fe-809c2ca1b85f',
					expiresAt: '2026-06-20T20:00:00.000Z',
				},
				error: {
					code: 'approval_required',
					message: 'Ask operator to approve github.create_issue.',
				},
				id: 'call-1',
				operationId: 'operation-1',
				outcome: {
					certainty: 'proven',
					kind: 'not-dispatched',
					retryClass: 'safe-before-dispatch',
				},
				owningGeneration: 'gateway-generation-1',
				status: 'approval_required',
			}),
		).toMatchObject({ status: 'approval_required' });
		expect(
			PortalArtifactReadRequestSchema.parse({
				maxBytes: 1024,
				reference: {
					byteLength: 4096,
					expiresAt: '2026-07-13T20:00:00.000Z',
					fingerprint: `sha256:${'a'.repeat(64)}`,
					id: 'artifact-1',
				},
			}),
		).toMatchObject({ offsetBytes: 0, reference: { id: 'artifact-1' } });
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

	it('exports JSON Schemas matching the reviewed static artifact', async () => {
		const schemas = createPortalCallSurfaceJsonSchemas();

		await expect(
			readJsonSchemaArtifact('./portal-call-json-schema.snapshot.json'),
		).resolves.toEqual(schemas);
		expect(schemas.call).toEqual(z.toJSONSchema(PortalCallRequestSchema, { io: 'input' }));
		expect(JSON.stringify(schemas.call)).toContain('"maxItems":50');
		expect(schemas.describe).toEqual(z.toJSONSchema(PortalDescribeRequestSchema, { io: 'input' }));
		expect(schemas.list).toEqual(z.toJSONSchema(PortalListRequestSchema, { io: 'input' }));
		expect(schemas.search).toEqual(z.toJSONSchema(PortalSearchRequestSchema, { io: 'input' }));
	});

	it('carries an explicit bounded artifact byte range through request and result contracts', () => {
		// Arrange
		const reference = {
			byteLength: 2053,
			expiresAt: '2026-07-13T20:00:00.000Z',
			fingerprint: `sha256:${'b'.repeat(64)}`,
			id: 'artifact-1',
		};
		const readRequest = {
			maxBytes: 1024,
			offsetBytes: 2048,
			reference,
		};
		const readResult = {
			contentBase64: 'Ynl0ZXM=',
			offsetBytes: 2048,
			reference,
			truncated: false,
		};

		// Act
		const parsedRequest = PortalArtifactReadRequestSchema.parse(readRequest);
		const parsedResult = PortalArtifactReadResultSchema.parse(readResult);

		// Assert
		expect(parsedRequest).toEqual(readRequest);
		expect(parsedResult).toEqual(readResult);
		expect(
			PortalArtifactReadRequestSchema.safeParse({ ...readRequest, offsetBytes: -1 }).success,
		).toBe(false);
		expect(
			PortalArtifactReadRequestSchema.safeParse({
				artifactId: reference.id,
				maxBytes: 1024,
				offsetBytes: 0,
			}).success,
		).toBe(false);
	});
});
