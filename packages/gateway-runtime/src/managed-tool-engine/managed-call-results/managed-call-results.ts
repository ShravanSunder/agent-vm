// Copied from tool-portal-service-common.ts at 3031ad24; preserves the managed wire outcome.
import type { PortalCallResult } from '@agent-vm/agent-portal-sdk';
type PortalCallItem = PortalCallResult['items'][number];
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

export function failedDispatchItem(props: {
	readonly id: string;
	readonly operationId: string;
	readonly owningGeneration: string;
	readonly reason: string;
}): PortalCallItem {
	return {
		error: { code: 'execution_failed', message: props.reason },
		id: props.id,
		operationId: props.operationId,
		outcome: {
			certainty: 'proven',
			kind: 'completed',
			completion: 'failed',
			retryClass: 'forbidden',
		},
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
