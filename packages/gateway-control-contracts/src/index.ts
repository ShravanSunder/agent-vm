import {
	ControlCorrelationSchema,
	ControlRpcErrorSchema,
	ControlRpcResultBaseSchema,
	ControlSessionStateSchema,
	type ControlSessionControllerToPeerEvents,
	type ControlSessionPeerToControllerEvents,
	KnownControlDomainSchema,
	type ControlDeliveryPolicy,
	type ControlMessageKind,
} from '@agent-vm/control-protocol-contracts';
import { z } from 'zod/v4';

export const GatewayControlDomainSchema = z.literal('gateway_control');

export const GatewayControlRpcOperationSchema = z.enum([
	'control_ping',
	'caller_context_register',
	'lease_create',
	'lease_get',
	'lease_peek',
	'lease_renew',
	'lease_release',
	'lease_use_start',
	'lease_use_heartbeat',
	'lease_use_end',
	'health_event',
	'runtime_status',
	'tool_portal_controller_host_action',
	'operation_cancel',
	'recovery_command',
]);

export const GatewayControlRpcResultSchema = z.enum([
	...ControlRpcResultBaseSchema.options,
	'approval_required',
	'approval_stale',
]);

export const GatewayControlForbiddenPayloadFieldSchema = z.enum([
	'adminToken',
	'agentId',
	'approvalProof',
	'argv',
	'controllerInstanceId',
	'cwd',
	'credentialProfileId',
	'egressPolicy',
	'env',
	'executablePath',
	'hostWorkMountDir',
	'profileId',
	'rawCredentialRef',
	'retryPolicy',
	'routeToken',
	'sessionKey',
	'sshIdentityPem',
	'vmGenerationOverride',
	'workMountDir',
]);

export const GatewayControlCapabilityRefSchema = z
	.object({
		name: z.string().min(1),
		namespace: z.string().min(1),
	})
	.strict();

export const GatewayControlToolCallCorrelationSchema = ControlCorrelationSchema.extend({
	capability: GatewayControlCapabilityRefSchema.optional(),
}).strict();

export const GatewayControlTrustedCallerContextIdSchema = z.string().uuid();

export const GatewayControlTrustedLeaseContextSchema = z
	.object({
		agentId: z.string().min(1),
		agentWorkspaceDir: z.string().min(1),
		approvalScopeId: z.string().min(1).optional(),
		callerContextId: GatewayControlTrustedCallerContextIdSchema,
		custodyScopeId: z.string().min(1).optional(),
		hostWorkMountDir: z.string().min(1),
		profileId: z.string().min(1),
		sessionKeyDigest: z.string().min(32),
		workMountDir: z.string().min(1),
		zoneId: z.string().min(1),
	})
	.strict();

export const GatewayControlCallerContextRefSchema = z
	.object({
		callerContextId: GatewayControlTrustedCallerContextIdSchema,
	})
	.strict();

export const GatewayControlCallerContextRegisterPayloadSchema = z
	.object({
		adapterEvidence: z
			.object({
				agentId: z.string().min(1),
				agentWorkspaceDir: z.string().min(1),
				purpose: z.enum(['tool_vm_lease', 'tool_portal_controller_host_action']).optional(),
				sessionKey: z.string().min(1),
				workMountDir: z.string().min(1),
				zoneId: z.string().min(1),
			})
			.strict(),
		correlation: GatewayControlToolCallCorrelationSchema.optional(),
	})
	.strict();

export const GatewayControlLeaseCreateIntentPayloadSchema = z
	.object({
		callerContext: GatewayControlCallerContextRefSchema,
		correlation: GatewayControlToolCallCorrelationSchema.optional(),
		gatewayWorkspaceDir: z.string().min(1).optional(),
		idleTtlHintMs: z.number().int().positive().optional(),
	})
	.strict();

export const GatewayControlLeaseIdPayloadSchema = z
	.object({
		callerContext: GatewayControlCallerContextRefSchema,
		leaseId: z.string().min(1),
	})
	.strict();

