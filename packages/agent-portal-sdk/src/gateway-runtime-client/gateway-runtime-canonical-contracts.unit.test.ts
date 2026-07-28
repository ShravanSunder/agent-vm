import { describe, expect, it } from 'vitest';

import type { PortalListRequest } from '../portal-call-surface/index.js';
import {
	GatewayRuntimeClient,
	type GatewayRuntimeAttachmentMetadata,
	type GatewayRuntimeConnection,
	type GatewayRuntimeTraceContext,
	type GatewayRuntimeTransportFactory,
} from './index.js';

const CURRENT_ATTACHMENT = {
	attachmentGeneration: 3,
	clientKind: 'hermes-managed-plugin',
	configuredAgentIds: ['agent-a', 'agent-b'],
	frameworkEpoch: 'framework-epoch-1',
	gatewayEpoch: 'gateway-epoch-1',
	protocolVersion: 1,
	projectionCohortDigest:
		'projection-cohort:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
	runtimeEpoch: 'runtime-epoch-1',
	schemaVersion: 1,
} satisfies GatewayRuntimeAttachmentMetadata;

const CURRENT_TRUSTED_CONTEXT = {
	principal: {
		agentId: 'agent-a',
		frameworkIdentity: { kind: 'hermes' as const, profileName: 'agent-a-profile' },
		profileAssignmentRevision: 'profile-assignment:agent-a:1',
		toolPortalProfileId: 'profile-a',
	},
};

const PORTAL_LIST_REQUEST = {
	requests: [{ id: 'list-1', limit: 20 }],
} satisfies PortalListRequest;

const SAMPLED_TRACE_CONTEXT = {
	traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
	tracestate: 'vendor=opaque-value,tenant@system=value-2',
} satisfies GatewayRuntimeTraceContext;

const UNSAMPLED_TRACE_CONTEXT = {
	traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00',
} satisfies GatewayRuntimeTraceContext;

const FUTURE_VERSION_TRACE_CONTEXT = {
	traceparent: '01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-03-vendor-extension',
} satisfies GatewayRuntimeTraceContext;

const EMPTY_TRACESTATE_CONTEXT = {
	traceparent: SAMPLED_TRACE_CONTEXT.traceparent,
	tracestate: '',
} satisfies GatewayRuntimeTraceContext;

const OWS_AND_EMPTY_MEMBER_TRACESTATE_CONTEXT = {
	traceparent: SAMPLED_TRACE_CONTEXT.traceparent,
	tracestate: '\tvendor=one,\t, other=two\t',
} satisfies GatewayRuntimeTraceContext;

class RecordingGatewayRuntimeConnection implements GatewayRuntimeConnection {
	readonly handshakes: GatewayRuntimeAttachmentMetadata[] = [];
	readonly requests: Readonly<{ method: string; params: unknown }>[] = [];

	async close(): Promise<void> {}

	async handshake(attachment: GatewayRuntimeAttachmentMetadata): Promise<void> {
		this.handshakes.push(attachment);
	}

	async request(method: string, params: unknown): Promise<unknown> {
		this.requests.push({ method, params });
		return { items: [], ok: true };
	}
}

class RecordingGatewayRuntimeTransportFactory implements GatewayRuntimeTransportFactory {
	readonly connection = new RecordingGatewayRuntimeConnection();
	connectCount = 0;

	async connect(): Promise<GatewayRuntimeConnection> {
		this.connectCount += 1;
		return this.connection;
	}
}

