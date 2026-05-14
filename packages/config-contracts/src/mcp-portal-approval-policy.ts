import type { NamespaceToolRef, ResolvedMcpPortalProfile } from './mcp-portal-config.js';

export interface McpPortalApprovalToolAnnotations {
	readonly destructiveHint?: boolean | undefined;
	readonly readOnlyHint?: boolean | undefined;
}

export interface McpPortalApprovalToolCall {
	readonly annotations?: McpPortalApprovalToolAnnotations;
	readonly namespace: string;
	readonly toolName: string;
}

function selectorMatches(
	selectors: readonly NamespaceToolRef[],
	namespace: string,
	toolName: string,
): boolean {
	return selectors.some(
		(selector) => selector.namespace === namespace && selector.toolName === toolName,
	);
}

function hasTrustedReadOnlyAnnotation(
	profile: ResolvedMcpPortalProfile,
	call: McpPortalApprovalToolCall,
): boolean {
	return (
		profile.approval.annotationPolicy === 'destructive-requires-approval' &&
		profile.approval.trustedAnnotationNamespaces.includes(call.namespace) &&
		call.annotations?.readOnlyHint === true &&
		call.annotations.destructiveHint !== true
	);
}

export function mcpPortalCallRequiresApproval(
	profile: ResolvedMcpPortalProfile,
	call: McpPortalApprovalToolCall,
): boolean {
	if (selectorMatches(profile.approval.allowWithoutApprovalTools, call.namespace, call.toolName)) {
		return false;
	}
	if (profile.approval.annotationPolicy === 'always-require-approval') {
		return true;
	}
	if (
		selectorMatches(profile.approval.alwaysAskTools, call.namespace, call.toolName) ||
		selectorMatches(profile.approval.writeTools, call.namespace, call.toolName)
	) {
		return true;
	}
	return !hasTrustedReadOnlyAnnotation(profile, call);
}