export const GatewayControlLeaseUseStartPayloadSchema = z
	.object({
		callerContext: GatewayControlCallerContextRefSchema,
		correlation: GatewayControlToolCallCorrelationSchema.optional(),
		leaseId: z.string().min(1),
		useId: z.string().uuid(),
	})
	.strict();

export const GatewayControlLeaseUseHeartbeatPayloadSchema = z
	.object({
		callerContext: GatewayControlCallerContextRefSchema,
		leaseId: z.string().min(1),
		observedAtMs: z.number().int().positive().optional(),
		useId: z.string().uuid(),
	})
	.strict();

export const GatewayControlLeaseUseEndPayloadSchema = z
	.object({
		callerContext: GatewayControlCallerContextRefSchema,
		leaseId: z.string().min(1),
		reason: z.enum(['completed', 'failed', 'cancelled', 'timed_out']),
		useId: z.string().uuid(),
	})
	.strict();

export const GatewayControlHealthEventResultSchema = z.enum([
	'ok',
	'failed',
	'timeout',
	'degraded',
]);

export const GatewayControlProviderRuntimeHealthSchema = z.enum([
	'healthy',
	'transitioning',
	'unhealthy_recoverable',
	'unhealthy_unrecoverable',
]);

export const GatewayControlControllerRequestHealthOperationSchema = z.enum([
	'zone-git-push',
	'lease-create',
	'lease-get',
	'lease-peek',
	'lease-release',
	'lease-use-start',
	'lease-use-end',
]);

export const GatewayControlSessionHealthOperationSchema = z.enum([
	'control-session-hello',
	'control-session-heartbeat',
	'control-session-disconnect',
	'control-session-reconnect',
]);

export const GatewayControlToolVmSshHealthOperationSchema = z.enum([
	'command',
	'file-bridge',
	'finalize',
	'probe',
]);

const GatewayControlHealthEventBaseSchema = z
	.object({
		correlation: ControlCorrelationSchema.optional(),
		observedAtMs: z.number().int().positive(),
		result: GatewayControlHealthEventResultSchema,
	})
	.strict();

export const GatewayControlHealthEventPayloadSchema = z.discriminatedUnion('eventKind', [
	GatewayControlHealthEventBaseSchema.extend({
		channelProviderId: z.string().min(1),
		eventKind: z.literal('agent-channel-provider-health'),
		providerRuntimeHealth: GatewayControlProviderRuntimeHealthSchema,
		safeDetails: z.record(z.string(), z.string()).optional(),
	}).strict(),
	GatewayControlHealthEventBaseSchema.extend({
		attempt: z.number().int().positive(),
		elapsedMs: z.number().int().nonnegative(),
		errorCode: z.string().min(1).optional(),
		eventKind: z.literal('controller-request'),
		maxAttempts: z.number().int().positive(),
		operation: GatewayControlControllerRequestHealthOperationSchema,
		statusCode: z.number().int().positive().optional(),
	}).strict(),
	GatewayControlHealthEventBaseSchema.extend({
		elapsedMs: z.number().int().nonnegative(),
		eventKind: z.literal('gateway-control-session'),
		operation: GatewayControlSessionHealthOperationSchema,
		safeDetails: z
			.object({
				peerId: z.string().min(1),
			})
			.catchall(z.string()),
	}).strict(),
	GatewayControlHealthEventBaseSchema.extend({
		eventKind: z.literal('gateway-plugin-health'),
	}).strict(),
	GatewayControlHealthEventBaseSchema.extend({
		agentId: z.string().min(1),
		elapsedMs: z.number().int().nonnegative(),
		errorCode: z.string().min(1).optional(),
		leaseId: z.string().min(1),
		eventKind: z.literal('tool-vm-ssh'),
		operation: GatewayControlToolVmSshHealthOperationSchema,
	}).strict(),
]);

