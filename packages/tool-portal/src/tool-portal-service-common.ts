import type {
	CapabilityDiscoveryMetadata,
	PortalCallRequest,
	PortalCallResult,
} from '@agent-vm/agent-portal-sdk';
import type {
	EffectiveManagedToolPortalConfig,
	GatewayRuntimeManagedToolPortalConfig,
	ToolPortalBackendKind,
	ToolPortalConfig,
	ToolPortalToolSelector,
} from '@agent-vm/config-contracts';
import {
	openConfiguredCliInputSchema,
	openOAuthConfiguredCliInputSchema,
	quickConfiguredCliInputSchema,
	quickOAuthConfiguredCliInputSchema,
	controllerConfiguredCliInputSchema,
	resolveCompiledGoogleCommand,
} from '@agent-vm/config-contracts';
export { deterministicOperationId, directDispatchFingerprint } from './dispatch-authority.js';

import { oauthApplicationIdSchema } from '@agent-vm/oauth-broker-contracts';

import {
	evaluateCliAllowanceInvocation,
	validateCliAllowanceInvocation,
} from './cli-allowances/cli-allowance-validator.js';

export type PortalCallItem = PortalCallResult['items'][number];

export interface ToolPortalRuntimeNamespacePolicy {
	readonly backend: { readonly kind: ToolPortalBackendKind };
	readonly calls: ToolPortalConfig['profiles'][string]['namespaces'][string]['calls'];
	readonly tools: ToolPortalToolSelector;
}

export type ToolPortalCallPolicyDecision =
	| {
			readonly backendKind: ToolPortalBackendKind;
			readonly kind: 'requires-approval' | 'without-approval' | 'managed-google';
			readonly policy: ToolPortalRuntimeNamespacePolicy;
	  }
	| { readonly kind: 'denied' };

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
	readonly managedGoogleDisplay?:
		| import('@agent-vm/oauth-broker-contracts').ManagedGoogleDisplay
		| undefined;
	readonly challengeId: string;
	readonly expiresAt: string;
	readonly id: string;
	readonly operationId: string;
	readonly owningGeneration: string;
}): PortalCallItem {
	return {
		approvalChallenge: {
			challengeId: props.challengeId,
			expiresAt: props.expiresAt,
			...(props.managedGoogleDisplay === undefined
				? {}
				: { kind: 'managed_google' as const, managedGoogleDisplay: props.managedGoogleDisplay }),
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
	if ('source' in props.policy.calls) {
		if (props.policy.backend.kind !== 'controller_execution') return undefined;
		const operation = props.policy.backend.operations[props.toolName];
		if (
			operation?.kind !== 'configured_cli' ||
			operation.authorization?.kind !== 'oauth_account' ||
			!('compiledGoogle' in operation) ||
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
	if ('source' in policy.calls) {
		if (policy.backend.kind !== 'controller_execution') return { kind: 'denied' };
		const operation = policy.backend.operations[props.call.name];
		if (
			operation?.kind !== 'configured_cli' ||
			operation.authorization?.kind !== 'oauth_account' ||
			!('compiledGoogle' in operation) ||
			operation.compiledGoogle === undefined
		)
			return { kind: 'denied' };
		const input = controllerConfiguredCliInputSchema.safeParse(props.call.arguments);
		if (!input.success) return { kind: 'denied' };
		const shape = validateCliAllowanceInvocation({ allowance: operation, input: input.data });
		if (
			!shape.ok ||
			shape.matchedDenyRule ||
			resolveCompiledGoogleCommand(operation.compiledGoogle, input.data.argv).kind === 'denied'
		)
			return { kind: 'denied' };
		return { kind: 'managed-google', backendKind: 'controller_execution', policy };
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
				operation.authorization?.kind === 'oauth_account'
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
	return {
		backendKind: policy.backend.kind,
		kind: baseline === 'requires_approval' ? 'requires-approval' : 'without-approval',
		policy,
	};
}
