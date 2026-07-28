import { describe, expect, it } from 'vitest';

import {
	createGatewayRuntimeAttachmentSnapshot,
	createGatewayRuntimeReadinessSnapshot,
	GatewayRuntimeAttachmentSnapshotSchema,
	GatewayRuntimeFatalEvidenceSchema,
	GatewayRuntimeReadinessSnapshotSchema,
} from './gateway-runtime-readiness-snapshot.js';

const EXPECTED_ATTACHMENT = {
	attachmentGeneration: 7,
	clientKind: 'hermes-managed-plugin',
	configuredAgentIds: ['agent-b', 'agent-a'],
	frameworkEpoch: 'framework-epoch-11',
	gatewayEpoch: 'gateway-epoch-13',
	protocolVersion: 1,
	projectionCohortDigest:
		'projection-cohort:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
	runtimeEpoch: 'runtime-epoch-17',
	schemaVersion: 1,
} as const;

function validReadinessSnapshotInput(): Parameters<
	typeof createGatewayRuntimeReadinessSnapshot
>[0] {
	return {
		controlEndpoint: {
			identity: {
				bootId: 'boot-1',
				controllerEpoch: 'controller-epoch-1',
				generationId: 'generation-1',
				peerId: 'tool-portal-peer-1',
				processEpoch: 'process-epoch-1',
				zoneId: 'zone-a',
			},
			listener: {
				host: '127.0.0.1',
				port: 18_790,
				readyPath: '/gateway-control/ready',
				socketPath: '/gateway-control/socket.io',
			},
		},
		kind: 'tool-portal-role-readiness',
		providerRevision: 'providers-4',
		requiredBackends: {
			readyBackendKinds: ['mcp_provider', 'tool_vm_runner'],
			revision: 'bindings-4',
			status: 'ready',
		},
		semanticRevision: 'semantic-9',
		serviceIdentity: {
			processEpoch: 'process-epoch-1',
			role: 'tool-portal',
			serviceId: 'tool-portal-zone-a',
		},
		snapshotVersion: 1,
		uds: {
			attachment: createGatewayRuntimeAttachmentSnapshot({
				connectionId: '11111111-1111-4111-8111-111111111111',
				expected: EXPECTED_ATTACHMENT,
				observationSequence: 1,
				snapshotVersion: 1,
				status: 'attached',
			}),
			publication: {
				identity: 'managed-plugin-private-uds',
				protocolVersion: 1,
				schemaVersion: 1,
				socketPath: '/run/agent-vm/gateway-runtime/managed-plugin.sock',
				status: 'published',
			},
		},
	};
}

