import { jsonValueSchema } from '@agent-collaboration/tool-access/contracts';
import {
	type ApprovalReceipt,
	type BackendKind,
	type DispatchInvocation,
	type OperationRecord,
	type ToolBackend,
} from '@agent-collaboration/tool-engine/capability-dispatch';
import {
	standalonePortalAmbiguous,
	standalonePortalNotDispatched,
	type StandalonePortalCallItem,
	type StandalonePortalCallPlan,
	type StandalonePortalPreparedBatch,
} from '@agent-collaboration/tool-engine/standalone-tool-portal';

import type { StandaloneToolPortalInvocationOptions } from '#node-host/standalone-tool-portal/models/standalone-portal-contracts';
import type { NodeStandaloneInvocation } from '#node-host/standalone-tool-portal/models/standalone-portal-contracts';
import {
	deriveStandaloneToolPortalApprovalBatchFingerprint,
	type StandaloneToolPortalApprovalBatchIntent,
	type StandaloneToolPortalApprovalCoordinator,
} from '#node-host/standalone-tool-portal/standalone-batch-approval';

interface PreparedBatchProps {
	readonly plans: readonly StandalonePortalCallPlan[];
	readonly options: StandaloneToolPortalInvocationOptions;
	readonly selected: NodeStandaloneInvocation;
	readonly coordinator: StandaloneToolPortalApprovalCoordinator;
	readonly now: () => number;
	readonly receiptReference: () => string;
	readonly validateCurrent: (
		plan: StandalonePortalCallPlan,
		invocation: DispatchInvocation,
	) => Promise<boolean>;
}

