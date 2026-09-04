import path from 'node:path';

import {
	createToolPortalControllerExecutionProjection,
	jsonObjectSchema,
	type ToolPortalToolSelector,
} from '@agent-vm/config-contracts';
import type {
	GatewayControlToolPortalControllerExecutionPayload,
	GatewayRuntimeControllerExecutionDispatchReservation,
} from '@agent-vm/gateway-control-contracts';
import {
	assertGatewayRuntimePortalSemanticSnapshotMatchesInputs,
	deriveGatewayControlControllerExecutionRpcWindow,
	deriveGatewayControlStablePrincipal,
	deriveGatewayRuntimeApprovalFingerprint,
	deriveGatewayRuntimeApprovalId,
	deriveGatewayRuntimePortalBindingRevision,
	gatewayControlRegisteredControllerExecutionActionIds,
} from '@agent-vm/gateway-control-contracts';
import { evaluateCliAllowanceInvocation } from '@agent-vm/tool-portal/cli-allowances';
import {
	deterministicOperationId,
	directDispatchFingerprint,
} from '@agent-vm/tool-portal/dispatch-authority';

import type { SystemConfig } from '../../config/system-config.js';
import { loadGatewayRuntimePortalAdmissionFile } from '../../gateway/gateway-runtime-portal-admission-file.js';
import { loadMcpPortalEffectiveToolPortalConfigSnapshot } from '../../gateway/mcp-portal-effective-config.js';
import type { ControllerCredentialedRuntimeRegistryPublisher } from '../credentialed-runtime/credentialed-runtime-registry.js';
import type { ConfiguredCliAuthorizedOperation } from '../runner/configured-cli-authorization.js';
import type {
	GatewayControlAcceptedSessionRef,
	GatewayControlTrustedCallerContext,
} from './gateway-control-caller-context.js';
import { resolveRegisteredOAuthInvocationContext } from './gateway-control-oauth-invocation-context.js';

const controllerExecutionNamespace = 'controller_execution';
const oauthAuthorizationNamespace = 'oauth_authorization';
const controllerHostProbeToolName =
	'controller_host_probe' satisfies (typeof gatewayControlRegisteredControllerExecutionActionIds)[number];
const workspaceGitPushToolName =
	'workspace_git_push' satisfies (typeof gatewayControlRegisteredControllerExecutionActionIds)[number];
const controllerHostProbeEnvGate = 'AGENT_VM_E2E_CONTROLLER_HOST_PROBE';

export interface GatewayControlControllerExecutionAuthorizationRequest {
	readonly callerContext: GatewayControlTrustedCallerContext;
	readonly credentialedRuntimeRegistryPublisher?: ControllerCredentialedRuntimeRegistryPublisher;
	readonly createdAtMs?: number;
	readonly expiresAtMs?: number;
	readonly payload: GatewayControlToolPortalControllerExecutionPayload;
	readonly session: GatewayControlAcceptedSessionRef;
	readonly systemConfig: SystemConfig;
}

export type GatewayControlControllerExecutionAuthorizationResult =
	| {
			readonly authorized: true;
			readonly configuredCli?: ConfiguredCliAuthorizedOperation;
	  }
	| {
			readonly authorized: false;
			readonly errorClass: string;
			readonly safeMessage: string;
	  };

function selectorIncludesTool(selector: ToolPortalToolSelector, toolName: string): boolean {
	if (selector.deny.includes(toolName)) {
		return false;
	}
	return selector.allow === '*' || selector.allow.includes(toolName);
}

function rejectAuthorization(
	errorClass: string,
	safeMessage: string,
): GatewayControlControllerExecutionAuthorizationResult {
	return {
		authorized: false,
		errorClass,
		safeMessage,
	};
}

function isSupportedControllerExecutionName(
	value: string | undefined,
): value is (typeof gatewayControlRegisteredControllerExecutionActionIds)[number] {
	switch (value) {
		case controllerHostProbeToolName:
		case 'oauth_authorization.begin':
		case 'oauth_authorization.cancel':
		case 'oauth_authorization.list':
		case 'oauth_authorization.reauthorize':
		case 'oauth_authorization.revoke':
		case 'oauth_authorization.status':
		case workspaceGitPushToolName:
			return true;
		case undefined:
		default:
			return false;
	}
}

