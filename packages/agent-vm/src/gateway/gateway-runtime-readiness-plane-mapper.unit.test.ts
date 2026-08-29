import {
	createGatewayRuntimeReadinessSnapshot,
	type GatewayRuntimeReadinessSnapshotInput,
} from '@agent-vm/gateway-control-contracts';
import { describe, expect, it } from 'vitest';

import { mapGatewayRuntimeReadinessEvidenceToAdmissionPlanes } from './gateway-runtime-readiness-plane-mapper.js';

function createSnapshotInput(
	attachmentStatus: GatewayRuntimeReadinessSnapshotInput['uds']['attachment']['status'] = 'attached',
): GatewayRuntimeReadinessSnapshotInput {
	const connectionIdentity =
		attachmentStatus === 'attached' || attachmentStatus === 'attachment-lost'
			? { connectionId: '11111111-1111-4111-8111-111111111111' }
			: {};
	return {
		controlEndpoint: {
			identity: {
				bootId: 'boot-1',
				controllerEpoch: 'controller-1',
				generationId: 'gateway-1',
				peerId: 'tool-portal-control',
				processEpoch: 'tool-portal-process-1',
				zoneId: 'zone-a',
			},
			listener: {
				host: '127.0.0.1',
				port: 18_790,
				readyPath: '/__agent-vm/ready',
				socketPath: '/__agent-vm/gateway-control',
			},
		},
		kind: 'tool-portal-role-readiness',
		providerRevision: 'provider-1',
		requiredBackends: {
			readyBackendKinds: ['mcp_provider'],
			revision: 'backends-1',
			status: 'ready',
		},
		semanticRevision: 'semantic-1',
		serviceIdentity: {
			processEpoch: 'tool-portal-process-1',
			role: 'tool-portal',
			serviceId: 'tool-portal-service-1',
		},
		snapshotVersion: 1,
		uds: {
			attachment: {
				...connectionIdentity,
				expected: {
					attachmentGeneration: 1,
					clientKind: 'hermes-managed-plugin',
					configuredAgentIds: ['agent-a'],
					frameworkEpoch: 'framework-1',
					gatewayEpoch: 'gateway-1',
					protocolVersion: 1,
					projectionCohortDigest:
						'projection-cohort:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
					runtimeEpoch: 'runtime-1',
					schemaVersion: 1,
				},
				observationSequence: 1,
				snapshotVersion: 1,
				status: attachmentStatus,
			},
			publication: {
				identity: 'managed-plugin-private-uds',
				protocolVersion: 1,
				schemaVersion: 1,
				socketPath: '/run/agent-vm/gateway-runtime/managed-plugin.sock',
				status: attachmentStatus === 'retired' ? 'retired' : 'published',
			},
		},
	};
}

describe('Gateway runtime readiness plane mapper', () => {
	it('keeps every required service plane pending before evidence arrives', () => {
		expect(
			mapGatewayRuntimeReadinessEvidenceToAdmissionPlanes({
				evidence: { kind: 'pending' },
			}),
		).toEqual({
			frameworkIdentity: { kind: 'pending' },
			providerRevision: { kind: 'pending' },
			requiredBackends: { kind: 'pending' },
			semanticRevision: { kind: 'pending' },
			toolPortalIdentity: { kind: 'pending' },
			toolPortalReadiness: { kind: 'pending' },
			udsAttachment: { kind: 'pending' },
			udsPublication: { kind: 'pending' },
		});
	});

	it('maps an attached current snapshot to actual ready identities and revisions', () => {
		const observations = mapGatewayRuntimeReadinessEvidenceToAdmissionPlanes({
			evidence: {
				kind: 'current',
				snapshot: createGatewayRuntimeReadinessSnapshot(createSnapshotInput()),
			},
		});

		expect(observations.toolPortalIdentity).toEqual({
			identity: {
				processEpoch: 'tool-portal-process-1',
				role: 'tool-portal',
				runtimeEpoch: 'runtime-1',
				serviceId: 'tool-portal-service-1',
			},
			kind: 'ready',
		});
		expect(observations.frameworkIdentity).toMatchObject({
			identity: {
				clientKind: 'hermes-managed-plugin',
				frameworkKind: 'hermes',
				projectionCohortDigest:
					'projection-cohort:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			},
			kind: 'ready',
		});
		expect(observations.udsAttachment).toMatchObject({ kind: 'ready' });
		expect(observations.semanticRevision).toEqual({
			identity: 'semantic-1',
			kind: 'ready',
		});
	});

	it('does not claim framework identity before the accepted UDS attachment exists', () => {
		const observations = mapGatewayRuntimeReadinessEvidenceToAdmissionPlanes({
			evidence: {
				kind: 'current',
				snapshot: createGatewayRuntimeReadinessSnapshot(createSnapshotInput('awaiting-attachment')),
			},
		});

		expect(observations.toolPortalReadiness).toMatchObject({ kind: 'ready' });
		expect(observations.frameworkIdentity).toEqual({ kind: 'pending' });
		expect(observations.udsAttachment).toEqual({ kind: 'pending' });
	});

	it('maps an attachment loss without falsely losing the still-live Tool Portal role', () => {
		const observations = mapGatewayRuntimeReadinessEvidenceToAdmissionPlanes({
			evidence: {
				kind: 'current',
				snapshot: createGatewayRuntimeReadinessSnapshot(createSnapshotInput('attachment-lost')),
			},
		});

		expect(observations.toolPortalReadiness).toMatchObject({ kind: 'ready' });
		expect(observations.frameworkIdentity).toMatchObject({ kind: 'lost' });
		expect(observations.udsAttachment).toMatchObject({ kind: 'lost' });
	});

	it('maps authority-bearing control loss to every Tool Portal-owned plane', () => {
		const observations = mapGatewayRuntimeReadinessEvidenceToAdmissionPlanes({
			evidence: {
				kind: 'lost',
				snapshot: createGatewayRuntimeReadinessSnapshot(createSnapshotInput()),
			},
		});

		expect(observations.toolPortalIdentity).toMatchObject({ kind: 'lost' });
		expect(observations.toolPortalReadiness).toMatchObject({ kind: 'lost' });
		expect(observations.providerRevision).toMatchObject({ kind: 'lost' });
		expect(observations.udsPublication).toMatchObject({ kind: 'lost' });
		expect(observations.frameworkIdentity).toMatchObject({ kind: 'lost' });
	});
});
