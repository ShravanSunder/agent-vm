import type { ArtifactReference, JsonObject, PortalCallResult } from '@agent-vm/agent-portal-sdk';

export type GatewayRuntimeToolVmRunnerCallItem = PortalCallResult['items'][number];

export function toolVmRunnerNotDispatchedItem(props: {
	readonly code: 'capability_denied' | 'execution_failed' | 'validation_failed';
	readonly id: string;
	readonly operationId: string;
	readonly owningGeneration: string;
	readonly safeMessage: string;
}): GatewayRuntimeToolVmRunnerCallItem {
	return {
		error: {
			code: props.code,
			message: props.safeMessage,
			safeDiagnostic: {
				code: props.code,
				level: 'error',
				safeMessage: props.safeMessage,
			},
		},
		id: props.id,
		operationId: props.operationId,
		outcome: {
			certainty: 'proven',
			kind: 'not-dispatched',
			retryClass: 'safe-before-dispatch',
		},
		owningGeneration: props.owningGeneration,
		status: 'error',
	};
}

export function toolVmRunnerExecutionErrorItem(props: {
	readonly disposition: 'ambiguous' | 'completed-failed';
	readonly id: string;
	readonly operationId: string;
	readonly owningGeneration: string;
	readonly safeMessage: string;
}): GatewayRuntimeToolVmRunnerCallItem {
	return {
		error: {
			code: 'execution_failed',
			message: props.safeMessage,
			safeDiagnostic: {
				code: 'execution_failed',
				level: 'error',
				safeMessage: props.safeMessage,
			},
		},
		id: props.id,
		operationId: props.operationId,
		outcome:
			props.disposition === 'ambiguous'
				? {
						certainty: 'side-effects-and-termination-unknown',
						kind: 'ambiguous',
						retryClass: 'forbidden',
					}
				: {
						certainty: 'proven',
						completion: 'failed',
						kind: 'completed',
						retryClass: 'forbidden',
					},
		owningGeneration: props.owningGeneration,
		status: 'error',
	};
}

export function toolVmRunnerSuccessfulCallItem(props: {
	readonly artifacts?: readonly ArtifactReference[];
	readonly id: string;
	readonly operationId: string;
	readonly owningGeneration: string;
	readonly value: JsonObject;
}): GatewayRuntimeToolVmRunnerCallItem {
	return {
		...(props.artifacts === undefined ? {} : { artifacts: [...props.artifacts] }),
		id: props.id,
		operationId: props.operationId,
		outcome: {
			certainty: 'proven',
			completion: 'succeeded',
			kind: 'completed',
			retryClass: 'forbidden',
		},
		owningGeneration: props.owningGeneration,
		status: 'ok',
		value: props.value,
	};
}
