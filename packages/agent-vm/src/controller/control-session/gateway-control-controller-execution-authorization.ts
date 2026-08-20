import path from 'node:path';

import {
	createToolPortalControllerExecutionProjection,
	type ToolPortalToolSelector,
} from '@agent-vm/config-contracts';
import type { GatewayControlToolPortalControllerExecutionPayload } from '@agent-vm/gateway-control-contracts';
import {
	deriveGatewayControlControllerExecutionRpcWindow,
	deriveGatewayRuntimePortalBindingRevision,
} from '@agent-vm/gateway-control-contracts';

import type { SystemConfig } from '../../config/system-config.js';
import { loadMcpPortalEffectiveToolPortalConfigSnapshot } from '../../gateway/mcp-portal-effective-config.js';
import type {
	GatewayControlAcceptedSessionRef,
	GatewayControlTrustedCallerContext,
} from './gateway-control-caller-context.js';

const controllerExecutionNamespace = 'controller_execution';
const workspaceGitPushToolName = 'workspace_git_push';
const controllerHostProbeToolName = 'controller_host_probe';
const controllerHostProbeEnvGate = 'AGENT_VM_E2E_CONTROLLER_HOST_PROBE';

export interface GatewayControlControllerExecutionAuthorizationRequest {
	readonly callerContext: GatewayControlTrustedCallerContext;
	readonly createdAtMs?: number;
	readonly expiresAtMs?: number;
	readonly payload: GatewayControlToolPortalControllerExecutionPayload;
	readonly session: GatewayControlAcceptedSessionRef;
	readonly systemConfig: SystemConfig;
}

export type GatewayControlControllerExecutionAuthorizationResult =
	| {
			readonly authorized: true;
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
): value is typeof workspaceGitPushToolName | typeof controllerHostProbeToolName {
	return value === workspaceGitPushToolName || value === controllerHostProbeToolName;
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
			(capability.namespace !== controllerExecutionNamespace ||
				!isSupportedControllerExecutionName(capability.name) ||
				capability.name !== request.payload.action.actionId)) ||
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
	let effectiveConfig: Awaited<ReturnType<typeof loadMcpPortalEffectiveToolPortalConfigSnapshot>>;
	try {
		effectiveConfig = await loadMcpPortalEffectiveToolPortalConfigSnapshot(
			path.join(request.systemConfig.cacheDir, 'gateways', zone.id, 'tool-portal-effective'),
		);
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
	const approvalReservation =
		request.payload.kind === 'configured_cli'
			? request.payload.approvalReservation
			: request.payload.action.approvalReservation;
	if (
		approvalReservation !== undefined &&
		approvalReservation.bindingRevision !==
			deriveGatewayRuntimePortalBindingRevision(effectiveConfig.effectiveToolPortalConfig)
	) {
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
		const expectedWindow = deriveGatewayControlControllerExecutionRpcWindow({
			input: request.payload.input,
			nowMs: request.createdAtMs,
			targetKind: configuredOperation.executionTarget.kind,
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
		!selectorIncludesTool(namespaceProjection.tools, capability.name) ||
		(approvalReservation === undefined
			? !selectorIncludesTool(namespaceProjection.calls.withoutApproval, capability.name) ||
				selectorIncludesTool(namespaceProjection.calls.requiresApproval, capability.name)
			: !selectorIncludesTool(namespaceProjection.calls.requiresApproval, capability.name))
	) {
		return rejectAuthorization(
			'controller_execution_policy_denied',
			'controller execution policy denied the requested capability',
		);
	}

	return { authorized: true };
}
