import {
	PortalCallItemResultSchema,
	PortalCallRequestSchema,
	PortalCallResultSchema,
	type PortalCallResult,
} from '@agent-vm/agent-portal-sdk';
import type {
	GatewayRuntimeApprovalAdmissionResult,
	GatewayRuntimePortalSemanticSnapshot,
} from '@agent-vm/gateway-control-contracts';
import { deriveGatewayControlStablePrincipal } from '@agent-vm/gateway-control-contracts';
import {
	ambiguousDispatchItem,
	approvalRequiredItem,
	capabilityDeniedItem,
	failedDispatchItem,
	notDispatchedItem,
} from '@agent-vm/gateway-runtime/managed-tool-engine/managed-call-results/managed-call-results.js';
import { deterministicOperationId } from '@agent-vm/gateway-runtime/managed-tool-engine/managed-dispatch-identity.js';
import type { ManagedToolEngineAdapter } from '@agent-vm/gateway-runtime/managed-tool-engine/models/managed-tool-engine-adapter.js';
export function createManagedPortalCallProjection(props: {
	readonly request: ManagedToolEngineAdapter['request'];
	readonly register: ManagedToolEngineAdapter['register'];
	readonly release: ManagedToolEngineAdapter['release'];
	readonly dispatcher: ManagedToolEngineAdapter['dispatcher'];
	readonly snapshot: GatewayRuntimePortalSemanticSnapshot;
	readonly preDispatchFailure?: (reference: string) => PortalCallResult['items'][number] | null;
	readonly admission: (reference: string) => GatewayRuntimeApprovalAdmissionResult | null;
	readonly backendItem: (reference: string) => PortalCallResult['items'][number] | null;
}): ManagedToolEngineAdapter['call'] {
	const { request, register, dispatcher, snapshot } = props;
	return async (publicRequest, context, prepared) => {
		const parsed = PortalCallRequestSchema.parse(publicRequest);
		const stablePrincipal = deriveGatewayControlStablePrincipal({
			principal: context.trustedContext.principal,
		});
		const items = await Promise.all(
			parsed.calls.map(async (call) => {
				const common = {
					id: call.id,
					operationId: deterministicOperationId({
						callId: call.id,
						semanticRevision: snapshot.activeRevision,
						stablePrincipal,
						surfaceClass: context.surfaceClass,
					}),
					owningGeneration: snapshot.activeRevision,
				};
				let reference: string | undefined;
				let dispatchAttempted = false;
				try {
					reference = await register({ context, call, ...prepared });
					const neutralRequest = request(reference);
					// A thrown dispatch call may already have reached the leaf.
					dispatchAttempted = true;
					const result = await dispatcher.dispatch(neutralRequest);
					if (result.kind === 'completed') return PortalCallItemResultSchema.parse(result.result);
					const preDispatchFailure = props.preDispatchFailure?.(reference);
					if (preDispatchFailure !== undefined && preDispatchFailure !== null)
						return preDispatchFailure;
					const admission = props.admission(reference);
					if (admission?.kind === 'not-dispatched')
						return notDispatchedItem({ ...common, reason: admission.reason });
					if (admission?.kind === 'ambiguous') return ambiguousDispatchItem(common);
					if (result.kind === 'pending') {
						if (admission?.kind !== 'approval-required')
							throw new Error('Missing managed challenge.');
						return approvalRequiredItem({
							...common,
							challengeId: result.reference,
							managedGoogleDisplay: admission.challenge.intent.managedGoogle?.display,
							expiresAt: admission.challenge.expiresAt,
						});
					}
					const backendItem = props.backendItem(reference);
					if (
						backendItem !== null &&
						((result.kind === 'failed' && backendItem.outcome.certainty === 'proven-terminated') ||
							((result.kind === 'ambiguous' || result.kind === 'not-dispatched') &&
								backendItem.outcome.kind === result.kind))
					)
						return backendItem;
					if (result.kind === 'denied') return capabilityDeniedItem(common);
					if (result.kind === 'failed')
						return failedDispatchItem({ ...common, reason: result.reason });
					return result.kind === 'ambiguous' || result.kind === 'result-expired'
						? ambiguousDispatchItem(common)
						: notDispatchedItem({ ...common, reason: 'Managed dispatch refused' });
				} catch {
					return dispatchAttempted
						? ambiguousDispatchItem(common)
						: notDispatchedItem({ ...common, reason: 'Managed dispatch preparation failed' });
				} finally {
					if (reference !== undefined) props.release(reference);
				}
			}),
		);
		return PortalCallResultSchema.parse({
			items,
			ok: items.every((item) => item?.status === 'ok'),
		});
	};
}
