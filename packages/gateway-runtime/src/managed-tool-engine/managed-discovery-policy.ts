import { type ToolPortalToolSelector } from '@agent-collaboration/tool-access/contracts';
import { type StandaloneToolPortalConfig } from '@agent-collaboration/tool-host-node';
import type { CapabilityDiscoveryMetadata } from '@agent-vm/agent-portal-sdk';
import { type GatewayRuntimeManagedToolPortalConfig } from '@agent-vm/config-contracts';
import { oauthApplicationIdSchema } from '@agent-vm/oauth-broker-contracts';
export function deepFreeze<TValue>(value: TValue): TValue {
	if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
	for (const childValue of Object.values(value)) deepFreeze(childValue);
	return Object.freeze(value);
}

function selectorIncludesTool(selector: ToolPortalToolSelector, toolName: string): boolean {
	return (
		!selector.deny.includes(toolName) &&
		(selector.allow === '*' || selector.allow.includes(toolName))
	);
}

export function capabilityDiscoveryMetadata(props: {
	readonly policy:
		| GatewayRuntimeManagedToolPortalConfig['profiles'][string]['namespaces'][string]
		| StandaloneToolPortalConfig['profiles'][string]['namespaces'][string];
	readonly toolName: string;
}): CapabilityDiscoveryMetadata | undefined {
	if (!selectorIncludesTool(props.policy.tools, props.toolName)) return undefined;
	if ('source' in props.policy.calls) {
		if (props.policy.backend.kind !== 'controller_execution') return undefined;
		const operation = props.policy.backend.operations[props.toolName];
		if (
			operation?.kind !== 'configured_cli' ||
			operation.targetKind !== 'ephemeral_managed_vm' ||
			operation.authorization?.kind !== 'oauth_account' ||
			operation.compiledGoogle === undefined
		)
			return undefined;
		const set = operation.compiledGoogle;
		return {
			callDisposition: { kind: 'invocation-dependent', describeBeforeCall: true },
			...(set.descriptors.length === 0
				? {}
				: {
						oauthRequirement: {
							kind: 'google-account',
							accountArgument: 'accountId',
							describeBeforeCall: true,
							operations: set.descriptors.map((descriptor) => ({
								applicationId: oauthApplicationIdSchema.parse(
									set.applicationIdsByFamily[descriptor.familyId],
								),
								operationId: descriptor.operationId,
							})),
						},
					}),
		};
	}
	const withoutApproval = selectorIncludesTool(props.policy.calls.withoutApproval, props.toolName);
	const requiresApproval = selectorIncludesTool(
		props.policy.calls.requiresApproval,
		props.toolName,
	);
	if (!withoutApproval && !requiresApproval) return undefined;
	const discoveryRequiresApproval = !withoutApproval && requiresApproval;
	if (props.policy.backend.kind !== 'controller_execution') {
		return {
			callDisposition: {
				kind: discoveryRequiresApproval ? 'requires-approval' : 'without-approval',
			},
		};
	}
	const operation = props.policy.backend.operations[props.toolName];
	if (operation === undefined) {
		return {
			callDisposition: {
				kind: discoveryRequiresApproval ? 'requires-approval' : 'without-approval',
			},
		};
	}
	if (operation.kind !== 'configured_cli') {
		return {
			callDisposition: {
				kind: discoveryRequiresApproval ? 'requires-approval' : 'without-approval',
			},
		};
	}
	const hasInvocationApprovalRules =
		!('source' in operation.calls) && operation.calls.requiresApproval.length > 0;
	return {
		callDisposition:
			discoveryRequiresApproval || !hasInvocationApprovalRules
				? { kind: discoveryRequiresApproval ? 'requires-approval' : 'without-approval' }
				: { describeBeforeCall: true, kind: 'invocation-dependent' },
	};
}
