import { createAccessAssessor } from '@agent-collaboration/tool-access/authorization';
import {
	PortalCallItemResultSchema,
	PortalCallRequestSchema,
	PortalCallResultSchema,
	PortalDescribeRequestSchema,
	PortalListRequestSchema,
	PortalSearchRequestSchema,
} from '@agent-collaboration/tool-access/contracts';

import { createCapabilityDispatcher } from '#capability-dispatch/capability-dispatcher';
import { canonicalDispatchJson } from '#capability-dispatch/dispatch-intent';
import {
	mergeToolPortalDescribe,
	mergeToolPortalList,
	mergeToolPortalSearch,
} from '#capability-dispatch/portal-discovery-merger';
import {
	standalonePortalAmbiguous,
	standalonePortalCapabilityDenied,
	standalonePortalNotDispatched,
} from '#capability-dispatch/standalone-portal-call-results';
import type {
	CreateStandaloneToolPortalCoreProps,
	StandalonePortalCallItem,
	StandalonePortalCallPlan,
	StandaloneToolPortalCore,
} from '#capability-dispatch/standalone-portal-ports';

/** Aggregates Portal wire results; host ports supply facts and resource authority to S2. */
export function createStandaloneToolPortalCore<TOptions, TReadOptions>(
	props: CreateStandaloneToolPortalCoreProps<TOptions, TReadOptions>,
): StandaloneToolPortalCore<TOptions> {
	const assessAccess = createAccessAssessor(props.binding);
	return {
		call: async (request, options) => {
			const parsed = PortalCallRequestSchema.parse(request);
			const invocation = await props.resolveInvocation(options);
			const itemsById = new Map<string, StandalonePortalCallItem>();
			const plans: StandalonePortalCallPlan[] = [];
			await Promise.all(
				parsed.calls.map(async (call) => {
					const operationId = invocation.operationId(call.id);
					const identity = {
						id: call.id,
						operationId,
						owningGeneration: invocation.owningGeneration,
					};
					const access = await invocation.accessForCall(call);
					if (
						access.capability.namespace !== call.namespace ||
						access.capability.tool !== call.name ||
						access.call === null ||
						canonicalDispatchJson(access.call.arguments) !== canonicalDispatchJson(call.arguments)
					) {
						itemsById.set(call.id, standalonePortalCapabilityDenied(identity));
						return;
					}
					const assessed = assessAccess(access);
					if (
						assessed.kind !== 'assessed' ||
						assessed.assessment.kind !== 'fixed' ||
						(assessed.assessment.state.kind !== 'usable' &&
							assessed.assessment.state.kind !== 'approval-each-call')
					) {
						itemsById.set(call.id, standalonePortalCapabilityDenied(identity));
						return;
					}
					plans.push({
						call,
						operationId,
						requiresApproval: assessed.assessment.state.kind === 'approval-each-call',
						request: {
							authority: invocation.authority,
							principal: invocation.principal,
							item: operationId,
							verifiedContextRef: invocation.verifiedContextRef,
							correlation: invocation.correlation,
							access,
						},
					});
				}),
			);
			// Preserve original batch order even when fact collection settles out of order.
			const orderedPlans = parsed.calls.flatMap((call) =>
				plans.filter((plan) => plan.call.id === call.id),
			);
			async function dispatchGroup(group: readonly StandalonePortalCallPlan[]): Promise<void> {
				if (group.length === 0) return;
				const prepared = await invocation.prepareBatch(group);
				const dispatcher = createCapabilityDispatcher({
					assessAccess,
					operations: prepared.operations,
					approvals: prepared.approvals,
					backends: prepared.backends,
					now: props.now,
				});
				try {
					await Promise.all(
						group.map(async (plan) => {
							const identity = {
								id: plan.call.id,
								operationId: plan.operationId,
								owningGeneration: invocation.owningGeneration,
							};
							const admission = prepared.admissionItem(plan.operationId);
							if (admission !== undefined) {
								itemsById.set(plan.call.id, PortalCallItemResultSchema.parse(admission));
								return;
							}
							try {
								const result = await dispatcher.dispatch(plan.request);
								const canonical =
									result.kind === 'completed'
										? PortalCallItemResultSchema.parse(result.result)
										: prepared.backendItem(plan.operationId);
								if (
									canonical !== undefined &&
									canonical.id === plan.call.id &&
									canonical.operationId === plan.operationId &&
									((result.kind === 'completed' && canonical.outcome.kind === 'completed') ||
										(result.kind === 'ambiguous' && canonical.outcome.kind === 'ambiguous') ||
										(result.kind === 'not-dispatched' &&
											canonical.outcome.kind === 'not-dispatched') ||
										(result.kind === 'failed' &&
											canonical.outcome.certainty === 'proven-terminated'))
								) {
									itemsById.set(plan.call.id, canonical);
								} else {
									itemsById.set(
										plan.call.id,
										result.kind === 'denied'
											? standalonePortalCapabilityDenied(identity)
											: result.kind === 'not-dispatched'
												? standalonePortalNotDispatched(identity, result.reason)
												: standalonePortalAmbiguous(identity),
									);
								}
							} catch {
								itemsById.set(plan.call.id, standalonePortalAmbiguous(identity));
							}
						}),
					);
				} finally {
					prepared.release();
				}
			}
			await dispatchGroup(orderedPlans.filter((plan) => !plan.requiresApproval));
			await dispatchGroup(orderedPlans.filter((plan) => plan.requiresApproval));
			return PortalCallResultSchema.parse({
				items: parsed.calls.map((call) => itemsById.get(call.id)),
				ok: parsed.calls.every((call) => itemsById.get(call.id)?.status === 'ok'),
			});
		},
		list: async (request, options) => {
			const parsed = PortalListRequestSchema.parse(request);
			const invocation = await props.resolveInvocation(options);
			return await mergeToolPortalList({
				entries: invocation.entries,
				operationOptions: invocation.readOptions,
				request: parsed,
			});
		},
		search: async (request, options) => {
			const parsed = PortalSearchRequestSchema.parse(request);
			const invocation = await props.resolveInvocation(options);
			return await mergeToolPortalSearch({
				entries: invocation.entries,
				operationOptions: invocation.readOptions,
				request: parsed,
			});
		},
		describe: async (request, options) => {
			const parsed = PortalDescribeRequestSchema.parse(request);
			const invocation = await props.resolveInvocation(options);
			return await mergeToolPortalDescribe({
				entries: invocation.entries,
				operationOptions: invocation.readOptions,
				request: parsed,
			});
		},
	};
}
