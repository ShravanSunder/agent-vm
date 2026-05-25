import { resolveMcpPortalProfile } from '@agent-vm/config-contracts';
import { hashCallArguments, signApprovalToken } from '@agent-vm/mcp-portal/portal-auth/hmac-token';

import type {
	OpenClawBeforeToolCallEvent,
	OpenClawBeforeToolCallResult,
	OpenClawPluginHookContext,
} from './openclaw-plugin-api.js';
import type { PortalPluginRuntimeState } from './portal-plugin-runtime-state.js';
import {
	profileAllowsPortalCall,
	profilePortalCallDecision,
	type PortalCallRequest,
} from './portal-tool-policy.js';

export interface CreateBeforeToolCallHandlerProps {
	readonly logger?: {
		readonly warn?: (message: string) => void;
	};
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

function approvalTokenForCalls(props: {
	readonly agentId: string;
	readonly calls: readonly PortalCallRequest[];
	readonly key: Buffer;
	readonly nowMs?: number;
}): string {
	const nowMs = props.nowMs ?? Date.now();
	return signApprovalToken({
		agentId: props.agentId,
		calls: props.calls.map((call) => ({
			argumentsHash: hashCallArguments(call.arguments),
			namespace: call.namespace,
			toolName: call.toolName,
		})),
		expiresAtMs: nowMs + 60_000,
		issuedAtMs: nowMs,
		key: props.key,
	});
}

export function createBeforeToolCallHandler(
	props: CreateBeforeToolCallHandlerProps,
): (
	event: OpenClawBeforeToolCallEvent,
	context: OpenClawPluginHookContext,
) => Promise<OpenClawBeforeToolCallResult | undefined> {
	return async (event, context) => {
		if (event.toolName !== 'mcp_portal_call') {
			return undefined;
		}
		if (context.agentId === undefined) {
			return {
				block: true,
				blockReason: `mcp-portal: missing OpenClaw agent context for ${event.toolName}.`,
			};
		}
		const portalConfig = await props.runtimeState.loadPortalConfig();
		const agentId = context.agentId;
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

		const approvalCalls: PortalCallRequest[] = [];
		for (const call of calls) {
			const decision = profilePortalCallDecision(profile, call);
			if (decision.kind === 'blocked') {
				return {
					block: true,
					blockReason: `policy: ${agentId}/${call.namespace}/${call.toolName} is not callable`,
				};
			}
			if (decision.kind === 'requires_approval') {
				approvalCalls.push(call);
			}
		}
		if (approvalCalls.length === 0) {
			return undefined;
		}
		if (approvalCalls.length !== calls.length) {
			return undefined;
		}

		const toolNames = approvalCalls
			.map((call) => `${call.namespace}.${call.toolName}`)
			.toSorted()
			.join(', ');
		let portalApprovalToken: string | undefined;
		try {
			portalApprovalToken = approvalTokenForCalls({
				agentId,
				calls: approvalCalls,
				key: props.runtimeState.getApprovalHmacKey(),
			});
		} catch (error) {
			props.logger?.warn?.(
				`mcp-portal: failed to sign OpenClaw approval token: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
		return {
			...(portalApprovalToken === undefined
				? {}
				: { params: { ...event.params, portalApprovalToken } }),
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