describe('Gateway runtime readiness snapshot contract', () => {
	it('preserves immutable framework-neutral service, control, UDS, and attachment evidence', () => {
		// Arrange / Act
		const snapshot = createGatewayRuntimeReadinessSnapshot(validReadinessSnapshotInput());

		// Assert
		expect(snapshot).toMatchObject({
			kind: 'tool-portal-role-readiness',
			providerRevision: 'providers-4',
			requiredBackends: {
				readyBackendKinds: ['mcp_provider', 'tool_vm_runner'],
				revision: 'bindings-4',
				status: 'ready',
			},
			semanticRevision: 'semantic-9',
			serviceIdentity: { role: 'tool-portal', serviceId: 'tool-portal-zone-a' },
			snapshotVersion: 1,
			uds: {
				attachment: {
					expected: {
						attachmentGeneration: 7,
						clientKind: 'hermes-managed-plugin',
						configuredAgentIds: ['agent-a', 'agent-b'],
						frameworkEpoch: 'framework-epoch-11',
						gatewayEpoch: 'gateway-epoch-13',
						protocolVersion: 1,
						projectionCohortDigest:
							'projection-cohort:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
						runtimeEpoch: 'runtime-epoch-17',
						schemaVersion: 1,
					},
					status: 'attached',
				},
				publication: {
					socketPath: '/run/agent-vm/gateway-runtime/managed-plugin.sock',
					status: 'published',
				},
			},
		});
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.controlEndpoint)).toBe(true);
		expect(Object.isFrozen(snapshot.uds)).toBe(true);
		expect(Object.isFrozen(snapshot.uds.attachment)).toBe(true);
		expect(Object.isFrozen(snapshot.uds.attachment.expected.configuredAgentIds)).toBe(true);
		expect(() =>
			Object.assign(snapshot.uds.attachment.expected, { gatewayEpoch: 'gateway-epoch-stale' }),
		).toThrow(TypeError);
	});

	it('rejects readiness that claims duplicate backend kinds', () => {
		// Arrange
		const validInput = validReadinessSnapshotInput();
		const input = {
			...validInput,
			requiredBackends: {
				...validInput.requiredBackends,
				readyBackendKinds: ['mcp_provider', 'mcp_provider'],
			},
		};

		// Act / Assert
		expect(GatewayRuntimeReadinessSnapshotSchema.safeParse(input).success).toBe(false);
	});

	it('validates bounded fatal evidence shared by both sibling roles', () => {
		// Arrange / Act
		const parsed = GatewayRuntimeFatalEvidenceSchema.parse({
			failureCode: 'process-exited',
			kind: 'fatal',
			observedGatewayEpoch: 'gateway-epoch-13',
			processEpoch: 'process-epoch-1',
			role: 'framework-service',
			schemaVersion: 1,
			serviceId: 'openclaw-zone-a',
		});

		// Assert
		expect(parsed.role).toBe('framework-service');
		expect(
			GatewayRuntimeFatalEvidenceSchema.safeParse({ ...parsed, processEpoch: undefined }).success,
		).toBe(false);
	});

	it('distinguishes UDS publication from accepted current framework attachment', () => {
		// Arrange
		const awaitingInput = validReadinessSnapshotInput();
		const awaitingSnapshot = {
			...awaitingInput,
			uds: {
				...awaitingInput.uds,
				attachment: createGatewayRuntimeAttachmentSnapshot({
					expected: EXPECTED_ATTACHMENT,
					observationSequence: 0,
					snapshotVersion: 1,
					status: 'awaiting-attachment',
				}),
			},
		};

		// Act
		const parsed = createGatewayRuntimeReadinessSnapshot(awaitingSnapshot);

		// Assert
		expect(parsed.uds.publication.status).toBe('published');
		expect(parsed.uds.attachment.status).toBe('awaiting-attachment');
	});

	it.each([
		['unknown snapshot version', { snapshotVersion: 2 }],
		[
			'service/control process mismatch',
			{ controlEndpoint: { identity: { processEpoch: 'other' } } },
		],
		['aggregate admission claim', { aggregateReady: true }],
		['forbidden PID authority', { pid: 12_345 }],
	])('rejects %s', (_label, patch) => {
		// Arrange
		const input = structuredClone(validReadinessSnapshotInput()) as Record<string, unknown>;
		if ('controlEndpoint' in patch) {
			const controlPatch = patch.controlEndpoint as {
				readonly identity: { readonly processEpoch: string };
			};
			const controlEndpoint = input['controlEndpoint'] as Record<string, unknown>;
			input['controlEndpoint'] = {
				...controlEndpoint,
				identity: {
					...(controlEndpoint['identity'] as Record<string, unknown>),
					...controlPatch.identity,
				},
			};
		} else {
			Object.assign(input, patch);
		}

		// Act
		const result = GatewayRuntimeReadinessSnapshotSchema.safeParse(input);

		// Assert
		expect(result.success).toBe(false);
	});

	it.each([
		['connection on awaiting', { connectionId: '11111111-1111-4111-8111-111111111111' }],
		['missing connection on attached', { connectionId: undefined, status: 'attached' }],
		['duplicate configured agent', { expected: { configuredAgentIds: ['agent-a', 'agent-a'] } }],
	])('rejects invalid attachment lifecycle evidence: %s', (_label, patch) => {
		// Arrange
		const input: Record<string, unknown> = {
			expected: { ...EXPECTED_ATTACHMENT },
			observationSequence: 0,
			snapshotVersion: 1,
			status: 'awaiting-attachment',
		};
		if ('expected' in patch) {
			input['expected'] = { ...EXPECTED_ATTACHMENT, ...patch.expected };
		} else {
			Object.assign(input, patch);
		}

		// Act / Assert
		expect(GatewayRuntimeAttachmentSnapshotSchema.safeParse(input).success).toBe(false);
	});
});
