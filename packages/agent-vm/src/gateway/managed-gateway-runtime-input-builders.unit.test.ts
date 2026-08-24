import { createPrivateKey } from 'node:crypto';

import { mcpConfigSchema, toolPortalConfigSchema } from '@agent-vm/config-contracts';
import {
	GatewayRuntimePortalAdmissionMaterialSchema,
	type GatewayRuntimePortalAdmissionMaterial,
} from '@agent-vm/gateway-control-contracts';
import { describe, expect, it } from 'vitest';

import type { GatewayControlSessionMaterial } from '../controller/control-session/index.js';
import type { GatewayEpochIdentity } from '../controller/vm-ownership/vm-ownership-contracts.js';
import type { GatewayExpectedAdmissionCohort } from './gateway-aggregate-admission-state.js';
import { materializeGatewayRuntimePortalAdmission } from './gateway-runtime-portal-admission-material.js';
import { createManagedGatewayBootContract } from './managed-gateway-boot-contract.js';
import {
	buildManagedGatewayFrameworkAdapterMaterial,
	buildManagedGatewayExpectedAdmissionCohort,
	buildManagedGatewayRuntimeAttachmentMetadata,
	buildManagedGatewayRuntimeServiceConfig,
} from './managed-gateway-runtime-input-builders.js';

const effectiveMcpConfig = mcpConfigSchema.parse({ providers: {}, schemaVersion: 1 });
const effectiveToolPortalConfig = toolPortalConfigSchema.parse({
	agents: {
		'agent-b': { profile: 'profile-b' },
		'agent-a': { profile: 'profile-a' },
	},
	mode: 'managed',
	profiles: {
		'profile-a': { namespaces: {} },
		'profile-b': { namespaces: {} },
	},
	schemaVersion: 1,
});
const agentProjectionInputs = [
	{
		agentId: 'agent-b',
		frameworkIdentity: { kind: 'hermes' as const, profileName: 'agent-b' },
		toolPortalProfileId: 'profile-b',
	},
	{
		agentId: 'agent-a',
		frameworkIdentity: { kind: 'hermes' as const, profileName: 'agent-a' },
		toolPortalProfileId: 'profile-a',
	},
] as const;
const portalAdmission = materializeGatewayRuntimePortalAdmission({
	agentProjections: agentProjectionInputs,
	effectivePlan: { effectiveMcpConfig, effectiveToolPortalConfig },
	surfaceEligibilityByProfile: { 'profile-a': {}, 'profile-b': {} },
});
const semanticSnapshot = portalAdmission.semanticSnapshot;
const agentAProjection = semanticSnapshot.agentProjections['agent-a'];
if (agentAProjection === undefined) {
	throw new Error('Expected agent-a projection fixture.');
}

function createHermesPortalAdmission(): GatewayRuntimePortalAdmissionMaterial {
	return materializeGatewayRuntimePortalAdmission({
		agentProjections: agentProjectionInputs.map((projection) => ({
			...projection,
			frameworkIdentity: {
				kind: 'hermes' as const,
				profileName: `${projection.agentId}-profile`,
			},
		})),
		effectivePlan: { effectiveMcpConfig, effectiveToolPortalConfig },
		surfaceEligibilityByProfile: semanticSnapshot.surfaceEligibilityByProfile,
	});
}

const controlSessionMaterial = {
	agentAuthorityKeys: {
		'agent-a': 'agent-a-authority-key-with-sufficient-length',
		'agent-b': 'agent-b-authority-key-with-sufficient-length',
	},
	bootId: 'boot-1',
	callerContextProofKey: 'caller-context-proof-key-with-sufficient-length',
	controllerEpoch: 'controller-1',
	generationId: 'gateway-generation-1',
	peerId: 'tool-portal-zone-a',
	processEpoch: 'tool-portal-process-1',
	privateKey: createPrivateKey({
		format: 'pem',
		key: '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIBERERERERERERERERERERERERERERERERERERERERER\n-----END PRIVATE KEY-----',
		type: 'pkcs8',
	}),
	verifierPublicKeyPem: 'test-verifier-public-key',
	zoneId: 'zone-a',
} satisfies GatewayControlSessionMaterial;

const gatewayIdentity = {
	bootId: 'boot-1',
	controllerEpoch: 'controller-1',
	gatewayEpochId: 'gateway-epoch-id-1',
	gatewayVmId: 'gateway-vm-1',
	generationId: 'gateway-generation-1',
	zoneId: 'zone-a',
} satisfies GatewayEpochIdentity;