export const GatewayControlRuntimeFindingSchema = z
	.object({
		id: z.string().min(1),
		ok: z.boolean(),
		safeMessage: z.string().min(1).optional(),
		severity: z.enum(['info', 'warning', 'error']).optional(),
	})
	.strict();

export const GatewayControlRuntimeStatusPayloadSchema = z
	.object({
		findings: z.array(GatewayControlRuntimeFindingSchema),
		observedAtMs: z.number().int().positive(),
		providerRuntimeHealth: z
			.enum(['healthy', 'transitioning', 'unhealthy_recoverable', 'unhealthy_unrecoverable'])
			.optional(),
		statusKind: z.string().min(1),
	})
	.strict();

export const GatewayControlToolPortalControllerHostActionPayloadSchema = z
	.object({
		actionId: z.literal('zone_git_push'),
		callerContext: GatewayControlCallerContextRefSchema,
		correlation: GatewayControlToolCallCorrelationSchema,
		expectedHead: z.string().min(1),
	})
	.strict();

export const GatewayControlZoneGitCommitSummarySchema = z
	.object({
		sha: z.string().min(1),
		subject: z.string(),
	})
	.strict();

export const GatewayControlZoneGitPushResultSchema = z
	.object({
		branch: z.string().min(1),
		localHead: z.string().min(1),
		pushedCommits: z.array(GatewayControlZoneGitCommitSummarySchema),
		remoteHead: z.string().min(1),
	})
	.strict();

export const GatewayControlToolPortalControllerHostActionResultSchema = z
	.object({
		actionId: z.literal('zone_git_push'),
		result: GatewayControlZoneGitPushResultSchema,
	})
	.strict();

export const GatewayControlActiveOperationIdSchema = z.string().uuid();

export const GatewayInitiatedOperationCancelPayloadSchema = z
	.object({
		activeOperationId: GatewayControlActiveOperationIdSchema,
		initiatedBy: z.literal('gateway'),
		reason: z.enum(['caller_cancelled', 'gateway_shutdown', 'operation_failed']),
	})
	.strict();

export const ControllerInitiatedGatewayOperationCancelPayloadSchema = z
	.object({
		activeOperationId: GatewayControlActiveOperationIdSchema,
		initiatedBy: z.literal('controller'),
		reason: z.enum(['controller_recovery', 'operator_cancelled', 'timeout']),
	})
	.strict();

export const GatewayControlOperationCancelPayloadSchema = z.discriminatedUnion('initiatedBy', [
	GatewayInitiatedOperationCancelPayloadSchema,
	ControllerInitiatedGatewayOperationCancelPayloadSchema,
]);

export const GatewayControlRecoveryCommandPayloadSchema = z.discriminatedUnion('action', [
	z.object({ action: z.literal('refresh_runtime_status') }).strict(),
	z.object({ action: z.literal('restart_control_service') }).strict(),
	z
		.object({
			action: z.literal('close_stale_session'),
			targetSessionId: z.string().uuid(),
		})
		.strict(),
]);

export const GatewayControlPingPayloadSchema = z.object({}).strict();

export const GatewayControlHeartbeatPayloadSchema = z
	.object({
		elapsedMs: z.number().int().nonnegative().optional(),
		observedAtMs: z.number().int().positive(),
	})
	.strict();

export const GatewayControlRpcErrorSchema = ControlRpcErrorSchema;

export const GatewayControlSessionStateSchema = ControlSessionStateSchema;

export const GatewayControlToolVmSshAccessSchema = z
	.object({
		host: z.string().min(1),
		identityPem: z.string().min(1).optional(),
		knownHostsLine: z.string().optional(),
		port: z.number().int().positive(),
		user: z.string().min(1),
	})
	.strict();

export const GatewayControlLeaseSnapshotSchema = z
	.object({
		agentId: z.string().min(1),
		activeUseId: z.string().uuid().optional(),
		expiresAtMs: z.number().int().positive().optional(),
		idleTtlMs: z.number().int().positive(),
		leaseId: z.string().min(1),
		ssh: GatewayControlToolVmSshAccessSchema.optional(),
		state: z.enum(['idle', 'active', 'expired', 'released']),
		tcpSlot: z.number().int().nonnegative(),
		transport: z.literal('ssh-sandbox'),
		workdir: z.string().min(1),
		zoneId: z.string().min(1),
	})
	.strict();