function registeredActionMatchesCapability(props: {
	readonly actionId: string;
	readonly capabilityName: string;
	readonly capabilityNamespace: string;
}): boolean {
	if (!isSupportedControllerExecutionName(props.actionId)) return false;
	if (
		props.actionId === controllerHostProbeToolName ||
		props.actionId === workspaceGitPushToolName
	) {
		return (
			props.capabilityNamespace === controllerExecutionNamespace &&
			props.capabilityName === props.actionId
		);
	}
	return (
		props.capabilityNamespace === oauthAuthorizationNamespace &&
		props.actionId === `${oauthAuthorizationNamespace}.${props.capabilityName}`
	);
}

function registeredActionApprovalReservation(
	payload: Extract<
		GatewayControlToolPortalControllerExecutionPayload,
		{ readonly kind: 'registered_action' }
	>,
): GatewayRuntimeControllerExecutionDispatchReservation | undefined {
	switch (payload.action.actionId) {
		case 'oauth_authorization.begin':
		case 'oauth_authorization.cancel':
		case 'oauth_authorization.list':
		case 'oauth_authorization.reauthorize':
		case 'oauth_authorization.revoke':
		case 'oauth_authorization.status':
			return payload.action.authority.kind === 'controller_approval_reservation'
				? payload.action.authority.reservation
				: undefined;
		case 'controller_host_probe':
		case 'workspace_git_push':
			return payload.action.approvalReservation;
	}
}

