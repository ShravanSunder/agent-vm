import type { StandalonePortalCallItem } from '#standalone-tool-portal/standalone-portal-ports';

export interface StandalonePortalOperationIdentity {
	readonly id: string;
	readonly operationId: string;
	readonly owningGeneration: string;
}

export function standalonePortalCapabilityDenied(
	identity: StandalonePortalOperationIdentity,
): StandalonePortalCallItem {
	return {
		...identity,
		error: {
			code: 'capability_denied',
			message: 'Capability is not allowed by the active Tool Portal policy.',
			safeDiagnostic: {
				code: 'capability_denied',
				level: 'error',
				safeMessage: 'Capability is not allowed.',
			},
		},
		outcome: { certainty: 'proven', kind: 'not-dispatched', retryClass: 'safe-before-dispatch' },
		status: 'error',
	};
}

export function standalonePortalNotDispatched(
	identity: StandalonePortalOperationIdentity,
	reason: string,
): StandalonePortalCallItem {
	return {
		...identity,
		error: {
			code: 'not_authorized',
			message: `Capability execution was not dispatched: ${reason}.`,
			safeDiagnostic: {
				code: 'capability_denied',
				level: 'error',
				safeMessage: 'Capability execution was not authorized for dispatch.',
			},
		},
		outcome: { certainty: 'proven', kind: 'not-dispatched', retryClass: 'safe-before-dispatch' },
		status: 'error',
	};
}

export function standalonePortalAmbiguous(
	identity: StandalonePortalOperationIdentity,
): StandalonePortalCallItem {
	return {
		...identity,
		error: {
			code: 'execution_failed',
			message: 'Capability dispatch outcome is ambiguous and must not be replayed.',
			safeDiagnostic: {
				code: 'execution_failed',
				level: 'error',
				safeMessage: 'Capability dispatch outcome is ambiguous.',
			},
		},
		outcome: {
			certainty: 'side-effects-and-termination-unknown',
			kind: 'ambiguous',
			retryClass: 'forbidden',
		},
		status: 'error',
	};
}
