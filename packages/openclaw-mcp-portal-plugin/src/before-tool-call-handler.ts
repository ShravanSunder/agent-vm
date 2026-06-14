import { resolveMcpPortalProfile } from '@agent-vm/config-contracts';
import {
	signApprovalToken,
	type ApprovalTokenCallDigest,
} from '@agent-vm/mcp-portal/portal-auth/hmac-token';

import type {
	OpenClawBeforeToolCallEvent,
	OpenClawBeforeToolCallResult,
	OpenClawPluginHookContext,
} from './openclaw-plugin-api.js';
import { normalizeOpenClawToolParamsRecord } from './openclaw-tool-params.js';
import type { PortalPluginRuntimeState } from './portal-plugin-runtime-state.js';
import {
	profileAllowsPortalCall,
	profilePortalCallDecision,
	type PortalCallRequest,
} from './portal-tool-policy.js';

const approvalPromptTimeoutMs = 60_000;
const approvalTokenLifetimeMs = 5 * 60_000;

type ApprovalTokenCallDigestMap = Readonly<Record<string, ApprovalTokenCallDigest>>;

export interface CreateBeforeToolCallHandlerProps {
	readonly logger?: {
		readonly error?: (message: string) => void;
		readonly warn?: (message: string) => void;
	};
	readonly resolveApprovalTokenCallDigests: (props: {
		readonly agentId: string;
		readonly approvalCalls: readonly PortalCallRequest[];
		readonly context: OpenClawPluginHookContext;
		readonly params: Record<string, unknown>;
	}) => Promise<ApprovalTokenCallDigestMap | null> | ApprovalTokenCallDigestMap | null;
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

function approvalTokenForCallDigests(props: {
	readonly agentId: string;
	readonly callDigests: readonly ApprovalTokenCallDigest[];
	readonly key: Buffer;
	readonly nowMs?: number;
}): string {
	const nowMs = props.nowMs ?? Date.now();
	return signApprovalToken({
		agentId: props.agentId,
		calls: props.callDigests,
		expiresAtMs: nowMs + approvalTokenLifetimeMs,
		issuedAtMs: nowMs,
		key: props.key,
	});
}

function redactApprovalPreviewValue(key: string, value: unknown): unknown {
	if (/token|secret|password|credential|api[-_]?key/iu.test(key)) {
		return '[redacted]';
	}
	if (Array.isArray(value)) {
		return value.map((entry) => redactApprovalPreviewValue(key, entry));
	}
	if (typeof value === 'object' && value !== null) {
		return Object.fromEntries(
			Object.entries(value).map(([entryKey, entryValue]) => [
				entryKey,
				redactApprovalPreviewValue(entryKey, entryValue),
			]),
		);
	}
	return value;
}

function approvalCallPreview(call: PortalCallRequest): string {
	const redactedArguments = redactApprovalPreviewValue('arguments', call.arguments);
	const serializedArguments = JSON.stringify(redactedArguments);
	const preview =
		serializedArguments.length > 500
			? `${serializedArguments.slice(0, 497)}...`
			: serializedArguments;
	return `${call.id}: ${call.namespace}.${call.toolName} args=${preview}`;
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
		const params = normalizeOpenClawToolParamsRecord(event.params);
		if (params === null) {
			return { block: true, blockReason: 'mcp-portal: malformed portal call batch.' };
		}
		const calls = parseCallRequests(params);
		if (calls === null || calls.length === 0) {
			return { block: true, blockReason: 'mcp-portal: malformed portal call batch.' };
		}

		const disabledCalls = calls.filter((call) => !profileAllowsPortalCall(profile, call));
		if (disabledCalls.length > 0) {
			if (disabledCalls.length === calls.length) {
				const call = disabledCalls[0];
				return {
					block: true,
					blockReason:
						call === undefined
							? `policy: ${agentId} has no enabled MCP Portal calls in this batch`
							: `policy: ${agentId}/${call.namespace}/${call.toolName} not enabled`,
				};
			}
		}

		const approvalCalls: PortalCallRequest[] = [];
		for (const call of calls) {
			const decision = profilePortalCallDecision(profile, call);
			if (decision.kind === 'requires_approval') {
				approvalCalls.push(call);
			}
		}
		if (approvalCalls.length === 0) {
			return undefined;
		}

		const promptApprovalCalls: PortalCallRequest[] = [];
		const callDigests: ApprovalTokenCallDigest[] = [];
		let portalApprovalToken: string;
		try {
			const callDigestsByCallId = await props.resolveApprovalTokenCallDigests({
				agentId,
				approvalCalls,
				context,
				params,
			});
			if (callDigestsByCallId === null) {
				return undefined;
			}
			for (const call of approvalCalls) {
				const callDigest = callDigestsByCallId[call.id];
				if (callDigest !== undefined) {
					promptApprovalCalls.push(call);
					callDigests.push(callDigest);
				}
			}
			if (promptApprovalCalls.length === 0) {
				return undefined;
			}
			portalApprovalToken = approvalTokenForCallDigests({
				agentId,
				callDigests,
				key: props.runtimeState.getApprovalHmacKey(),
			});
		} catch (error) {
			const message = `mcp-portal: failed to prepare approval token: ${
				error instanceof Error ? error.message : String(error)
			}`;
			props.logger?.error?.(message);
			return { block: true, blockReason: message };
		}
		const toolNames = promptApprovalCalls
			.map((call) => `${call.namespace}.${call.toolName}`)
			.toSorted()
			.join(', ');
		const approvalPreview = promptApprovalCalls.map(approvalCallPreview).join('\n');
		return {
			params: { ...params, portalApprovalToken },
			requireApproval: {
				description: `Allow MCP Portal batch for agent ${agentId}:\n${approvalPreview}`,
				pluginId: 'mcp-portal',
				severity: 'warning',
				timeoutBehavior: 'deny',
				timeoutMs: approvalPromptTimeoutMs,
				title: `MCP Portal batch: ${toolNames}`,
			},
		};
	};
}