/** Request-local receipts bridge one consumed host batch to S2; no call history survives release. */
export async function prepareStandaloneBatchDispatch(
	props: PreparedBatchProps,
): Promise<StandalonePortalPreparedBatch> {
	const held = new Map<string, StandalonePortalCallItem>();
	const canonical = new Map<string, StandalonePortalCallItem>();
	const records = new Map<string, OperationRecord>();
	const receipts = new Map<string, ApprovalReceipt>();
	const dispatched = new Set<string>();
	const protectedPlans = props.plans.filter((plan) => plan.requiresApproval);
	let approvedUntil: string | undefined;
	function identity(plan: StandalonePortalCallPlan): {
		id: string;
		operationId: string;
		owningGeneration: string;
	} {
		return {
			id: plan.call.id,
			operationId: plan.operationId,
			owningGeneration: props.selected.owningGeneration,
		};
	}
	if (protectedPlans.length > 0) {
		const intent: StandaloneToolPortalApprovalBatchIntent = {
			authenticatedEnvelope: props.options.authenticatedEnvelope,
			protectedCalls: protectedPlans.map(({ call, operationId }) => ({ call, operationId })),
			semanticRevisions: props.selected.semanticRevisions,
			surfaceClass: props.options.surfaceClass,
		};
		const admission = props.coordinator.reserveDispatch(intent, props.options.approvalToken);
		if (admission.kind === 'approval-required') {
			for (const plan of protectedPlans)
				held.set(plan.operationId, {
					...identity(plan),
					status: 'approval_required',
					approvalChallenge: {
						challengeId: admission.challenge.challengeId,
						expiresAt: admission.challenge.expiresAt,
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
					outcome: {
						kind: 'not-dispatched',
						certainty: 'proven',
						retryClass: 'safe-before-dispatch',
					},
				});
		} else if (admission.kind === 'dispatch-reserved') {
			const expectedIds = protectedPlans.map((plan) => plan.operationId);
			if (
				admission.reservation.batchFingerprint !==
					deriveStandaloneToolPortalApprovalBatchFingerprint(intent) ||
				JSON.stringify(admission.reservation.operationIds) !== JSON.stringify(expectedIds)
			) {
				props.coordinator.proveNotDispatched(admission.reservation);
				for (const plan of protectedPlans)
					held.set(
						plan.operationId,
						standalonePortalNotDispatched(
							identity(plan),
							'approval reservation did not match the protected batch',
						),
					);
			} else {
				const arm = props.coordinator.armDispatch(admission.reservation);
				if (arm.kind === 'dispatch-authorized') approvedUntil = admission.reservation.expiresAt;
				else
					for (const plan of protectedPlans)
						held.set(
							plan.operationId,
							arm.kind === 'ambiguous'
								? standalonePortalAmbiguous(identity(plan))
								: standalonePortalNotDispatched(identity(plan), arm.reason),
						);
			}
		} else
			for (const plan of protectedPlans)
				held.set(
					plan.operationId,
					admission.kind === 'ambiguous'
						? standalonePortalAmbiguous(identity(plan))
						: standalonePortalNotDispatched(identity(plan), admission.reason),
				);
	}
	function planFor(invocation: DispatchInvocation): StandalonePortalCallPlan {
		const plan = props.plans.find(
			(candidate) => candidate.operationId === invocation.operationKey.item,
		);
		if (plan === undefined) throw new Error('Unknown standalone batch operation.');
		return plan;
	}
	const backend: ToolBackend<BackendKind> = {
		backendKind: 'mcp_provider',
		list: async () => null,
		search: async () => null,
		describe: async () => null,
		invoke: async (invocation) => {
			const plan = planFor(invocation);
			if (!(await props.validateCurrent(plan, invocation)) || dispatched.has(plan.operationId))
				return { kind: 'not-dispatched', reason: 'caller-unavailable' };
			if (
				plan.requiresApproval &&
				(approvedUntil === undefined ||
					Date.parse(approvedUntil) <= props.now() ||
					records.get(plan.operationId)?.state.kind !== 'armed' ||
					invocation.approvalReceiptRef !== receipts.get(plan.operationId)?.reference)
			)
				return { kind: 'not-dispatched', reason: 'standalone-approval-required' };
			dispatched.add(plan.operationId);
			try {
				const item = await props.selected.invoke({
					call: plan.call,
					invocation,
					options: props.options,
				});
				if (item.id !== plan.call.id || item.operationId !== plan.operationId)
					return { kind: 'ambiguous', reason: 'standalone-result-mismatch' };
				canonical.set(plan.operationId, item);
				if (item.outcome.kind === 'ambiguous')
					return { kind: 'ambiguous', reason: 'standalone-resource-ambiguous' };
				if (item.outcome.kind === 'not-dispatched')
					return { kind: 'not-dispatched', reason: 'standalone-resource-refused' };
				if (item.outcome.kind !== 'completed')
					return { kind: 'failed', reason: 'standalone-resource-terminated' };
				return { kind: 'completed', result: jsonValueSchema.parse(item) };
			} catch {
				return { kind: 'ambiguous', reason: 'standalone-resource-unconfirmed' };
			}
		},
	};
	return {
		admissionItem: (operationId) => held.get(operationId),
		backendItem: (operationId) => canonical.get(operationId),
		backends: new Map([['mcp_provider', backend]]),
		operations: {
			lookup: async () => ({ kind: 'unsupported-version' }),
			createOrRead: async ({ invocation, requiresApproval }) => {
				const plan = planFor(invocation);
				if (
					requiresApproval !== plan.requiresApproval ||
					!(await props.validateCurrent(plan, invocation))
				)
					return { kind: 'denied' };
				if (!requiresApproval) return { kind: 'untracked' };
				if (approvedUntil === undefined || Date.parse(approvedUntil) <= props.now())
					return { kind: 'denied' };
				const timestamp = new Date(props.now()).toISOString();
				const record: OperationRecord = {
					version: 'tool-operation-v1',
					key: invocation.operationKey,
					intentDigest: invocation.intentDigest,
					createdAt: timestamp,
					updatedAt: timestamp,
					revision: 'ready',
					state: { kind: 'ready' },
				};
				records.set(plan.operationId, record);
				receipts.set(plan.operationId, {
					reference: props.receiptReference(),
					decision: 'approve',
					authoritativeRevision: {
						owner: invocation.authority,
						revision: props.selected.semanticRevisions.activeRevision,
					},
					operationKey: invocation.operationKey,
					intentDigest: invocation.intentDigest,
					backendKind: invocation.backendKind,
					bindingRevision: invocation.bindingRevision,
					admissionRevisions: invocation.admissionRevisions,
					verifiedContextRef: invocation.verifiedContextRef,
					expiresAt: approvedUntil,
				});
				return { kind: 'created', record };
			},
			transition: async ({ invocation, expectedRevision, next }) => {
				const plan = planFor(invocation);
				const record = records.get(plan.operationId);
				if (
					record?.revision !== expectedRevision ||
					invocation.approvalReceiptRef !== receipts.get(plan.operationId)?.reference ||
					!(await props.validateCurrent(plan, invocation))
				)
					return { kind: 'denied' };
				const updated = { ...record, state: next, revision: `${expectedRevision}:${next.kind}` };
				records.set(plan.operationId, updated);
				return { kind: 'found', record: updated };
			},
		},
		approvals: {
			decision: async () => ({ kind: 'unavailable' }),
			challenge: async (invocation) => {
				const receipt = receipts.get(planFor(invocation).operationId);
				return receipt === undefined ? { kind: 'denied' } : { kind: 'approved', receipt };
			},
			receipt: async ({ invocation, reference }) => {
				const plan = planFor(invocation);
				const receipt = receipts.get(plan.operationId);
				return receipt?.reference === reference && (await props.validateCurrent(plan, invocation))
					? { kind: 'approved', receipt }
					: { kind: 'denied' };
			},
		},
		release: () => {
			records.clear();
			receipts.clear();
			canonical.clear();
			held.clear();
			dispatched.clear();
		},
	};
}