export const GatewayControlLeaseUseSnapshotSchema = z
	.object({
		expiresAt: z.number().int().positive().optional(),
		heartbeatAfterMs: z.number().int().positive().optional(),
		leaseId: z.string().min(1),
		state: z.enum(['active', 'ended', 'expired']),
		useId: z.string().uuid(),
	})
	.strict();

export const GatewayControlLeaseRejectionReasonSchema = z.enum([
	'absent',
	'generation_stale',
	'force_released',
	'releasing',
	'use_tombstoned',
	'runtime_not_ready',
]);

export const GatewayControlRpcDomainCorrelationSchema = ControlCorrelationSchema;

export const GatewayControlRpcResponseBasePayloadSchema = z.object({
	activeOperationId: z.never().optional(),
	approvalRequired: z.never().optional(),
	callerContext: z.never().optional(),
	controllerHostAction: z.never().optional(),
	error: GatewayControlRpcErrorSchema.optional(),
	lease: z.never().optional(),
	leaseRejectionReason: z.never().optional(),
	leaseUse: z.never().optional(),
	responseToMessageId: z.string().uuid(),
	result: GatewayControlRpcResultSchema,
});

export const GatewayControlRpcBareResponsePayloadSchema =
	GatewayControlRpcResponseBasePayloadSchema.strict();

export const GatewayControlRpcCallerContextResponsePayloadSchema =
	GatewayControlRpcResponseBasePayloadSchema.extend({
		callerContext: GatewayControlCallerContextRefSchema.optional(),
	}).strict();

export const GatewayControlRpcLeaseResponsePayloadSchema =
	GatewayControlRpcResponseBasePayloadSchema.extend({
		lease: GatewayControlLeaseSnapshotSchema.optional(),
		leaseRejectionReason: GatewayControlLeaseRejectionReasonSchema.optional(),
	}).strict();

export const GatewayControlRpcLeaseUseResponsePayloadSchema =
	GatewayControlRpcResponseBasePayloadSchema.extend({
		leaseRejectionReason: GatewayControlLeaseRejectionReasonSchema.optional(),
		leaseUse: GatewayControlLeaseUseSnapshotSchema.optional(),
	}).strict();

export const GatewayControlRpcControllerHostActionResponsePayloadSchema =
	GatewayControlRpcResponseBasePayloadSchema.extend({
		controllerHostAction: GatewayControlToolPortalControllerHostActionResultSchema.optional(),
	}).strict();

export const GatewayControlRpcOperationCancelResponsePayloadSchema =
	GatewayControlRpcResponseBasePayloadSchema.extend({
		activeOperationId: GatewayControlActiveOperationIdSchema.optional(),
	}).strict();

export const GatewayControlRpcResponsePayloadSchema = z.union([
	GatewayControlRpcBareResponsePayloadSchema,
	GatewayControlRpcCallerContextResponsePayloadSchema,
	GatewayControlRpcLeaseResponsePayloadSchema,
	GatewayControlRpcLeaseUseResponsePayloadSchema,
	GatewayControlRpcControllerHostActionResponsePayloadSchema,
	GatewayControlRpcOperationCancelResponsePayloadSchema,
]);

const GatewayControlRpcControlPingCommandResultMessageSchema =
	GatewayControlRpcDomainCorrelationSchema.extend({
		kind: z.literal('command_result'),
		operation: z.literal('control_ping'),
		payload: GatewayControlRpcBareResponsePayloadSchema,
	}).strict();

const GatewayControlRpcCallerContextRegisterCommandResultMessageSchema =
	GatewayControlRpcDomainCorrelationSchema.extend({
		kind: z.literal('command_result'),
		operation: z.literal('caller_context_register'),
		payload: GatewayControlRpcCallerContextResponsePayloadSchema,
	}).strict();

