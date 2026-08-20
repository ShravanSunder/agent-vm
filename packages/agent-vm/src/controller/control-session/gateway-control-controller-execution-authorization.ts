import path from 'node:path';

import {
	createToolPortalControllerExecutionProjection,
	type ToolPortalToolSelector,
} from '@agent-vm/config-contracts';
import type { GatewayControlToolPortalControllerExecutionPayload } from '@agent-vm/gateway-control-contracts';

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
	const capability = request.payload.correlation?.capability;
	if (
		capability?.namespace !== controllerExecutionNamespace ||
		!isSupportedControllerExecutionName(capability.name) ||
		capability.name !== request.payload.actionId
	) {
		return rejectAuthorization(
			'controller_execution_capability_mismatch',
			'controller host action capability is not authorized',
		);
	}

	const zone = request.systemConfig.zones.find(
		(configuredZone) => configuredZone.id === request.session.zoneId,
	);
	if (zone === undefined || zone.gateway.type === 'worker') {
		return rejectAuthorization(
			'controller_execution_zone_unsupported',
			'controller host action zone is not supported',
		);
	}
	if (zone.toolPortal === undefined) {
		return rejectAuthorization(
			'controller_execution_not_configured',
			'controller host action is not configured for this zone',
		);
	}
	if (request.payload.actionId === workspaceGitPushToolName) {
		const configuredAgent = zone.agents?.find(
			(agent) => agent.id === request.callerContext.agentId,
		);
		if (configuredAgent?.workspaceGit?.mode !== 'remote') {
			return rejectAuthorization(
				'controller_execution_not_configured',
				'controller host action is not configured for this agent',
			);
		}
	}
	if (
		request.payload.actionId === controllerHostProbeToolName &&
		process.env[controllerHostProbeEnvGate] !== '1'
	) {
		return rejectAuthorization(
			'controller_execution_not_configured',
			'controller host probe is not enabled',
		);
	}
	if (request.payload.approvalReservation !== undefined) {
		return { authorized: true };
	}

	let effectiveConfig: Awaited<ReturnType<typeof loadMcpPortalEffectiveToolPortalConfigSnapshot>>;
	try {
		effectiveConfig = await loadMcpPortalEffectiveToolPortalConfigSnapshot(
			path.join(request.systemConfig.cacheDir, 'gateways', zone.id, 'tool-portal-effective'),
		);
	} catch {
		return rejectAuthorization(
			'controller_execution_policy_unavailable',
			'controller host action policy is unavailable',
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
			'controller host action policy denied the requested capability',
		);
	}
	const namespaceProjection = projection.namespaces[capability.namespace];
	if (
		namespaceProjection === undefined ||
		!selectorIncludesTool(namespaceProjection.tools, capability.name) ||
		!selectorIncludesTool(namespaceProjection.calls.withoutApproval, capability.name) ||
		selectorIncludesTool(namespaceProjection.calls.requiresApproval, capability.name)
	) {
		return rejectAuthorization(
			'controller_execution_policy_denied',
			'controller host action policy denied the requested capability',
		);
	}

	return { authorized: true };
}
