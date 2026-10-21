import { randomUUID } from 'node:crypto';

import type { ToolPortalDiscoveryEntry } from '@agent-collaboration/tool-engine/dispatch';
import {
	PortalCallResultSchema,
	type PortalCallRequest,
	type PortalCallResult,
} from '@agent-vm/agent-portal-sdk';
import type {
	GatewayRuntimePortalSurfaceClass,
	GatewayRuntimeTrustedInvocationContext,
} from '@agent-vm/gateway-control-contracts';
export {
	mergeToolPortalList,
	mergeToolPortalSearch,
	mergeToolPortalDescribe,
} from '@agent-collaboration/tool-engine/dispatch';

export interface ToolPortalInvocationOptions {
	readonly signal?: AbortSignal;
	readonly surfaceClass: GatewayRuntimePortalSurfaceClass;
	readonly trustedContext: GatewayRuntimeTrustedInvocationContext;
}
export type ToolPortalBackendEntry<
	TCallOptions = ToolPortalInvocationOptions,
	TReadOptions = TCallOptions,
> = ToolPortalDiscoveryEntry<TReadOptions> & {
	readonly backend: ToolPortalDiscoveryEntry<TReadOptions>['backend'] & {
		readonly call: (request: PortalCallRequest, options: TCallOptions) => Promise<PortalCallResult>;
	};
};

function capabilityDeniedItem(props: {
	readonly id: string;
	readonly namespace: string;
	readonly name: string;
	readonly operationId: string;
	readonly owningGeneration: string;
}): PortalCallResult['items'][number] {
	return {
		error: {
			code: 'capability_denied',
			message: `Capability ${props.namespace}.${props.name} is not allowed.`,
			safeDiagnostic: {
				code: 'capability_denied',
				level: 'error',
				safeMessage: 'Capability is not allowed.',
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

function executionFailedItem(props: {
	readonly id: string;
	readonly namespace: string;
	readonly name: string;
	readonly operationId: string;
	readonly owningGeneration: string;
}): PortalCallResult['items'][number] {
	return {
		error: {
			code: 'execution_failed',
			message: `Capability ${props.namespace}.${props.name} did not return a result.`,
			safeDiagnostic: {
				code: 'execution_failed',
				level: 'error',
				safeMessage: 'Capability execution failed.',
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

export async function routeToolPortalCall<TCallOptions, TReadOptions = TCallOptions>(props: {
	readonly entries: readonly ToolPortalBackendEntry<TCallOptions, TReadOptions>[];
	readonly operationOptions: TCallOptions;
	readonly owningGeneration: string;
	readonly request: PortalCallRequest;
}): Promise<PortalCallResult> {
	const itemsById = new Map<string, PortalCallResult['items'][number]>();
	const operationIdsByCallId = new Map(props.request.calls.map((call) => [call.id, randomUUID()]));
	await Promise.all(
		props.entries.map(async (entry) => {
			const calls = props.request.calls.filter((call) => entry.namespaces.has(call.namespace));
			if (calls.length === 0) {
				return;
			}
			const result = PortalCallResultSchema.parse(
				await entry.backend.call(
					{
						...(props.request.requestId === undefined
							? {}
							: { requestId: props.request.requestId }),
						calls,
					},
					props.operationOptions,
				),
			);
			for (const item of result.items) {
				itemsById.set(item.id, item);
			}
		}),
	);

	const items = props.request.calls.map((call) => {
		const routedItem = itemsById.get(call.id);
		if (routedItem !== undefined) {
			return routedItem;
		}
		const matchedBackend = props.entries.some((entry) => entry.namespaces.has(call.namespace));
		const common = {
			id: call.id,
			name: call.name,
			namespace: call.namespace,
			operationId: operationIdsByCallId.get(call.id) ?? randomUUID(),
			owningGeneration: props.owningGeneration,
		};
		return matchedBackend ? executionFailedItem(common) : capabilityDeniedItem(common);
	});
	return PortalCallResultSchema.parse({
		items,
		ok: items.every((item) => item.status === 'ok'),
	});
}
