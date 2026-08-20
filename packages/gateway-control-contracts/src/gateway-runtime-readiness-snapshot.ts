import { z } from 'zod/v4';

export const GATEWAY_RUNTIME_READINESS_SNAPSHOT_VERSION = 1;
export const GATEWAY_RUNTIME_ATTACHMENT_SNAPSHOT_VERSION = 1;

const BoundedIdentitySchema = z.string().min(1).max(256);
const PositiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const NonNegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const GatewayRuntimeManagedPluginClientKindSchema = z.enum([
	'openclaw-managed-plugin',
	'hermes-managed-plugin',
]);

export const GatewayRuntimeExpectedAttachmentIdentitySchema = z
	.object({
		attachmentGeneration: PositiveSafeIntegerSchema,
		clientKind: GatewayRuntimeManagedPluginClientKindSchema,
		configuredAgentIds: z.array(BoundedIdentitySchema).min(1).max(128).readonly(),
		frameworkEpoch: BoundedIdentitySchema,
		gatewayEpoch: BoundedIdentitySchema,
		protocolVersion: PositiveSafeIntegerSchema,
		projectionCohortDigest: z.string().regex(/^projection-cohort:[a-f0-9]{64}$/u),
		runtimeEpoch: BoundedIdentitySchema,
		schemaVersion: PositiveSafeIntegerSchema,
	})
	.strict()
	.superRefine((identity, context) => {
		if (new Set(identity.configuredAgentIds).size !== identity.configuredAgentIds.length) {
			context.addIssue({
				code: 'custom',
				message: 'Gateway runtime configured agent ids must be unique.',
				path: ['configuredAgentIds'],
			});
		}
	})
	.readonly();

export const GatewayRuntimeAttachmentSnapshotSchema = z
	.object({
		connectionId: z.string().uuid().optional(),
		expected: GatewayRuntimeExpectedAttachmentIdentitySchema,
		observationSequence: NonNegativeSafeIntegerSchema,
		snapshotVersion: z.literal(GATEWAY_RUNTIME_ATTACHMENT_SNAPSHOT_VERSION),
		status: z.enum(['awaiting-attachment', 'attached', 'attachment-lost', 'retired']),
	})
	.strict()
	.superRefine((snapshot, context) => {
		const requiresConnectionIdentity =
			snapshot.status === 'attached' || snapshot.status === 'attachment-lost';
		if (requiresConnectionIdentity && snapshot.connectionId === undefined) {
			context.addIssue({
				code: 'custom',
				message: 'Accepted and lost attachment snapshots require a connection identity.',
				path: ['connectionId'],
			});
		}
		if (!requiresConnectionIdentity && snapshot.connectionId !== undefined) {
			context.addIssue({
				code: 'custom',
				message: 'Awaiting and retired attachment snapshots cannot claim a connection identity.',
				path: ['connectionId'],
			});
		}
	})
	.readonly();

export type GatewayRuntimeAttachmentSnapshot = z.infer<
	typeof GatewayRuntimeAttachmentSnapshotSchema
>;
export type GatewayRuntimeAttachmentSnapshotInput = z.input<
	typeof GatewayRuntimeAttachmentSnapshotSchema
>;

export const GatewayRuntimeUdsPublicationSnapshotSchema = z
	.object({
		identity: z.literal('managed-plugin-private-uds'),
		protocolVersion: PositiveSafeIntegerSchema,
		schemaVersion: PositiveSafeIntegerSchema,
		socketPath: z.string().min(1).max(256).startsWith('/'),
		status: z.enum(['published', 'retired']),
	})
	.strict()
	.readonly();

export const GatewayRuntimeRequiredBackendKindSchema = z.enum([
	'controller_execution',
	'mcp_provider',
	'tool_vm_runner',
]);

export const GatewayRuntimeRequiredBackendsReadinessSchema = z
	.object({
		readyBackendKinds: z.array(GatewayRuntimeRequiredBackendKindSchema).max(3).readonly(),
		revision: BoundedIdentitySchema,
		status: z.literal('ready'),
	})
	.strict()
	.superRefine((readiness, context) => {
		if (new Set(readiness.readyBackendKinds).size !== readiness.readyBackendKinds.length) {
			context.addIssue({
				code: 'custom',
				message: 'Gateway runtime ready backend kinds must be unique.',
				path: ['readyBackendKinds'],
			});
		}
	})
	.readonly();

export const GatewayRuntimeFatalEvidenceSchema = z
	.object({
		failureCode: BoundedIdentitySchema,
		kind: z.literal('fatal'),
		observedGatewayEpoch: BoundedIdentitySchema,
		processEpoch: BoundedIdentitySchema,
		role: z.enum(['framework-service', 'tool-portal-service']),
		schemaVersion: z.literal(1),
		serviceId: BoundedIdentitySchema,
	})
	.strict()
	.readonly();

