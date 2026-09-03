import type {
	CapabilityDiscoveryMetadata,
	PortalCallRequest,
	PortalCallResult,
	ToolVmAdvisoryHintContext,
} from '@agent-vm/agent-portal-sdk';
import type {
	EffectiveManagedToolPortalConfig,
	GatewayRuntimeManagedToolPortalConfig,
	ToolPortalBackendKind,
	ToolPortalConfig,
	ToolPortalCallPolicy,
	ToolPortalToolSelector,
} from '@agent-vm/config-contracts';
import {
	openConfiguredCliInputSchema,
	openOAuthConfiguredCliInputSchema,
	openToolVmCliInputSchema,
	quickConfiguredCliInputSchema,
	quickToolVmCliInputSchema,
	quickOAuthConfiguredCliInputSchema,
} from '@agent-vm/config-contracts';
export { deterministicOperationId, directDispatchFingerprint } from './dispatch-authority.js';

import {
	evaluateCliAllowanceInvocation,
	evaluateToolVmCliAdvisoryHints,
} from './cli-allowances/cli-allowance-validator.js';

export type PortalCallItem = PortalCallResult['items'][number];

export interface ToolPortalRuntimeNamespacePolicy {
	readonly backend: { readonly kind: ToolPortalBackendKind };
	readonly calls: ToolPortalCallPolicy;
	readonly tools: ToolPortalToolSelector;
}

export type ToolPortalCallPolicyDecision =
	| {
			readonly approvalContext?: ToolVmAdvisoryHintContext;
			readonly backendKind: ToolPortalBackendKind;
			readonly kind: 'requires-approval' | 'without-approval';
			readonly policy: ToolPortalRuntimeNamespacePolicy;
	  }
	| { readonly kind: 'denied' }
	| { readonly kind: 'tool-vm-advisory-denied' };

export function deepFreeze<TValue>(value: TValue): TValue {
	if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
	for (const childValue of Object.values(value)) deepFreeze(childValue);
	return Object.freeze(value);
}

export function canonicalJson(value: unknown): string {
	if (value === null || typeof value === 'boolean' || typeof value === 'string') {
		return JSON.stringify(value);
	}
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) {
			throw new TypeError('Tool Portal canonical values must be finite.');
		}
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
	if (typeof value === 'object') {
		const fields = Object.entries(value)
			.filter(([, fieldValue]) => fieldValue !== undefined)
			.toSorted(([leftName], [rightName]) => leftName.localeCompare(rightName));
		return `{${fields
			.map(([fieldName, fieldValue]) => `${JSON.stringify(fieldName)}:${canonicalJson(fieldValue)}`)
			.join(',')}}`;
	}
	throw new TypeError('Tool Portal canonical values must be JSON-compatible.');
}

export function approvalRequiredItem(props: {
	readonly challengeId: string;
	readonly context?: ToolVmAdvisoryHintContext;
	readonly expiresAt: string;
	readonly id: string;
	readonly operationId: string;
	readonly owningGeneration: string;
}): PortalCallItem {
	return {
		approvalChallenge: {
			challengeId: props.challengeId,
			...(props.context === undefined ? {} : { context: props.context }),
			expiresAt: props.expiresAt,
		},
		error: {
			code: 'approval_required',
			message: 'Capability execution requires operator approval.',
			safeDiagnostic: {
				code: 'approval_required',
				level: 'warn',
				safeMessage: 'Capability execution requires operator approval.',
			},
		},
		id: props.id,
		operationId: props.operationId,
		outcome: { certainty: 'proven', kind: 'not-dispatched', retryClass: 'safe-before-dispatch' },
		owningGeneration: props.owningGeneration,
		status: 'approval_required',
	};
}

