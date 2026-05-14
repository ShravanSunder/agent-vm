import { resolveMcpPortalProfile } from '@agent-vm/config-contracts';
import { hashCallArguments, signApprovalToken } from '@agent-vm/mcp-portal';

import type {
	OpenClawBeforeToolCallEvent,
	OpenClawBeforeToolCallResult,
	OpenClawPluginHookContext,
} from './openclaw-plugin-api.js';
import type { PortalPluginRuntimeState } from './portal-plugin-runtime-state.js';
import {
	portalServerNameForAgent,
	profileAllowsPortalCall,
	profileRequiresPortalApproval,
	type PortalCallRequest,
} from './portal-tool-policy.js';

const approvalTokenTtlMs = 60_000;

export interface CreateBeforeToolCallHandlerProps {
	readonly runtimeState: PortalPluginRuntimeState;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCallRequest(value: unknown): PortalCallRequest | null {
	if (!isObjectRecord(value)) {
		return null;
	}
	const id = value.id;
	const namespace = value.namespace;
	const toolName = value.toolName;
	const argumentsValue = value.arguments;
	if (
		typeof id !== 'string' ||
		typeof namespace !== 'string' ||
		typeof toolName !== 'string' ||
		!isObjectRecord(argumentsValue)
	) {
		return null;
	}
	return { arguments: argumentsValue, id, namespace, toolName };
}

function portalAgentIdFromToolName(toolName: string, agentIds: readonly string[]): string | null {
	return (
		agentIds.find((agentId) =>
			toolName.startsWith(`${portalServerNameForAgent(agentId)}__mcp_portal_`),
		) ?? null
	);
}

function parseCallRequests(params: Record<string, unknown>): readonly PortalCallRequest[] | null {
	const calls = params.calls;
	if (!Array.isArray(calls)) {
		return null;
	}
	const parsedCalls: PortalCallRequest[] = [];
	for (const call of calls) {
		const parsedCall = parseCallRequest(call);
		if (parsedCall === null) {
			return null;
		}
		parsedCalls.push(parsedCall);
	}
	return parsedCalls;
}

export function createBeforeToolCallHandler(
	props: CreateBeforeToolCallHandlerProps,
): (
	event: OpenClawBeforeToolCallEvent,
	context: OpenClawPluginHookContext,
) => Promise<OpenClawBeforeToolCallResult | undefined> {
	return async (event, context) => {
		const portalConfig = await props.runtimeState.loadPortalConfig();
		const agentId = portalAgentIdFromToolName(event.toolName, Object.keys(portalConfig.agents));
		if (agentId === null) {
			return undefined;
		}
		const portalUnavailableReason = props.runtimeState.getPortalUnavailableReason();
		if (portalUnavailableReason !== null) {
			return {
				block: true,
				blockReason: `mcp-portal: portal subprocess unavailable (${portalUnavailableReason}).`,
			};
		}
		if (context.agentId === undefined) {
			return {
				block: true,
				blockReason: `mcp-portal: missing OpenClaw agent context for ${event.toolName}.`,
			};
		}
		if (context.agentId !== undefined && context.agentId !== agentId) {
			return {
				block: true,
				blockReason: `mcp-portal: tool ${event.toolName} is not assigned to agent ${context.agentId}.`,
			};
		}
		if (!event.toolName.endsWith('__mcp_portal_call')) {
			return undefined;
		}
		const agent = portalConfig.agents[agentId];
		if (agent === undefined) {
			return { block: true, blockReason: `mcp-portal: agent "${agentId}" is not configured.` };
		}
		const profile = resolveMcpPortalProfile(portalConfig, agent.profile);
		const calls = parseCallRequests(event.params);
		if (calls === null || calls.length === 0) {
			return { block: true, blockReason: 'mcp-portal: malformed portal call batch.' };
		}

		for (const call of calls) {
			if (!profileAllowsPortalCall(profile, call)) {
				return {
					block: true,
					blockReason: `policy: ${agentId}/${call.namespace}/${call.toolName} not enabled`,
				};
			}
		}

		const approvalCalls = calls.filter((call) => profileRequiresPortalApproval(profile, call));
		if (approvalCalls.length === 0) {
			return undefined;
		}

		const token = signApprovalToken({
			agentId,
			calls: approvalCalls.map((call) => ({
				argumentsHash: hashCallArguments(call.arguments),
				namespace: call.namespace,
				toolName: call.toolName,
			})),
			expiresAtMs: Date.now() + approvalTokenTtlMs,
			key: props.runtimeState.getKeyRegistry().getKey(agentId),
		});
		try {
			event.params.portalApprovalToken = token;
		} catch {
			return {
				block: true,
				blockReason: 'mcp-portal: could not attach server-side approval token.',
			};
		}
		if (event.params.portalApprovalToken !== token) {
			return {
				block: true,
				blockReason: 'mcp-portal: could not attach server-side approval token.',
			};
		}

		const toolNames = approvalCalls
			.map((call) => `${call.namespace}.${call.toolName}`)
			.toSorted()
			.join(', ');
		return {
			requireApproval: {
				description: `Allow MCP Portal batch for agent ${agentId}: ${toolNames}.`,
				pluginId: 'mcp-portal',
				severity: 'warning',
				timeoutBehavior: 'deny',
				timeoutMs: 60_000,
				title: `MCP Portal batch: ${toolNames}`,
			},
		};
	};
}
