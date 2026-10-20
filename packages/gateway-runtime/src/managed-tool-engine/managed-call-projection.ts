import { PortalCallRequestSchema, PortalCallResultSchema } from '@agent-vm/agent-portal-sdk';
import type {
	GatewayRuntimeApprovalAdmissionResult,
	GatewayRuntimePortalSemanticSnapshot,
} from '@agent-vm/gateway-control-contracts';
import { deriveGatewayControlStablePrincipal } from '@agent-vm/gateway-control-contracts';
import {
	approvalRequiredItem,
	ambiguousDispatchItem,
	notDispatchedItem,
} from '@agent-vm/gateway-runtime/managed-tool-engine/managed-call-results.js';
import type { ManagedToolEngineAdapter } from '@agent-vm/gateway-runtime/managed-tool-engine/managed-dispatch-adapter.js';
import { deterministicOperationId } from '@agent-vm/tool-portal/dispatch-authority';
export function createManagedPortalCallProjection(props: {
	readonly request: ManagedToolEngineAdapter['request'];
	readonly register: ManagedToolEngineAdapter['register'];
	readonly release: ManagedToolEngineAdapter['release'];
	readonly dispatcher: ManagedToolEngineAdapter['dispatcher'];
	readonly snapshot: GatewayRuntimePortalSemanticSnapshot;
	readonly admission: (reference: string) => GatewayRuntimeApprovalAdmissionResult | null;
}): ManagedToolEngineAdapter['call'] {
	const { request, register, dispatcher, snapshot } = props;
	return async (publicRequest, context) => {
		const parsed = PortalCallRequestSchema.parse(publicRequest);
		const items = await Promise.all(
			parsed.calls.map(async (call) => {
				const reference = register({ context, call });
				try {
					const neutralRequest = request(reference);
					const expected = deterministicOperationId({
						callId: call.id,
						semanticRevision: snapshot.activeRevision,
						stablePrincipal: deriveGatewayControlStablePrincipal({
							principal: context.trustedContext.principal,
						}),
						surfaceClass: context.surfaceClass,
					});
					const result = await dispatcher.dispatch(neutralRequest);
					if (result.kind === 'completed')
						return PortalCallResultSchema.parse({ ok: true, items: [result.result] }).items[0];
					if (result.kind === 'pending') {
						const admission = props.admission(reference);
						if (admission?.kind !== 'approval-required')
							throw new Error('Missing managed challenge.');
						return approvalRequiredItem({
							id: call.id,
							operationId: expected,
							owningGeneration: snapshot.activeRevision,
							challengeId: result.reference,
							expiresAt: admission.challenge.expiresAt,
						});
					}
					const common = {
						id: call.id,
						operationId: expected,
						owningGeneration: snapshot.activeRevision,
					};
					return result.kind === 'ambiguous' ||
						result.kind === 'failed' ||
						result.kind === 'result-expired'
						? ambiguousDispatchItem(common)
						: notDispatchedItem({ ...common, reason: 'Managed dispatch refused' });
				} finally {
					props.release(reference);
				}
			}),
		);
		return PortalCallResultSchema.parse({
			items,
			ok: items.every((item) => item?.status === 'ok'),
		});
	};
}