export function toolVmAdvisoryHintDeniedItem(props: {
	readonly id: string;
	readonly operationId: string;
	readonly owningGeneration: string;
}): PortalCallItem {
	const safeMessage =
		'Deployment guidance declined this Tool Portal call; this is not Tool VM containment.';
	return {
		error: {
			code: 'tool_vm_advisory_hint_denied',
			message: safeMessage,
			safeDiagnostic: {
				code: 'tool_vm_advisory_hint_denied',
				level: 'warn',
				safeMessage,
			},
		},
		id: props.id,
		operationId: props.operationId,
		outcome: { certainty: 'proven', kind: 'not-dispatched', retryClass: 'safe-before-dispatch' },
		owningGeneration: props.owningGeneration,
		status: 'error',
	};
}

export function notDispatchedItem(props: {
	readonly id: string;
	readonly operationId: string;
	readonly owningGeneration: string;
	readonly reason: string;
}): PortalCallItem {
	return {
		error: {
			code: 'not_authorized',
			message: `Capability execution was not dispatched: ${props.reason}.`,
			safeDiagnostic: {
				code: 'capability_denied',
				level: 'error',
				safeMessage: 'Capability execution was not authorized for dispatch.',
			},
		},
		id: props.id,
		operationId: props.operationId,
		outcome: { certainty: 'proven', kind: 'not-dispatched', retryClass: 'safe-before-dispatch' },
		owningGeneration: props.owningGeneration,
		status: 'error',
	};
}

export function ambiguousDispatchItem(props: {
	readonly id: string;
	readonly operationId: string;
	readonly owningGeneration: string;
}): PortalCallItem {
	return {
		error: {
			code: 'execution_failed',
			message: 'Capability dispatch outcome is ambiguous and must not be replayed.',
			safeDiagnostic: {
				code: 'execution_failed',
				level: 'error',
				safeMessage: 'Capability dispatch outcome is ambiguous.',
			},
		},
		id: props.id,
		operationId: props.operationId,
		outcome: {
			certainty: 'side-effects-and-termination-unknown',
			kind: 'ambiguous',
			retryClass: 'forbidden',
		},
		owningGeneration: props.owningGeneration,
		status: 'error',
	};
}

export function capabilityDeniedItem(props: {
	readonly id: string;
	readonly operationId: string;
	readonly owningGeneration: string;
}): PortalCallItem {
	return {
		error: {
			code: 'capability_denied',
			message: 'Capability is not allowed by the active Tool Portal policy.',
			safeDiagnostic: {
				code: 'capability_denied',
				level: 'error',
				safeMessage: 'Capability is not allowed.',
			},
		},
		id: props.id,
		operationId: props.operationId,
		outcome: { certainty: 'proven', kind: 'not-dispatched', retryClass: 'safe-before-dispatch' },
		owningGeneration: props.owningGeneration,
		status: 'error',
	};
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
		| ToolPortalConfig['profiles'][string]['namespaces'][string];
	readonly toolName: string;
}): CapabilityDiscoveryMetadata | undefined {
	if (!selectorIncludesTool(props.policy.tools, props.toolName)) return undefined;
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
	const hasInvocationApprovalRules = operation.calls.requiresApproval.length > 0;
	const oauthRequirement = ((): CapabilityDiscoveryMetadata['oauthRequirement'] | undefined => {
		if (operation.authorization?.kind !== 'oauth_account_profile') return undefined;
		const firstRequirement = operation.authorization.rules[0]?.requirement;
		if (
			firstRequirement?.kind === 'oauth' &&
			operation.authorization.rules.every(
				(rule) =>
					rule.requirement.kind === 'oauth' &&
					rule.requirement.applicationId === firstRequirement.applicationId &&
					rule.requirement.serviceId === firstRequirement.serviceId &&
					rule.requirement.minimumPermission === firstRequirement.minimumPermission,
			)
		) {
			return {
				applicationId: firstRequirement.applicationId,
				kind: 'oauth-account-profile',
				minimumPermission: firstRequirement.minimumPermission,
				serviceId: firstRequirement.serviceId,
			};
		}
		return {
			accountProfileArgument: 'accountProfile',
			describeBeforeCall: true,
			kind: 'invocation-dependent-oauth-account-profile',
		};
	})();
	return {
		callDisposition:
			discoveryRequiresApproval || !hasInvocationApprovalRules
				? { kind: discoveryRequiresApproval ? 'requires-approval' : 'without-approval' }
				: { describeBeforeCall: true, kind: 'invocation-dependent' },
		...(oauthRequirement === undefined ? {} : { oauthRequirement }),
	};
}

