// Copied from config-contracts/tool-portal-config.ts at 7cb295d1.
import type {
	ToolPortalToolSelector,
	ToolPortalNamespaceCallPolicy,
} from '#tool-access/contracts/tool-selectors';
export function toolPortalSelectorAllowsOperation(
	selector: ToolPortalToolSelector,
	operationName: string,
): boolean {
	return (
		!selector.deny.includes(operationName) &&
		(selector.allow === '*' || selector.allow.includes(operationName))
	);
}

export interface ToolPortalOperationReachabilityPolicy {
	readonly calls: ToolPortalNamespaceCallPolicy;
	readonly tools: ToolPortalToolSelector;
}

export function toolPortalNamespaceAllowsOperation(
	namespacePolicy: ToolPortalOperationReachabilityPolicy,
	operationName: string,
): boolean {
	return (
		toolPortalSelectorAllowsOperation(namespacePolicy.tools, operationName) &&
		('source' in namespacePolicy.calls ||
			toolPortalSelectorAllowsOperation(namespacePolicy.calls.requiresApproval, operationName) ||
			toolPortalSelectorAllowsOperation(namespacePolicy.calls.withoutApproval, operationName))
	);
}
