import {
	mcpPortalCallPolicyDecision,
	type McpPortalCallPolicyDecision,
	type ResolvedMcpPortalProfile,
} from '@agent-vm/config-contracts';

export interface PortalCallRequest {
	readonly arguments: Record<string, unknown>;
	readonly id: string;
	readonly namespace: string;
	readonly toolName: string;
}

export function profileAllowsPortalCall(
	profile: ResolvedMcpPortalProfile,
	call: { readonly namespace: string; readonly toolName: string },
): boolean {
	if (!profile.enabledNamespaces.includes(call.namespace)) {
		return false;
	}
	const enabledTools = profile.enabledToolsByNamespace[call.namespace];
	if (enabledTools !== undefined && !enabledTools.includes(call.toolName)) {
		return false;
	}
	const hiddenTools = profile.hiddenToolsByNamespace[call.namespace] ?? [];
	return !hiddenTools.includes(call.toolName);
}

export function profilePortalCallDecision(
	profile: ResolvedMcpPortalProfile,
	call: { readonly namespace: string; readonly toolName: string },
): McpPortalCallPolicyDecision {
	return mcpPortalCallPolicyDecision(profile, call);
}
