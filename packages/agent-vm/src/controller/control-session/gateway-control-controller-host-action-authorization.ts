import path from 'node:path';

import {
	createToolPortalControllerHostActionProjection,
	type ToolPortalToolSelector,
} from '@agent-vm/config-contracts';
import type { GatewayControlToolPortalControllerHostActionPayload } from '@agent-vm/gateway-control-contracts';

import type { SystemConfig } from '../../config/system-config.js';
import { loadMcpPortalEffectiveToolPortalConfigSnapshot } from '../../gateway/mcp-portal-effective-config.js';
import type {
	GatewayControlAcceptedSessionRef,
	GatewayControlTrustedCallerContext,
} from './gateway-control-caller-context.js';

const controllerHostActionNamespace = 'controller_host_action';
const workspaceGitPushToolName = 'workspace_git_push';
const controllerHostProbeToolName = 'controller_host_probe';
const controllerHostProbeEnvGate = 'AGENT_VM_E2E_CONTROLLER_HOST_PROBE';

export interface GatewayControlControllerHostActionAuthorizationRequest {
	readonly callerContext: GatewayControlTrustedCallerContext;
	readonly payload: GatewayControlToolPortalControllerHostActionPayload;
	readonly session: GatewayControlAcceptedSessionRef;
	readonly systemConfig: SystemConfig;
}

export type GatewayControlControllerHostActionAuthorizationResult =
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
): GatewayControlControllerHostActionAuthorizationResult {
	return {
		authorized: false,
		errorClass,
		safeMessage,
	};
}

function isSupportedControllerHostActionName(
	value: string | undefined,
): value is typeof workspaceGitPushToolName | typeof controllerHostProbeToolName {
	return value === workspaceGitPushToolName || value === controllerHostProbeToolName;
}

export async function authorizeGatewayControlControllerHostAction(
	request: GatewayControlControllerHostActionAuthorizationRequest,
): Promise<GatewayControlControllerHostActionAuthorizationResult> {
	const capability = request.payload.correlation?.capability;
	if (
		capability?.namespace !== controllerHostActionNamespace ||
		!isSupportedControllerHostActionName(capability.name) ||
		capability.name !== request.payload.actionId
	) {
		return rejectAuthorization(
			'controller_host_action_capability_mismatch',
			'controller host action capability is not authorized',
		);
	}

	const zone = request.systemConfig.zones.find(
		(configuredZone) => configuredZone.id === request.session.zoneId,
	);
	if (zone === undefined || zone.gateway.type === 'worker') {
		return rejectAuthorization(
			'controller_host_action_zone_unsupported',
			'controller host action zone is not supported',
		);
	}
	if (zone.toolPortal === undefined) {
		return rejectAuthorization(
			'controller_host_action_not_configured',
			'controller host action is not configured for this zone',
		);
	}
	if (request.payload.actionId === workspaceGitPushToolName) {
		const configuredAgent = zone.agents?.find(
			(agent) => agent.id === request.callerContext.agentId,
		);
		if (configuredAgent?.workspaceGit?.mode !== 'remote') {
			return rejectAuthorization(
				'controller_host_action_not_configured',
				'controller host action is not configured for this agent',
			);
		}
	}
	if (
		request.payload.actionId === controllerHostProbeToolName &&
		process.env[controllerHostProbeEnvGate] !== '1'
	) {
		return rejectAuthorization(
			'controller_host_action_not_configured',
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
			'controller_host_action_policy_unavailable',
			'controller host action policy is unavailable',
		);
	}

	let projection: ReturnType<typeof createToolPortalControllerHostActionProjection>;
	try {
		projection = createToolPortalControllerHostActionProjection({
			agentId: request.callerContext.agentId,
			config: effectiveConfig.effectiveToolPortalConfig,
		});
	} catch {
		return rejectAuthorization(
			'controller_host_action_policy_denied',
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
			'controller_host_action_policy_denied',
			'controller host action policy denied the requested capability',
		);
	}

	return { authorized: true };
}