const GatewayControlRpcLeaseCommandResultMessageSchema =
	GatewayControlRpcDomainCorrelationSchema.extend({
		kind: z.literal('command_result'),
		operation: z.enum(['lease_create', 'lease_get', 'lease_peek', 'lease_renew', 'lease_release']),
		payload: GatewayControlRpcLeaseResponsePayloadSchema,
	}).strict();

const GatewayControlRpcLeaseUseCommandResultMessageSchema =
	GatewayControlRpcDomainCorrelationSchema.extend({
		kind: z.literal('command_result'),
		operation: z.enum(['lease_use_start', 'lease_use_heartbeat', 'lease_use_end']),
		payload: GatewayControlRpcLeaseUseResponsePayloadSchema,
	}).strict();

const GatewayControlRpcControllerHostActionCommandResultMessageSchema =
	GatewayControlRpcDomainCorrelationSchema.extend({
		kind: z.literal('command_result'),
		operation: z.literal('tool_portal_controller_host_action'),
		payload: GatewayControlRpcControllerHostActionResponsePayloadSchema,
	}).strict();

const GatewayControlRpcOperationCancelCommandResultMessageSchema =
	GatewayControlRpcDomainCorrelationSchema.extend({
		kind: z.literal('command_result'),
		operation: z.literal('operation_cancel'),
		payload: GatewayControlRpcOperationCancelResponsePayloadSchema,
	}).strict();

const GatewayControlRpcRecoveryCommandResultMessageSchema =
	GatewayControlRpcDomainCorrelationSchema.extend({
		kind: z.literal('command_result'),
		operation: z.literal('recovery_command'),
		payload: GatewayControlRpcBareResponsePayloadSchema,
	}).strict();

const GatewayControlHeartbeatMessageSchema = z
	.object({
		kind: z.literal('heartbeat'),
		operation: z.undefined().optional(),
		payload: GatewayControlHeartbeatPayloadSchema,
	})
	.strict();

export const GatewayControlRpcCommandResultMessageSchema = z.discriminatedUnion('operation', [
	GatewayControlRpcControlPingCommandResultMessageSchema,
	GatewayControlRpcCallerContextRegisterCommandResultMessageSchema,
	GatewayControlRpcLeaseCommandResultMessageSchema,
	GatewayControlRpcLeaseUseCommandResultMessageSchema,
	GatewayControlRpcControllerHostActionCommandResultMessageSchema,
	GatewayControlRpcOperationCancelCommandResultMessageSchema,
	GatewayControlRpcRecoveryCommandResultMessageSchema,
]);