const bootContract = createManagedGatewayBootContract({
	bootEntry: 'hermes-gateway',
	configurationInputPath: '/run/agent-vm/managed-gateway/framework-service.json',
	environmentInputPath: '/run/agent-vm/managed-gateway/framework.environment.sh',
	framework: 'hermes',
	ingress: { guestPort: 18_789, kind: 'framework-http' },
	logIdentity: {
		guestPath: '/var/log/agent-vm/hermes-service.log',
		serviceName: 'agent-vm-hermes',
	},
	readiness: { guestPort: 18_789, kind: 'framework-http', path: '/readyz' },
	role: 'framework-service',
});

describe('Managed Gateway runtime input builders', () => {
	it.each([
		['selfRoot', '/zone/agents/agent-a/self'],
		['workRoot', '/zone/agents/agent-a/work'],
	] as const)(
		'rejects retired %s authority before deriving a semantic revision',
		(field, value) => {
			const agentAInput = agentProjectionInputs[1];
			if (agentAInput === undefined) {
				throw new Error('Expected agent-a projection input fixture.');
			}

			expect(() =>
				materializeGatewayRuntimePortalAdmission({
					agentProjections: [agentProjectionInputs[0], { ...agentAInput, [field]: value }],
					effectivePlan: { effectiveMcpConfig, effectiveToolPortalConfig },
					surfaceEligibilityByProfile: { 'profile-a': {}, 'profile-b': {} },
				}),
			).toThrow('Unrecognized key');
		},
	);

	it('binds the exact projection cohort digest into admission and attachment identity', () => {
		// Arrange
		const cohort = buildManagedGatewayExpectedAdmissionCohort({
			bootContract,
			controlSessionMaterial,
			gatewayIdentity,
			generatedIdentity: {
				attachmentGeneration: 1,
				frameworkEpoch: 'framework-1',
				runtimeEpoch: 'runtime-1',
			},
			portalAdmission,
		});

		// Act
		const attachment = buildManagedGatewayRuntimeAttachmentMetadata(cohort);

		// Assert
		expect(cohort.frameworkIdentity.projectionCohortDigest).toBe(
			portalAdmission.semanticSnapshot.projectionCohortDigest,
		);
		expect(attachment.projectionCohortDigest).toBe(
			portalAdmission.semanticSnapshot.projectionCohortDigest,
		);
	});
	it('builds frozen framework-neutral adapter material for every configured agent', () => {
		// Arrange
		const cohort = buildManagedGatewayExpectedAdmissionCohort({
			bootContract,
			controlSessionMaterial,
			gatewayIdentity,
			generatedIdentity: {
				attachmentGeneration: 1,
				frameworkEpoch: 'framework-1',
				runtimeEpoch: 'runtime-1',
			},
			portalAdmission,
		});

		// Act
		const adapterMaterial = buildManagedGatewayFrameworkAdapterMaterial({
			cohort,
			portalAdmission,
		});

		// Assert
		expect(adapterMaterial).toEqual({
			attachment: {
				attachmentGeneration: 1,
				clientKind: 'hermes-managed-plugin',
				configuredAgentIds: ['agent-a', 'agent-b'],
				frameworkEpoch: 'framework-1',
				gatewayEpoch: 'gateway-generation-1',
				protocolVersion: 1,
				projectionCohortDigest: semanticSnapshot.projectionCohortDigest,
				runtimeEpoch: 'runtime-1',
				schemaVersion: 1,
			},
			agentProjections: semanticSnapshot.agentProjections,
		});
		expect(Object.isFrozen(adapterMaterial)).toBe(true);
		expect(Object.isFrozen(adapterMaterial.attachment)).toBe(true);
		expect(Object.isFrozen(adapterMaterial.attachment.configuredAgentIds)).toBe(true);
		expect(Object.isFrozen(adapterMaterial.agentProjections)).toBe(true);
		expect(Object.isFrozen(adapterMaterial.agentProjections['agent-a'])).toBe(true);
		const adapterProjection = adapterMaterial.agentProjections['agent-a'];
		const admittedProjection = portalAdmission.semanticSnapshot.agentProjections['agent-a'];
		if (adapterProjection === undefined || admittedProjection === undefined) {
			throw new Error('Missing agent-a projection immutability fixture.');
		}
		expect(Object.isFrozen(admittedProjection.frameworkIdentity)).toBe(true);
		expect(Object.isFrozen(adapterProjection.frameworkIdentity)).toBe(true);
		expect(adapterProjection.frameworkIdentity).not.toBe(admittedProjection.frameworkIdentity);
		expect(() =>
			Object.assign(adapterProjection.frameworkIdentity, { agentId: 'mutated-agent' }),
		).toThrow(TypeError);
	});

	it('produces deterministic adapter material from shuffled admission input', () => {
		// Arrange
		const shuffledPortalAdmission = GatewayRuntimePortalAdmissionMaterialSchema.parse({
			...portalAdmission,
			effectiveToolPortalConfig: {
				...portalAdmission.effectiveToolPortalConfig,
				agents: {
					'agent-a': { profile: 'profile-a' },
					'agent-b': { profile: 'profile-b' },
				},
			},
			semanticSnapshot: {
				...portalAdmission.semanticSnapshot,
				agentProjections: {
					'agent-a': semanticSnapshot.agentProjections['agent-a'],
					'agent-b': semanticSnapshot.agentProjections['agent-b'],
				},
			},
		});
		const generatedIdentity = {
			attachmentGeneration: 1,
			frameworkEpoch: 'framework-1',
			runtimeEpoch: 'runtime-1',
		};
		const firstCohort = buildManagedGatewayExpectedAdmissionCohort({
			bootContract,
			controlSessionMaterial,
			gatewayIdentity,
			generatedIdentity,
			portalAdmission,
		});
		const shuffledCohort = buildManagedGatewayExpectedAdmissionCohort({
			bootContract,
			controlSessionMaterial,
			gatewayIdentity,
			generatedIdentity,
			portalAdmission: shuffledPortalAdmission,
		});

		// Act
		const firstMaterial = buildManagedGatewayFrameworkAdapterMaterial({
			cohort: firstCohort,
			portalAdmission,
		});
		const shuffledMaterial = buildManagedGatewayFrameworkAdapterMaterial({
			cohort: shuffledCohort,
			portalAdmission: shuffledPortalAdmission,
		});

		// Assert
		expect(shuffledMaterial).toEqual(firstMaterial);
		expect(JSON.stringify(shuffledMaterial)).toBe(JSON.stringify(firstMaterial));
	});

	it('projects semantic assignment authority without deriving identity from runtime epochs', () => {
		// Arrange
		const cohort = buildManagedGatewayExpectedAdmissionCohort({
			bootContract,
			controlSessionMaterial,
			gatewayIdentity,
			generatedIdentity: {
				attachmentGeneration: 1,
				frameworkEpoch: 'framework-1',
				runtimeEpoch: 'runtime-1',
			},
			portalAdmission,
		});
		const changedZoneCohort = {
			...cohort,
			fence: { ...cohort.fence, zoneId: 'zone-b' },
		};
		const changedGatewayCohort = {
			...cohort,
			fence: { ...cohort.fence, gatewayEpoch: 'gateway-generation-2' },
		};
		const changedRuntimeCohort = {
			...cohort,
			toolPortalIdentity: { ...cohort.toolPortalIdentity, runtimeEpoch: 'runtime-2' },
		};

		// Act
		const projectedAssignments = [
			cohort,
			changedZoneCohort,
			changedGatewayCohort,
			changedRuntimeCohort,
		].map(
			(candidateCohort) =>
				buildManagedGatewayFrameworkAdapterMaterial({
					cohort: candidateCohort,
					portalAdmission,
				}).agentProjections,
		);

		// Assert
		for (const agentProjections of projectedAssignments) {
			expect(agentProjections).toEqual(projectedAssignments[0]);
			expect(agentProjections['agent-a']).toEqual(semanticSnapshot.agentProjections['agent-a']);
		}
	});

	it('maps Hermes to the common adapter contract without framework-specific projection', () => {
		// Arrange
		const hermesBootContract = createManagedGatewayBootContract({
			...bootContract.frameworkService,
			bootEntry: 'hermes-gateway',
			framework: 'hermes',
		});
		const hermesPortalAdmission = createHermesPortalAdmission();
		const hermesSemanticSnapshot = hermesPortalAdmission.semanticSnapshot;
		const cohort = buildManagedGatewayExpectedAdmissionCohort({
			bootContract: hermesBootContract,
			controlSessionMaterial,
			gatewayIdentity,
			generatedIdentity: {
				attachmentGeneration: 1,
				frameworkEpoch: 'hermes-framework-1',
				runtimeEpoch: 'runtime-1',
			},
			portalAdmission: hermesPortalAdmission,
		});

		// Act
		const adapterMaterial = buildManagedGatewayFrameworkAdapterMaterial({
			cohort,
			portalAdmission: hermesPortalAdmission,
		});

		// Assert
		expect(adapterMaterial.attachment.clientKind).toBe('hermes-managed-plugin');
		expect(adapterMaterial.agentProjections).toEqual(hermesSemanticSnapshot.agentProjections);
	});

	it('fails closed when adapter sets, projection revisions, or digests disagree', () => {
		// Arrange
		const cohort = buildManagedGatewayExpectedAdmissionCohort({
			bootContract,
			controlSessionMaterial,
			gatewayIdentity,
			generatedIdentity: {
				attachmentGeneration: 1,
				frameworkEpoch: 'framework-1',
				runtimeEpoch: 'runtime-1',
			},
			portalAdmission,
		});
		const missingProjection = GatewayRuntimePortalAdmissionMaterialSchema.parse({
			...portalAdmission,
			semanticSnapshot: {
				...portalAdmission.semanticSnapshot,
				agentProjections: {
					'agent-a': agentAProjection,
				},
			},
		});
		const staleRevision = GatewayRuntimePortalAdmissionMaterialSchema.parse({
			...portalAdmission,
			semanticSnapshot: {
				...portalAdmission.semanticSnapshot,
				agentProjections: {
					...portalAdmission.semanticSnapshot.agentProjections,
					'agent-a': {
						...agentAProjection,
						profileAssignmentRevision: 'profile-assignment:stale',
					},
				},
			},
		});
		const mismatchedDigest = {
			...cohort,
			frameworkIdentity: {
				...cohort.frameworkIdentity,
				projectionCohortDigest:
					'projection-cohort:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
			},
		} satisfies GatewayExpectedAdmissionCohort;
		// Act / Assert
		expect(() =>
			buildManagedGatewayFrameworkAdapterMaterial({
				cohort,
				portalAdmission: missingProjection,
			}),
		).toThrow('exactly match configured Tool Portal agent ids');
		expect(() =>
			buildManagedGatewayFrameworkAdapterMaterial({
				cohort,
				portalAdmission: staleRevision,
			}),
		).toThrow('semantic snapshot does not match');
		expect(() =>
			buildManagedGatewayFrameworkAdapterMaterial({
				cohort: mismatchedDigest,
				portalAdmission,
			}),
		).toThrow('projection cohort digest does not match');
	});

	it('builds one exact multi-agent cohort from controller-owned identities', () => {
		// Arrange
		const generatedIdentity = {
			attachmentGeneration: 1,
			frameworkEpoch: 'framework-1',
			runtimeEpoch: 'runtime-1',
		};

		// Act
		const cohort = buildManagedGatewayExpectedAdmissionCohort({
			bootContract,
			controlSessionMaterial,
			gatewayIdentity,
			generatedIdentity,
			portalAdmission,
		});

		// Assert
		expect(cohort).toMatchObject({
			fence: {
				controllerEpoch: 'controller-1',
				gatewayEpoch: 'gateway-generation-1',
				vmId: 'gateway-vm-1',
				zoneId: 'zone-a',
			},
			frameworkIdentity: {
				clientKind: 'hermes-managed-plugin',
				configuredAgentIds: ['agent-a', 'agent-b'],
				frameworkEpoch: 'framework-1',
				projectionCohortDigest: semanticSnapshot.projectionCohortDigest,
			},
			ingressIntent: {
				controlRoute: {
					guestPort: 18_790,
					prefix: '/__agent-vm',
					stripPrefix: false,
				},
				frameworkRootRoute: {
					guestPort: 18_789,
					prefix: '/',
					stripPrefix: true,
				},
			},
			requiredBackendRevision: semanticSnapshot.bindingRevision,
			toolPortalIdentity: {
				processEpoch: 'tool-portal-process-1',
				runtimeEpoch: 'runtime-1',
				serviceId: 'tool-portal-zone-a',
			},
		});
		expect(Object.isFrozen(cohort)).toBe(true);
	});

	it('builds matching plugin attachment and Tool Portal service config', () => {
		// Arrange
		const cohort = buildManagedGatewayExpectedAdmissionCohort({
			bootContract,
			controlSessionMaterial,
			gatewayIdentity,
			generatedIdentity: {
				attachmentGeneration: 1,
				frameworkEpoch: 'framework-1',
				runtimeEpoch: 'runtime-1',
			},
			portalAdmission,
		});

		// Act
		const attachment = buildManagedGatewayRuntimeAttachmentMetadata(cohort);
		const serviceConfig = buildManagedGatewayRuntimeServiceConfig({
			artifactLimits: {
				maximumArtifactBytes: 1_024,
				maximumArtifactCount: 8,
				maximumLifetimeMs: 60_000,
				maximumTotalBytes: 8_192,
			},
			cohort,
			controlSessionMaterial,
			observability: undefined,
			portalAdmission,
		});

		// Assert
		expect(attachment).toEqual({
			attachmentGeneration: 1,
			clientKind: 'hermes-managed-plugin',
			configuredAgentIds: ['agent-a', 'agent-b'],
			frameworkEpoch: 'framework-1',
			gatewayEpoch: 'gateway-generation-1',
			protocolVersion: 1,
			projectionCohortDigest: semanticSnapshot.projectionCohortDigest,
			runtimeEpoch: 'runtime-1',
			schemaVersion: 1,
		});
		expect(serviceConfig).toMatchObject({
			attachment: {
				configuredAgentIds: ['agent-a', 'agent-b'],
				frameworkEpoch: 'framework-1',
				gatewayEpoch: 'gateway-generation-1',
				projectionCohortDigest: semanticSnapshot.projectionCohortDigest,
				runtimeEpoch: 'runtime-1',
			},
			controlEndpoint: {
				identity: {
					generationId: 'gateway-generation-1',
					processEpoch: 'tool-portal-process-1',
				},
				listen: { host: '127.0.0.1', port: 18_790 },
			},
			mcpConfigPath: '/run/agent-vm/managed-gateway/mcp.config.json',
			observability: { kind: 'disabled' },
			runtimeRoot: '/run/agent-vm/gateway-runtime',
			semanticSnapshot: { activeRevision: semanticSnapshot.activeRevision },
			serviceIdentity: {
				processEpoch: cohort.toolPortalIdentity.processEpoch,
				role: cohort.toolPortalIdentity.role,
				serviceId: cohort.toolPortalIdentity.serviceId,
			},
		});
	});

	it('projects the exact managed Tool Portal producer onto its mediated OTLP HTTP endpoint', () => {
		// Arrange
		const cohort = buildManagedGatewayExpectedAdmissionCohort({
			bootContract,
			controlSessionMaterial,
			gatewayIdentity,
			generatedIdentity: {
				attachmentGeneration: 1,
				frameworkEpoch: 'framework-1',
				runtimeEpoch: 'runtime-1',
			},
			portalAdmission,
		});

		// Act
		const serviceConfig = buildManagedGatewayRuntimeServiceConfig({
			artifactLimits: {
				maximumArtifactBytes: 1_024,
				maximumArtifactCount: 8,
				maximumLifetimeMs: 60_000,
				maximumTotalBytes: 8_192,
			},
			cohort,
			controlSessionMaterial,
			observability: {
				collector: {
					grpcPort: 4_317,
					host: 'otel-collector.observability.vm.host',
					httpPort: 4_318,
					targetGrpcPort: 14_317,
					targetHost: '127.0.0.1',
					targetHttpPort: 14_318,
				},
				framework: {
					admissionLimits: {
						maxExportBatchRecords: 64,
						maxQueuedRecordsPerSignal: 256,
						maxRecordBytes: 65_536,
					},
					flushIntervalMs: 2_000,
					logs: false,
					metrics: false,
					sampleRate: 0.25,
					serviceName: 'agent-vm-hermes',
					sourcePolicy: { admitBaggage: false, captureContent: false },
					traces: true,
				},
				mode: 'collector',
				toolPortal: {
					admissionLimits: {
						maxExportBatchRecords: 64,
						maxQueuedRecordsPerSignal: 256,
						maxRecordBytes: 65_536,
					},
					flushIntervalMs: 1_000,
					logs: true,
					metrics: true,
					sampleRate: 1,
					serviceName: 'agent-vm-tool-portal',
					sourcePolicy: { admitBaggage: false, captureContent: false },
					traces: true,
				},
			},
			portalAdmission,
		});

		// Assert
		expect(serviceConfig.observability).toEqual({
			admissionLimits: {
				maxExportBatchRecords: 64,
				maxQueuedRecordsPerSignal: 256,
				maxRecordBytes: 65_536,
			},
			endpoint: 'http://otel-collector.observability.vm.host:4318',
			flushIntervalMs: 1_000,
			kind: 'otlp-http',
			logs: true,
			metrics: true,
			sampleRate: 1,
			serviceName: 'agent-vm-tool-portal',
			sourcePolicy: { admitBaggage: false, captureContent: false },
			traces: true,
		});
	});
});
