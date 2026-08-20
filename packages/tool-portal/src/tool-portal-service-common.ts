import { createHash } from 'node:crypto';

import type { PortalCallRequest, PortalCallResult } from '@agent-vm/agent-portal-sdk';
import type {
	GatewayRuntimeManagedToolPortalConfig,
	ToolPortalBackendKind,
	ToolPortalConfig,
	ToolPortalCallPolicy,
	ToolPortalToolSelector,
} from '@agent-vm/config-contracts';

export type PortalCallItem = PortalCallResult['items'][number];

export interface ToolPortalRuntimeNamespacePolicy {
	readonly backend: { readonly kind: ToolPortalBackendKind };
	readonly calls: ToolPortalCallPolicy;
	readonly tools: ToolPortalToolSelector;
}

export type ToolPortalCallPolicyDecision =
	| {
			readonly backendKind: ToolPortalBackendKind;
			readonly kind: 'requires-approval' | 'without-approval';
			readonly policy: ToolPortalRuntimeNamespacePolicy;
	  }
	| { readonly kind: 'denied' };

export function deepFreeze<TValue>(value: TValue): TValue {
	if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
	for (const childValue of Object.values(value)) deepFreeze(childValue);
	return Object.freeze(value);
}

export function deterministicOperationId(props: {
	readonly callId: string;
	readonly semanticRevision: string;
	readonly stablePrincipal: string;
	readonly surfaceClass: string;
}): string {
	const digest = createHash('sha256')
		.update(
			[
				'tool-portal-operation-v1',
				props.semanticRevision,
				props.surfaceClass,
				props.stablePrincipal,
				props.callId,
			].join('\u0000'),
			'utf8',
		)
		.digest('hex')
		.slice(0, 32)
		.split('');
	digest[12] = '5';
	const variantNibble = Number.parseInt(digest[16] ?? '0', 16);
	digest[16] = ((variantNibble & 0x3) | 0x8).toString(16);
	const hexadecimal = digest.join('');
	return `${hexadecimal.slice(0, 8)}-${hexadecimal.slice(8, 12)}-${hexadecimal.slice(12, 16)}-${hexadecimal.slice(16, 20)}-${hexadecimal.slice(20)}`;
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

export function directDispatchFingerprint(props: {
	readonly backendKind: ToolPortalBackendKind;
	readonly call: PortalCallRequest['calls'][number];
	readonly principal: unknown;
	readonly semanticSnapshot: {
		readonly activeRevision: string;
		readonly bindingRevision: string;
		readonly catalogRevision: string;
		readonly profilePolicyRevision: string;
		readonly providerRevision: string;
		readonly schemaRevision: string;
	};
	readonly surfaceClass: string;
}): `sha256:${string}` {
	const fingerprintInput = {
		backendKind: props.backendKind,
		capability: { name: props.call.name, namespace: props.call.namespace },
		canonicalArguments: props.call.arguments,
		currentGeneration: props.semanticSnapshot.activeRevision,
		principal: props.principal,
		semanticRevisions: {
			activeRevision: props.semanticSnapshot.activeRevision,
			bindingRevision: props.semanticSnapshot.bindingRevision,
			catalogRevision: props.semanticSnapshot.catalogRevision,
			profilePolicyRevision: props.semanticSnapshot.profilePolicyRevision,
			providerRevision: props.semanticSnapshot.providerRevision,
			schemaRevision: props.semanticSnapshot.schemaRevision,
		},
		surfaceClass: props.surfaceClass,
		version: 'tool-portal-direct-dispatch-v1',
	};
	return `sha256:${createHash('sha256').update(canonicalJson(fingerprintInput), 'utf8').digest('hex')}`;
}

export function approvalRequiredItem(props: {
	readonly challengeId: string;
	readonly expiresAt: string;
	readonly id: string;
	readonly operationId: string;
	readonly owningGeneration: string;
}): PortalCallItem {
	return {
		approvalChallenge: { challengeId: props.challengeId, expiresAt: props.expiresAt },
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

export function callPolicyDecision(props: {
	readonly call: PortalCallRequest['calls'][number];
	readonly config: GatewayRuntimeManagedToolPortalConfig | ToolPortalConfig;
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
	if (selectorIncludesTool(policy.calls.withoutApproval, props.call.name)) {
		return { backendKind: policy.backend.kind, kind: 'without-approval', policy };
	}
	if (selectorIncludesTool(policy.calls.requiresApproval, props.call.name)) {
		return { backendKind: policy.backend.kind, kind: 'requires-approval', policy };
	}
	return { kind: 'denied' };
}