export const GatewayControlRpcCommandMessageSchema = z.discriminatedUnion('operation', [
	GatewayControlRpcDomainCorrelationSchema.extend({
		kind: z.literal('command'),
		operation: z.literal('control_ping'),
		payload: GatewayControlPingPayloadSchema,
	}).strict(),
	GatewayControlRpcDomainCorrelationSchema.extend({
		kind: z.literal('command'),
		operation: z.literal('caller_context_register'),
		payload: GatewayControlCallerContextRegisterPayloadSchema,
	}).strict(),
	GatewayControlRpcDomainCorrelationSchema.extend({
		kind: z.literal('command'),
		operation: z.literal('lease_create'),
		payload: GatewayControlLeaseCreateIntentPayloadSchema,
	}).strict(),
	GatewayControlRpcDomainCorrelationSchema.extend({
		kind: z.literal('command'),
		operation: z.literal('lease_get'),
		payload: GatewayControlLeaseIdPayloadSchema,
	}).strict(),
	GatewayControlRpcDomainCorrelationSchema.extend({
		kind: z.literal('command'),
		operation: z.literal('lease_peek'),
		payload: GatewayControlLeaseIdPayloadSchema,
	}).strict(),
	GatewayControlRpcDomainCorrelationSchema.extend({
		kind: z.literal('command'),
		operation: z.literal('lease_renew'),
		payload: GatewayControlLeaseIdPayloadSchema,
	}).strict(),
	GatewayControlRpcDomainCorrelationSchema.extend({
		kind: z.literal('command'),
		operation: z.literal('lease_release'),
		payload: GatewayControlLeaseIdPayloadSchema,
	}).strict(),
	GatewayControlRpcDomainCorrelationSchema.extend({
		kind: z.literal('command'),
		operation: z.literal('lease_use_start'),
		payload: GatewayControlLeaseUseStartPayloadSchema,
	}).strict(),
	GatewayControlRpcDomainCorrelationSchema.extend({
		kind: z.literal('command'),
		operation: z.literal('lease_use_heartbeat'),
		payload: GatewayControlLeaseUseHeartbeatPayloadSchema,
	}).strict(),
	GatewayControlRpcDomainCorrelationSchema.extend({
		kind: z.literal('command'),
		operation: z.literal('lease_use_end'),
		payload: GatewayControlLeaseUseEndPayloadSchema,
	}).strict(),
	GatewayControlRpcDomainCorrelationSchema.extend({
		kind: z.literal('command'),
		operation: z.literal('tool_portal_controller_host_action'),
		payload: GatewayControlToolPortalControllerHostActionPayloadSchema,
	}).strict(),
	GatewayControlRpcDomainCorrelationSchema.extend({
		kind: z.literal('command'),
		operation: z.literal('operation_cancel'),
		payload: GatewayControlOperationCancelPayloadSchema,
	}).strict(),
	GatewayControlRpcDomainCorrelationSchema.extend({
		kind: z.literal('command'),
		operation: z.literal('recovery_command'),
		payload: GatewayControlRecoveryCommandPayloadSchema,
	}).strict(),
]);

export const GatewayControlRpcEventMessageSchema = z.discriminatedUnion('operation', [
	GatewayControlRpcDomainCorrelationSchema.extend({
		kind: z.literal('event'),
		operation: z.literal('health_event'),
		payload: GatewayControlHealthEventPayloadSchema,
	}).strict(),
	GatewayControlRpcDomainCorrelationSchema.extend({
		kind: z.literal('event'),
		operation: z.literal('runtime_status'),
		payload: GatewayControlRuntimeStatusPayloadSchema,
	}).strict(),
]);

export const GatewayControlEventOnlyOperationSchema = z.enum(['health_event', 'runtime_status']);

export const GatewayControlRpcCommandResultOperationSchema =
	GatewayControlRpcOperationSchema.exclude(GatewayControlEventOnlyOperationSchema.options);

export const GatewayControlRpcMessageSchema = z.union([
	GatewayControlHeartbeatMessageSchema,
	GatewayControlRpcCommandMessageSchema,
	GatewayControlRpcEventMessageSchema,
	GatewayControlRpcCommandResultMessageSchema,
]);

export const gatewayControlDeliveryPolicyByKind = {
	heartbeat: 'critical_idempotent',
} as const satisfies Partial<Record<ControlMessageKind, ControlDeliveryPolicy>>;

export const gatewayControlDeliveryPolicyByOperation = {
	caller_context_register: 'critical_idempotent',
	control_ping: 'acked_idempotent',
	health_event: 'append_only_observation',
	lease_create: 'critical_idempotent',
	lease_get: 'acked_idempotent',
	lease_peek: 'acked_idempotent',
	lease_release: 'acked_idempotent',
	lease_renew: 'single_use_critical',
	lease_use_end: 'acked_idempotent',
	lease_use_heartbeat: 'single_use_critical',
	lease_use_start: 'critical_idempotent',
	operation_cancel: 'acked_idempotent',
	recovery_command: 'critical_idempotent',
	runtime_status: 'latest_wins',
	tool_portal_controller_host_action: 'single_use_critical',
} as const satisfies Record<GatewayControlRpcOperation, ControlDeliveryPolicy>;

