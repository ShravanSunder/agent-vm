import type { PortalToolAnnotations } from '@agent-vm/mcp-portal';

import type { NamespaceToolSelector, PortalApprovalConfig } from './portal-config.js';

export type PortalApprovalDecision =
	| { readonly kind: 'allow' }
	| { readonly kind: 'approval_required'; readonly level: 'critical' | 'standard' };

export interface PortalApprovalPolicyInput {
	readonly annotations?: PortalToolAnnotations;
	readonly config: PortalApprovalConfig;
	readonly namespace: string;
	readonly toolName: string;
}

function selectorMatches(
	selector: NamespaceToolSelector,
	namespace: string,
	toolName: string,
): boolean {
	return selector.namespace === namespace && selector.toolName === toolName;
}

function hasSelector(
	selectors: readonly NamespaceToolSelector[],
	namespace: string,
	toolName: string,
): boolean {
	return selectors.some((selector) => selectorMatches(selector, namespace, toolName));
}

export function resolvePortalApprovalDecision(
	input: PortalApprovalPolicyInput,
): PortalApprovalDecision {
	if (hasSelector(input.config.alwaysAskTools, input.namespace, input.toolName)) {
		return { kind: 'approval_required', level: 'standard' };
	}
	if (hasSelector(input.config.writeTools, input.namespace, input.toolName)) {
		return { kind: 'approval_required', level: 'critical' };
	}
	if (hasSelector(input.config.allowWithoutApprovalTools, input.namespace, input.toolName)) {
		return { kind: 'allow' };
	}

	if (!input.config.trustedAnnotationNamespaces.includes(input.namespace)) {
		return { kind: 'approval_required', level: 'standard' };
	}

	if (input.config.annotationPolicy === 'off') {
		return { kind: 'allow' };
	}

	const annotations = input.annotations ?? {};
	if (annotations.destructiveHint === false && annotations.readOnlyHint === true) {
		return { kind: 'allow' };
	}

	return { kind: 'approval_required', level: 'standard' };
}
