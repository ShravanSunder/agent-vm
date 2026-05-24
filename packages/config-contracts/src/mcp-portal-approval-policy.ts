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

function namespaceSelectorMatches(
	profile: ResolvedMcpPortalProfile,
	selectorKind: 'requiresApproval' | 'withoutApproval',
	namespace: string,
	toolName: string,
): boolean {
	const selector = (profile.approval.callPoliciesByNamespace ?? {})[namespace]?.[selectorKind];
	if (selector === undefined) {
		return false;
	}
	if ((selector.deny ?? []).includes(toolName)) {
		return false;
	}
	return selector.allow === '*' || selector.allow.includes(toolName);
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

export type McpPortalCallPolicyDecision =
	| { readonly kind: 'allow_without_approval' }
	| { readonly kind: 'blocked' }
	| { readonly kind: 'requires_approval' };

export function mcpPortalCallPolicyDecision(
	profile: ResolvedMcpPortalProfile,
	call: McpPortalApprovalToolCall,
): McpPortalCallPolicyDecision {
	if (
		selectorMatches(profile.approval.allowWithoutApprovalTools, call.namespace, call.toolName) ||
		namespaceSelectorMatches(profile, 'withoutApproval', call.namespace, call.toolName) ||
		hasTrustedReadOnlyAnnotation(profile, call)
	) {
		return { kind: 'allow_without_approval' };
	}
	if (profile.approval.annotationPolicy === 'always-require-approval') {
		return { kind: 'requires_approval' };
	}
	if (
		selectorMatches(profile.approval.alwaysAskTools, call.namespace, call.toolName) ||
		selectorMatches(profile.approval.writeTools, call.namespace, call.toolName) ||
		namespaceSelectorMatches(profile, 'requiresApproval', call.namespace, call.toolName)
	) {
		return { kind: 'requires_approval' };
	}
	return { kind: 'blocked' };
}

export function mcpPortalCallRequiresApproval(
	profile: ResolvedMcpPortalProfile,
	call: McpPortalApprovalToolCall,
): boolean {
	return mcpPortalCallPolicyDecision(profile, call).kind === 'requires_approval';
}