export async function authorizeGatewayControlControllerExecution(
	request: GatewayControlControllerExecutionAuthorizationRequest,
): Promise<GatewayControlControllerExecutionAuthorizationResult> {
	const capability =
		request.payload.kind === 'configured_cli'
			? request.payload.capability
			: request.payload.action.correlation?.capability;
	if (
		capability === undefined ||
		(request.payload.kind === 'registered_action' &&
			!registeredActionMatchesCapability({
				actionId: request.payload.action.actionId,
				capabilityName: capability.name,
				capabilityNamespace: capability.namespace,
			})) ||
		(request.payload.kind === 'configured_cli' && capability.name !== request.payload.operationName)
	) {
		return rejectAuthorization(
			'controller_execution_capability_mismatch',
			'controller execution capability is not authorized',
		);
	}

	const zone = request.systemConfig.zones.find(
		(configuredZone) => configuredZone.id === request.session.zoneId,
	);
	if (zone === undefined || zone.gateway.type === 'worker') {
		return rejectAuthorization(
			'controller_execution_zone_unsupported',
			'controller execution zone is not supported',
		);
	}
	if (zone.toolPortal === undefined) {
		return rejectAuthorization(
			'controller_execution_not_configured',
			'controller execution is not configured for this zone',
		);
	}
	if (
		request.payload.kind === 'registered_action' &&
		request.payload.action.actionId === workspaceGitPushToolName
	) {
		const configuredAgent = zone.agents?.find(
			(agent) => agent.id === request.callerContext.agentId,
		);
		if (configuredAgent?.workspaceGit?.mode !== 'remote') {
			return rejectAuthorization(
				'controller_execution_not_configured',
				'controller execution is not configured for this agent',
			);
		}
	}
	if (
		request.payload.kind === 'registered_action' &&
		request.payload.action.actionId === controllerHostProbeToolName &&
		process.env[controllerHostProbeEnvGate] !== '1'
	) {
		return rejectAuthorization(
			'controller_execution_not_configured',
			'controller host probe is not enabled',
		);
	}
	const effectiveConfigDirectory = path.join(
		request.systemConfig.cacheDir,
		'gateways',
		zone.id,
		'tool-portal-effective',
	);
	let effectiveConfig: Awaited<ReturnType<typeof loadMcpPortalEffectiveToolPortalConfigSnapshot>>;
	let portalAdmission: Awaited<ReturnType<typeof loadGatewayRuntimePortalAdmissionFile>>;
	try {
		[effectiveConfig, portalAdmission] = await Promise.all([
			loadMcpPortalEffectiveToolPortalConfigSnapshot(effectiveConfigDirectory),
			loadGatewayRuntimePortalAdmissionFile(effectiveConfigDirectory),
		]);
		assertGatewayRuntimePortalSemanticSnapshotMatchesInputs({
			mcpConfig: portalAdmission.effectiveMcpConfig,
			semanticSnapshot: portalAdmission.semanticSnapshot,
			toolPortalConfig: portalAdmission.effectiveToolPortalConfig,
		});
		assertGatewayRuntimePortalSemanticSnapshotMatchesInputs({
			mcpConfig: effectiveConfig.effectiveMcpConfig,
			semanticSnapshot: portalAdmission.semanticSnapshot,
			toolPortalConfig: effectiveConfig.effectiveToolPortalConfig,
		});
	} catch {
		return rejectAuthorization(
			'controller_execution_policy_unavailable',
			'controller execution policy is unavailable',
		);
	}

	let projection: ReturnType<typeof createToolPortalControllerExecutionProjection>;
	try {
		projection = createToolPortalControllerExecutionProjection({
			agentId: request.callerContext.agentId,
			config: effectiveConfig.effectiveToolPortalConfig,
		});
	} catch {
		return rejectAuthorization(
			'controller_execution_policy_denied',
			'controller execution policy denied the requested capability',
		);
	}
	const namespaceProjection = projection.namespaces[capability.namespace];
	const agentConfig =
		effectiveConfig.effectiveToolPortalConfig.agents[request.callerContext.agentId];
	const profileConfig =
		agentConfig === undefined
			? undefined
			: effectiveConfig.effectiveToolPortalConfig.profiles[agentConfig.profile];
	const namespacePolicy = profileConfig?.namespaces[capability.namespace];
	const configuredOperation =
		namespacePolicy?.backend.kind === 'controller_execution'
			? namespacePolicy.backend.operations[capability.name]
			: undefined;
	const registeredOAuthInvocation = resolveRegisteredOAuthInvocationContext(request.payload);
	const approvalReservation =
		request.payload.kind === 'configured_cli'
			? request.payload.authority.kind === 'controller_approval_reservation'
				? request.payload.authority.reservation
				: undefined
			: registeredActionApprovalReservation(request.payload);
	const expectedBindingRevision =
		request.payload.kind === 'configured_cli'
			? request.payload.authority.kind === 'without_approval'
				? request.payload.authority.bindingRevision
				: request.payload.authority.reservation.bindingRevision
			: registeredOAuthInvocation?.authority.kind === 'without_approval'
				? registeredOAuthInvocation.authority.bindingRevision
				: approvalReservation?.bindingRevision;
	const currentBindingRevision = deriveGatewayRuntimePortalBindingRevision(
		effectiveConfig.effectiveToolPortalConfig,
	);
	if (expectedBindingRevision !== undefined && expectedBindingRevision !== currentBindingRevision) {
		return rejectAuthorization(
			'controller_execution_policy_stale',
			'controller execution approval does not match current trusted policy',
		);
	}
	if (configuredOperation?.kind === 'configured_cli' && request.payload.kind === 'configured_cli') {
		if (request.createdAtMs === undefined) {
			return rejectAuthorization(
				'controller_execution_window_mismatch',
				'controller execution response window does not match current policy',
			);
		}
		const targetKind =
			'executionTarget' in configuredOperation
				? configuredOperation.executionTarget.kind
				: configuredOperation.targetKind;
		if (targetKind === 'tool_vm') {
			return rejectAuthorization(
				'controller_execution_policy_denied',
				'Tool VM configured CLI operations must dispatch inside the Gateway',
			);
		}
		const expectedWindow = deriveGatewayControlControllerExecutionRpcWindow({
			input: request.payload.input,
			nowMs: request.createdAtMs,
			targetKind,
			timeoutKind: configuredOperation.timeout.kind,
		});
		if (request.expiresAtMs !== expectedWindow.expiresAtMs) {
			return rejectAuthorization(
				'controller_execution_window_mismatch',
				'controller execution response window does not match current policy',
			);
		}
	}
	if (
		namespaceProjection === undefined ||
		configuredOperation?.kind !== request.payload.kind ||
		!selectorIncludesTool(namespaceProjection.tools, capability.name)
	) {
		return rejectAuthorization(
			'controller_execution_policy_denied',
			'controller execution policy denied the requested capability',
		);
	}
	if (request.payload.kind === 'configured_cli' && configuredOperation.kind === 'configured_cli') {
		let trustedConfiguredOperation: ConfiguredCliAuthorizedOperation['operation'];
		let credentialedRuntime: ConfiguredCliAuthorizedOperation['credentialedRuntime'];
		if ('executionTarget' in configuredOperation) {
			if (configuredOperation.executionTarget.kind === 'tool_vm') {
				return rejectAuthorization(
					'controller_execution_policy_denied',
					'Tool VM configured CLI operations must dispatch inside the Gateway',
				);
			}
			trustedConfiguredOperation = configuredOperation;
		} else {
			try {
				if (request.credentialedRuntimeRegistryPublisher === undefined) {
					throw new Error('Credentialed runtime registry is unavailable.');
				}
				credentialedRuntime = request.credentialedRuntimeRegistryPublisher.resolve({
					agentId: request.callerContext.agentId,
					cohortRevision: currentBindingRevision,
					namespaceId: capability.namespace,
					operationName: capability.name,
					profileId: agentConfig?.profile ?? '',
					zoneId: request.session.zoneId,
				});
				trustedConfiguredOperation = credentialedRuntime.operation;
			} catch {
				return rejectAuthorization(
					'controller_execution_policy_stale',
					'controller execution policy does not match the current credentialed runtime cohort',
				);
			}
		}
		const baseline = selectorIncludesTool(
			namespaceProjection.calls.withoutApproval,
			capability.name,
		)
			? 'without_approval'
			: selectorIncludesTool(namespaceProjection.calls.requiresApproval, capability.name)
				? 'requires_approval'
				: 'deny';
		const evaluation = evaluateCliAllowanceInvocation({
			allowance: configuredOperation,
			baseline,
			input: request.payload.input,
		});
		const expectedDisposition =
			request.payload.authority.kind === 'without_approval'
				? 'without_approval'
				: 'requires_approval';
		if (evaluation.kind === 'denied' || evaluation.disposition !== expectedDisposition) {
			return rejectAuthorization(
				'controller_execution_policy_denied',
				'controller execution policy denied the requested capability',
			);
		}
		if (
			deriveGatewayControlStablePrincipal({
				principal: request.payload.invocation.trustedContext.principal,
			}) !== request.callerContext.stablePrincipal
		) {
			return rejectAuthorization(
				'controller_execution_authority_mismatch',
				'controller execution authority does not match the requested capability',
			);
		}
		const exactCall = {
			arguments: jsonObjectSchema.parse(request.payload.input),
			id: request.payload.invocation.callId,
			name: capability.name,
			namespace: capability.namespace,
		};
		const expectedOperationId = deterministicOperationId({
			callId: exactCall.id,
			semanticRevision: portalAdmission.semanticSnapshot.activeRevision,
			stablePrincipal: request.callerContext.stablePrincipal,
			surfaceClass: request.payload.invocation.surfaceClass,
		});
		const authorityBinding =
			request.payload.authority.kind === 'without_approval'
				? request.payload.authority
				: request.payload.authority.reservation;
		const expectedFingerprint =
			request.payload.authority.kind === 'without_approval'
				? directDispatchFingerprint({
						backendKind: 'controller_execution',
						call: exactCall,
						principal: request.callerContext.principal,
						semanticSnapshot: portalAdmission.semanticSnapshot,
						surfaceClass: request.payload.invocation.surfaceClass,
					})
				: deriveGatewayRuntimeApprovalFingerprint({
						authorityContext: request.payload.authority.reservation.authorityContext,
						intent: {
							backendKind: 'controller_execution',
							call: exactCall,
							operationId: expectedOperationId,
							semanticRevisions: {
								activeRevision: portalAdmission.semanticSnapshot.activeRevision,
								bindingRevision: portalAdmission.semanticSnapshot.bindingRevision,
								catalogRevision: portalAdmission.semanticSnapshot.catalogRevision,
								profilePolicyRevision: portalAdmission.semanticSnapshot.profilePolicyRevision,
								providerRevision: portalAdmission.semanticSnapshot.providerRevision,
								schemaRevision: portalAdmission.semanticSnapshot.schemaRevision,
							},
							surfaceClass: request.payload.invocation.surfaceClass,
							trustedContext: request.payload.invocation.trustedContext,
						},
					});
		if (
			authorityBinding.operationId !== expectedOperationId ||
			authorityBinding.fingerprint !== expectedFingerprint ||
			(request.payload.authority.kind === 'controller_approval_reservation' &&
				(request.payload.authority.reservation.approvalId !==
					deriveGatewayRuntimeApprovalId(expectedFingerprint) ||
					request.payload.authority.reservation.stablePrincipal !==
						request.callerContext.stablePrincipal))
		) {
			return rejectAuthorization(
				'controller_execution_authority_mismatch',
				'controller execution authority does not match the requested capability',
			);
		}
		return {
			authorized: true,
			configuredCli: {
				...(credentialedRuntime === undefined ? {} : { credentialedRuntime }),
				evaluation: {
					authorityKind: request.payload.authority.kind,
					bindingRevision: currentBindingRevision,
					disposition: evaluation.disposition,
					fingerprint: authorityBinding.fingerprint,
					operationId: authorityBinding.operationId,
					operationName: request.payload.operationName,
					targetKind: trustedConfiguredOperation.executionTarget.kind,
				},
				operation: trustedConfiguredOperation,
			},
		};
	}
	if (registeredOAuthInvocation !== undefined) {
		if (
			deriveGatewayControlStablePrincipal({
				principal: registeredOAuthInvocation.invocation.trustedContext.principal,
			}) !== request.callerContext.stablePrincipal
		) {
			return rejectAuthorization(
				'controller_execution_authority_mismatch',
				'controller execution authority does not match the requested capability',
			);
		}
		const exactCall = {
			arguments: registeredOAuthInvocation.arguments,
			id: registeredOAuthInvocation.invocation.callId,
			name: capability.name,
			namespace: capability.namespace,
		};
		const expectedOperationId = deterministicOperationId({
			callId: exactCall.id,
			semanticRevision: portalAdmission.semanticSnapshot.activeRevision,
			stablePrincipal: request.callerContext.stablePrincipal,
			surfaceClass: registeredOAuthInvocation.invocation.surfaceClass,
		});
		const authorityBinding =
			registeredOAuthInvocation.authority.kind === 'without_approval'
				? registeredOAuthInvocation.authority
				: registeredOAuthInvocation.authority.reservation;
		const expectedFingerprint =
			registeredOAuthInvocation.authority.kind === 'without_approval'
				? directDispatchFingerprint({
						backendKind: 'controller_execution',
						call: exactCall,
						principal: request.callerContext.principal,
						semanticSnapshot: portalAdmission.semanticSnapshot,
						surfaceClass: registeredOAuthInvocation.invocation.surfaceClass,
					})
				: deriveGatewayRuntimeApprovalFingerprint({
						authorityContext: registeredOAuthInvocation.authority.reservation.authorityContext,
						intent: {
							backendKind: 'controller_execution',
							call: exactCall,
							operationId: expectedOperationId,
							semanticRevisions: {
								activeRevision: portalAdmission.semanticSnapshot.activeRevision,
								bindingRevision: portalAdmission.semanticSnapshot.bindingRevision,
								catalogRevision: portalAdmission.semanticSnapshot.catalogRevision,
								profilePolicyRevision: portalAdmission.semanticSnapshot.profilePolicyRevision,
								providerRevision: portalAdmission.semanticSnapshot.providerRevision,
								schemaRevision: portalAdmission.semanticSnapshot.schemaRevision,
							},
							surfaceClass: registeredOAuthInvocation.invocation.surfaceClass,
							trustedContext: registeredOAuthInvocation.invocation.trustedContext,
						},
					});
		if (
			authorityBinding.operationId !== expectedOperationId ||
			authorityBinding.fingerprint !== expectedFingerprint ||
			(registeredOAuthInvocation.authority.kind === 'controller_approval_reservation' &&
				(registeredOAuthInvocation.authority.reservation.approvalId !==
					deriveGatewayRuntimeApprovalId(expectedFingerprint) ||
					registeredOAuthInvocation.authority.reservation.stablePrincipal !==
						request.callerContext.stablePrincipal))
		) {
			return rejectAuthorization(
				'controller_execution_authority_mismatch',
				'controller execution authority does not match the requested capability',
			);
		}
	}
	if (
		approvalReservation === undefined
			? !selectorIncludesTool(namespaceProjection.calls.withoutApproval, capability.name) ||
				selectorIncludesTool(namespaceProjection.calls.requiresApproval, capability.name)
			: !selectorIncludesTool(namespaceProjection.calls.requiresApproval, capability.name)
	) {
		return rejectAuthorization(
			'controller_execution_policy_denied',
			'controller execution policy denied the requested capability',
		);
	}

	return { authorized: true };
}