export function callPolicyDecision(props: {
	readonly call: PortalCallRequest['calls'][number];
	readonly config:
		| EffectiveManagedToolPortalConfig
		| GatewayRuntimeManagedToolPortalConfig
		| ToolPortalConfig;
	readonly profileId: string;
	readonly semanticSnapshot: {
		readonly surfaceEligibilityByProfile: Readonly<
			Record<string, Readonly<Record<string, readonly string[]>>>
		>;
	};
	readonly surfaceClass: string;
}): ToolPortalCallPolicyDecision {
	const profileConfig = props.config.profiles[props.profileId];
	const policy = profileConfig?.namespaces[props.call.namespace];
	const eligibleSurfaceClasses =
		props.semanticSnapshot.surfaceEligibilityByProfile[props.profileId]?.[props.call.namespace] ??
		[];
	if (
		policy === undefined ||
		!eligibleSurfaceClasses.includes(props.surfaceClass) ||
		!selectorIncludesTool(policy.tools, props.call.name)
	) {
		return { kind: 'denied' };
	}
	const baseline = selectorIncludesTool(policy.calls.withoutApproval, props.call.name)
		? 'without_approval'
		: selectorIncludesTool(policy.calls.requiresApproval, props.call.name)
			? 'requires_approval'
			: 'deny';
	if (baseline === 'deny') return { kind: 'denied' };
	if (policy.backend.kind === 'controller_execution') {
		const operation = policy.backend.operations[props.call.name];
		if (operation?.kind === 'configured_cli') {
			const inputSchema =
				operation.authorization?.kind === 'oauth_account_profile'
					? operation.timeout.kind === 'quick'
						? quickOAuthConfiguredCliInputSchema
						: openOAuthConfiguredCliInputSchema
					: operation.timeout.kind === 'quick'
						? quickConfiguredCliInputSchema
						: openConfiguredCliInputSchema;
			const parsedInput = inputSchema.safeParse(props.call.arguments);
			if (!parsedInput.success) return { kind: 'denied' };
			const evaluation = evaluateCliAllowanceInvocation({
				allowance: operation,
				baseline,
				input: parsedInput.data,
			});
			if (evaluation.disposition === 'deny') return { kind: 'denied' };
			return {
				backendKind: policy.backend.kind,
				kind:
					evaluation.disposition === 'requires_approval' ? 'requires-approval' : 'without-approval',
				policy,
			};
		}
	}
	if (policy.backend.kind === 'tool_vm_runner') {
		const operation = policy.backend.operations[props.call.name];
		if (operation?.kind === 'command.cli') {
			const inputSchema =
				operation.timeout.kind === 'quick' ? quickToolVmCliInputSchema : openToolVmCliInputSchema;
			const parsedInput = inputSchema.safeParse(props.call.arguments);
			if (!parsedInput.success || baseline !== 'without_approval') return { kind: 'denied' };
			const disposition = evaluateToolVmCliAdvisoryHints({
				argv: parsedInput.data.argv,
				hints: operation.advisoryHints,
			});
			if (disposition === 'hint-deny') return { kind: 'tool-vm-advisory-denied' };
			return {
				...(disposition === 'hint-requires-approval'
					? {
							approvalContext: {
								bypassableWithinToolVm: true,
								kind: 'tool_vm_advisory_hint' as const,
								scope: 'tool_portal_call_only' as const,
							},
						}
					: {}),
				backendKind: policy.backend.kind,
				kind:
					disposition === 'hint-requires-approval'
						? ('requires-approval' as const)
						: ('without-approval' as const),
				policy,
			};
		}
	}
	return {
		backendKind: policy.backend.kind,
		kind: baseline === 'requires_approval' ? 'requires-approval' : 'without-approval',
		policy,
	};
}