export const gatewayControlCommandExecutionTimeoutMsByOperation = {
	caller_context_register: 5_000,
	control_ping: 5_000,
	health_event: 5_000,
	lease_create: 180_000,
	lease_get: 5_000,
	lease_peek: 5_000,
	lease_release: 5_000,
	lease_renew: 10_000,
	lease_use_end: 5_000,
	lease_use_heartbeat: 5_000,
	lease_use_start: 10_000,
	operation_cancel: 5_000,
	recovery_command: 10_000,
	runtime_status: 5_000,
	tool_portal_controller_host_action: 120_000,
} as const satisfies Record<GatewayControlRpcOperation, number>;

export type GatewayControlRpcOperation = z.infer<typeof GatewayControlRpcOperationSchema>;
export type GatewayControlRpcMessage = z.infer<typeof GatewayControlRpcMessageSchema>;
export type GatewayControlControllerToGatewayEvents =
	ControlSessionControllerToPeerEvents<GatewayControlRpcMessage>;
export type GatewayControlGatewayToControllerEvents =
	ControlSessionPeerToControllerEvents<GatewayControlRpcMessage>;
export type GatewayControlCallerContextRef = z.infer<typeof GatewayControlCallerContextRefSchema>;
export type GatewayControlCallerContextRegisterPayload = z.infer<
	typeof GatewayControlCallerContextRegisterPayloadSchema
>;
export type GatewayControlLeaseCreateIntentPayload = z.infer<
	typeof GatewayControlLeaseCreateIntentPayloadSchema
>;
export type GatewayControlLeaseIdPayload = z.infer<typeof GatewayControlLeaseIdPayloadSchema>;
export type GatewayControlLeaseSnapshot = z.infer<typeof GatewayControlLeaseSnapshotSchema>;
export type GatewayControlLeaseUseEndPayload = z.infer<
	typeof GatewayControlLeaseUseEndPayloadSchema
>;
export type GatewayControlLeaseUseHeartbeatPayload = z.infer<
	typeof GatewayControlLeaseUseHeartbeatPayloadSchema
>;
export type GatewayControlLeaseUseSnapshot = z.infer<typeof GatewayControlLeaseUseSnapshotSchema>;
export type GatewayControlLeaseUseStartPayload = z.infer<
	typeof GatewayControlLeaseUseStartPayloadSchema
>;
export type GatewayControlProviderRuntimeHealth = z.infer<
	typeof GatewayControlProviderRuntimeHealthSchema
>;
export type GatewayControlHeartbeatPayload = z.infer<typeof GatewayControlHeartbeatPayloadSchema>;
export type GatewayControlHealthEventPayload = z.infer<
	typeof GatewayControlHealthEventPayloadSchema
>;
export type GatewayControlRuntimeStatusPayload = z.infer<
	typeof GatewayControlRuntimeStatusPayloadSchema
>;
export type GatewayControlToolPortalControllerHostActionPayload = z.infer<
	typeof GatewayControlToolPortalControllerHostActionPayloadSchema
>;
export type GatewayControlToolPortalControllerHostActionResult = z.infer<
	typeof GatewayControlToolPortalControllerHostActionResultSchema
>;
export type GatewayControlZoneGitPushResult = z.infer<typeof GatewayControlZoneGitPushResultSchema>;

export function buildGatewayControlJsonSchemas(): Readonly<Record<string, unknown>> {
	return {
		domain: z.toJSONSchema(GatewayControlDomainSchema, {
			io: 'input',
			unrepresentable: 'any',
		}),
		message: z.toJSONSchema(GatewayControlRpcMessageSchema, {
			io: 'input',
			unrepresentable: 'any',
		}),
		operation: z.toJSONSchema(GatewayControlRpcOperationSchema, {
			io: 'input',
			unrepresentable: 'any',
		}),
	};
}

export function assertGatewayControlDomainRegistered(): 'gateway_control' {
	return KnownControlDomainSchema.extract(['gateway_control']).parse('gateway_control');
}
