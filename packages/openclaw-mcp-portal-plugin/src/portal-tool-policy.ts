import {
	mcpPortalCallRequiresApproval,
	type ResolvedMcpPortalProfile,
} from '@agent-vm/config-contracts';

export interface PortalCallRequest {
	readonly arguments: Record<string, unknown>;
	readonly id: string;
	readonly namespace: string;
	readonly toolName: string;
}

function encodePortalServerNameSegment(value: string): string {
	const encodedCharacters: string[] = [];
	for (let index = 0; index < value.length; index += 1) {
		const character = value.charAt(index);
		if (/^[A-Za-z0-9]$/u.test(character)) {
			encodedCharacters.push(character);
		} else {
			encodedCharacters.push(`_${character.charCodeAt(0).toString(16).padStart(2, '0')}_`);
		}
	}
	return encodedCharacters.join('');
}

export function portalServerNameForAgent(agentId: string): string {
	return `mcp_portal_${encodePortalServerNameSegment(agentId)}`;
}

export function materializedPortalToolNames(serverName: string): readonly string[] {
	return [
		`${serverName}__mcp_portal_list`,
		`${serverName}__mcp_portal_search`,
		`${serverName}__mcp_portal_describe`,
		`${serverName}__mcp_portal_call`,
	];
}

export function profileAllowsPortalCall(
	profile: ResolvedMcpPortalProfile,
	call: { readonly namespace: string; readonly toolName: string },
): boolean {
	if (!profile.enabledNamespaces.includes(call.namespace)) {
		return false;
	}
	const enabledTools = profile.enabledToolsByNamespace[call.namespace] ?? [];
	if (enabledTools.length > 0 && !enabledTools.includes(call.toolName)) {
		return false;
	}
	const hiddenTools = profile.hiddenToolsByNamespace[call.namespace] ?? [];
	return !hiddenTools.includes(call.toolName);
}

export function profileRequiresPortalApproval(
	profile: ResolvedMcpPortalProfile,
	call: { readonly namespace: string; readonly toolName: string },
): boolean {
	return mcpPortalCallRequiresApproval(profile, call);
}