describe('GatewayRuntimeClient canonical contracts', () => {
	it.each([
		['bounded epoch identity', { ...CURRENT_ATTACHMENT, frameworkEpoch: 'x'.repeat(257) }],
		[
			'configured agent count',
			{
				...CURRENT_ATTACHMENT,
				configuredAgentIds: Array.from({ length: 129 }, (_, index) => `agent-${index}`),
			},
		],
		['unknown field', { ...CURRENT_ATTACHMENT, unexpectedField: 'unexpected-value' }],
	] as const)(
		'rejects attachment metadata outside the canonical %s bound',
		(_caseName, attachment) => {
			// Arrange
			const transportFactory = new RecordingGatewayRuntimeTransportFactory();

			// Act
			const constructClient = (): GatewayRuntimeClient =>
				new GatewayRuntimeClient({ attachment, transportFactory });

			// Assert
			expect(constructClient).toThrowError(
				expect.objectContaining({ code: 'invalid-attachment', name: 'GatewayRuntimeClientError' }),
			);
			expect(transportFactory.connectCount).toBe(0);
		},
	);

	it('retains the typed authority-injection classification around canonical parsing', () => {
		// Arrange
		const transportFactory = new RecordingGatewayRuntimeTransportFactory();
		const attachment = { ...CURRENT_ATTACHMENT, surface: 'managed-plugin' };

		// Act
		const constructClient = (): GatewayRuntimeClient =>
			new GatewayRuntimeClient({ attachment, transportFactory });

		// Assert
		expect(constructClient).toThrowError(
			expect.objectContaining({
				code: 'public-authority-injection',
				name: 'GatewayRuntimeClientError',
			}),
		);
		expect(transportFactory.connectCount).toBe(0);
	});

	it.each([
		[
			'bounded identity',
			{
				...CURRENT_TRUSTED_CONTEXT,
				principal: { ...CURRENT_TRUSTED_CONTEXT.principal, agentId: 'x'.repeat(257) },
			},
		],
		[
			'retired environmentScope principal field',
			{
				...CURRENT_TRUSTED_CONTEXT,
				principal: {
					...CURRENT_TRUSTED_CONTEXT.principal,
					environmentScope: 'gateway:zone-a:epoch-1',
				},
			},
		],
		[
			'retired frameworkKind principal field',
			{
				...CURRENT_TRUSTED_CONTEXT,
				principal: {
					...CURRENT_TRUSTED_CONTEXT.principal,
					frameworkKind: 'hermes',
				},
			},
		],
		[
			'retired profileId principal field',
			{
				...CURRENT_TRUSTED_CONTEXT,
				principal: {
					...CURRENT_TRUSTED_CONTEXT.principal,
					profileId: 'profile-a',
				},
			},
		],
		[
			'retired workspaceId principal field',
			{
				...CURRENT_TRUSTED_CONTEXT,
				principal: {
					...CURRENT_TRUSTED_CONTEXT.principal,
					workspaceId: 'workspace-a',
				},
			},
		],
		['unknown field', { ...CURRENT_TRUSTED_CONTEXT, authority: 'client-authored' }],
	] as const)(
		'rejects trusted context with an invalid canonical %s before portal transport',
		async (_caseName, trustedContext) => {
			// Arrange
			const transportFactory = new RecordingGatewayRuntimeTransportFactory();
			const client = new GatewayRuntimeClient({
				attachment: CURRENT_ATTACHMENT,
				transportFactory,
			});
			await client.connect();

			// Act
			const requestAttempt = client.portal.list(PORTAL_LIST_REQUEST, { trustedContext });

			// Assert
			await expect(requestAttempt).rejects.toThrow();
			expect(transportFactory.connection.requests).toEqual([]);
		},
	);

	it('sends the canonical trusted context in the unchanged portal wire envelope', async () => {
		// Arrange
		const transportFactory = new RecordingGatewayRuntimeTransportFactory();
		const client = new GatewayRuntimeClient({
			attachment: CURRENT_ATTACHMENT,
			transportFactory,
		});
		await client.connect();

		// Act
		await client.portal.list(PORTAL_LIST_REQUEST, {
			trustedContext: CURRENT_TRUSTED_CONTEXT,
		});

		// Assert
		expect(transportFactory.connection.requests).toEqual([
			{
				method: 'portal.list',
				params: {
					publicRequest: PORTAL_LIST_REQUEST,
					trustedContext: CURRENT_TRUSTED_CONTEXT,
				},
			},
		]);
	});

	it.each([
		['sampled', SAMPLED_TRACE_CONTEXT],
		['unsampled', UNSAMPLED_TRACE_CONTEXT],
		['future-version', FUTURE_VERSION_TRACE_CONTEXT],
		['empty-tracestate', EMPTY_TRACESTATE_CONTEXT],
		['ows-and-empty-member-tracestate', OWS_AND_EMPTY_MEMBER_TRACESTATE_CONTEXT],
	] as const)(
		'adds canonical %s trace context as private transport metadata',
		async (_caseName, traceContext) => {
			// Arrange
			const transportFactory = new RecordingGatewayRuntimeTransportFactory();
			const client = new GatewayRuntimeClient({
				attachment: CURRENT_ATTACHMENT,
				traceContextProvider: () => traceContext,
				transportFactory,
			});
			await client.connect();

			// Act
			await client.portal.list(PORTAL_LIST_REQUEST, {
				trustedContext: CURRENT_TRUSTED_CONTEXT,
			});

			// Assert
			expect(transportFactory.connection.requests).toEqual([
				{
					method: 'portal.list',
					params: {
						publicRequest: PORTAL_LIST_REQUEST,
						traceContext,
						trustedContext: CURRENT_TRUSTED_CONTEXT,
					},
				},
			]);
			expect(transportFactory.connection.requests[0]?.params).not.toHaveProperty(
				'publicRequest.traceContext',
			);
		},
	);

	it.each([
		['zero trace id', { traceparent: '00-00000000000000000000000000000000-00f067aa0ba902b7-01' }],
		['zero span id', { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01' }],
		['version 00 extension', { traceparent: `${SAMPLED_TRACE_CONTEXT.traceparent}-future` }],
		['uppercase hex', { traceparent: '00-4BF92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' }],
		['malformed flags', { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-0g' }],
		[
			'malformed version',
			{ traceparent: '0g-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' },
		],
		[
			'forbidden version',
			{ traceparent: 'ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' },
		],
		['oversized traceparent', { traceparent: `01-${'a'.repeat(509)}` }],
		[
			'oversized tracestate',
			{ traceparent: SAMPLED_TRACE_CONTEXT.traceparent, tracestate: `vendor=${'a'.repeat(506)}` },
		],
		[
			'duplicate tracestate key',
			{ traceparent: SAMPLED_TRACE_CONTEXT.traceparent, tracestate: 'vendor=one,vendor=two' },
		],
		[
			'digit-starting simple key',
			{ traceparent: SAMPLED_TRACE_CONTEXT.traceparent, tracestate: '1vendor=value' },
		],
		[
			'malformed multi-tenant key',
			{ traceparent: SAMPLED_TRACE_CONTEXT.traceparent, tracestate: 'tenant@1system=value' },
		],
		[
			'multiple tenant delimiters',
			{ traceparent: SAMPLED_TRACE_CONTEXT.traceparent, tracestate: 'tenant@system@extra=value' },
		],
		[
			'too many tracestate members',
			{
				traceparent: SAMPLED_TRACE_CONTEXT.traceparent,
				tracestate: Array.from({ length: 33 }, (_, index) => `v${index}=x`).join(','),
			},
		],
		[
			'uppercase tracestate key',
			{ traceparent: SAMPLED_TRACE_CONTEXT.traceparent, tracestate: 'Vendor=value' },
		],
		[
			'control character in tracestate',
			{ traceparent: SAMPLED_TRACE_CONTEXT.traceparent, tracestate: 'vendor=line\nbreak' },
		],
		[
			'unknown trace field',
			{ traceparent: SAMPLED_TRACE_CONTEXT.traceparent, traceState: 'vendor=value' },
		],
		['baggage', { baggage: 'secret=value', traceparent: SAMPLED_TRACE_CONTEXT.traceparent }],
	] as const)(
		'rejects %s trace context before private transport',
		async (_caseName, traceContext) => {
			// Arrange
			const transportFactory = new RecordingGatewayRuntimeTransportFactory();
			const client = new GatewayRuntimeClient({
				attachment: CURRENT_ATTACHMENT,
				traceContextProvider: () => traceContext,
				transportFactory,
			});
			await client.connect();

			// Act
			const requestAttempt = client.portal.list(PORTAL_LIST_REQUEST, {
				trustedContext: CURRENT_TRUSTED_CONTEXT,
			});

			// Assert
			await expect(requestAttempt).rejects.toThrow();
			expect(transportFactory.connection.requests).toEqual([]);
		},
	);
});