export type GatewayRuntimeFatalEvidence = z.infer<typeof GatewayRuntimeFatalEvidenceSchema>;

/**
 * Role-local Tool Portal evidence. The controller must join this with framework,
 * backend, ingress, and control-session evidence before admitting the Gateway.
 */
export const GatewayRuntimeReadinessSnapshotSchema = z
	.object({
		controlEndpoint: z
			.object({
				identity: z
					.object({
						bootId: BoundedIdentitySchema,
						controllerEpoch: BoundedIdentitySchema,
						generationId: BoundedIdentitySchema,
						peerId: BoundedIdentitySchema,
						processEpoch: BoundedIdentitySchema,
						zoneId: BoundedIdentitySchema,
					})
					.strict()
					.readonly(),
				listener: z
					.object({
						host: z.string().min(1).max(253),
						port: z.number().int().min(1).max(65_535),
						readyPath: z.string().min(1).max(256).startsWith('/'),
						socketPath: z.string().min(1).max(256).startsWith('/'),
					})
					.strict()
					.readonly(),
			})
			.strict()
			.readonly(),
		kind: z.literal('tool-portal-role-readiness'),
		providerRevision: BoundedIdentitySchema,
		requiredBackends: GatewayRuntimeRequiredBackendsReadinessSchema,
		semanticRevision: BoundedIdentitySchema,
		serviceIdentity: z
			.object({
				processEpoch: BoundedIdentitySchema,
				role: z.literal('tool-portal'),
				serviceId: BoundedIdentitySchema,
			})
			.strict()
			.readonly(),
		snapshotVersion: z.literal(GATEWAY_RUNTIME_READINESS_SNAPSHOT_VERSION),
		uds: z
			.object({
				attachment: GatewayRuntimeAttachmentSnapshotSchema,
				publication: GatewayRuntimeUdsPublicationSnapshotSchema,
			})
			.strict()
			.readonly(),
	})
	.strict()
	.superRefine((snapshot, context) => {
		if (snapshot.controlEndpoint.identity.processEpoch !== snapshot.serviceIdentity.processEpoch) {
			context.addIssue({
				code: 'custom',
				message: 'Gateway runtime service and control endpoint process epochs must match.',
				path: ['controlEndpoint', 'identity', 'processEpoch'],
			});
		}
		if (
			snapshot.uds.publication.status === 'retired' &&
			snapshot.uds.attachment.status !== 'retired'
		) {
			context.addIssue({
				code: 'custom',
				message: 'A retired UDS publication requires a retired attachment lifecycle.',
				path: ['uds', 'attachment', 'status'],
			});
		}
	})
	.readonly();

export type GatewayRuntimeReadinessSnapshot = z.infer<typeof GatewayRuntimeReadinessSnapshotSchema>;
export type GatewayRuntimeReadinessSnapshotInput = z.input<
	typeof GatewayRuntimeReadinessSnapshotSchema
>;

function freezeExpectedAttachmentIdentity(
	identity: GatewayRuntimeAttachmentSnapshot['expected'],
): GatewayRuntimeAttachmentSnapshot['expected'] {
	return Object.freeze({
		...identity,
		configuredAgentIds: Object.freeze([...identity.configuredAgentIds].toSorted()),
	});
}

export function createGatewayRuntimeAttachmentSnapshot(
	input: GatewayRuntimeAttachmentSnapshotInput,
): GatewayRuntimeAttachmentSnapshot {
	const parsed = GatewayRuntimeAttachmentSnapshotSchema.parse(input);
	return Object.freeze({
		...parsed,
		expected: freezeExpectedAttachmentIdentity(parsed.expected),
	});
}

export function createGatewayRuntimeReadinessSnapshot(
	input: GatewayRuntimeReadinessSnapshotInput,
): GatewayRuntimeReadinessSnapshot {
	const parsed = GatewayRuntimeReadinessSnapshotSchema.parse(input);
	const attachment = createGatewayRuntimeAttachmentSnapshot(parsed.uds.attachment);
	return Object.freeze({
		...parsed,
		controlEndpoint: Object.freeze({
			identity: Object.freeze({ ...parsed.controlEndpoint.identity }),
			listener: Object.freeze({ ...parsed.controlEndpoint.listener }),
		}),
		serviceIdentity: Object.freeze({ ...parsed.serviceIdentity }),
		requiredBackends: Object.freeze({
			...parsed.requiredBackends,
			readyBackendKinds: Object.freeze([...parsed.requiredBackends.readyBackendKinds].toSorted()),
		}),
		uds: Object.freeze({
			attachment,
			publication: Object.freeze({ ...parsed.uds.publication }),
		}),
	});
}
