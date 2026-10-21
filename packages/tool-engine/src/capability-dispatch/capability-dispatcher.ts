import {
	jsonValueSchema,
	type AccessState,
	type AssessAccessInput,
	type AssessAccessResult,
} from '@agent-collaboration/tool-access/contracts';

import { canonicalDispatchJson, dispatchIntentDigest } from '#capability-dispatch/dispatch-intent';
import {
	approvalReceiptSchema,
	approvalChallengeSchema,
	dispatchInvocationSchema,
	operationRecordSchema,
	resourceResultSchema,
	type ApprovalPort,
	type ApprovalReceipt,
	type BackendKind,
	type DispatchInvocation,
	type DispatchRequest,
	type OperationPort,
	type ResourceResult,
	type ToolBackend,
} from '#capability-dispatch/models/dispatch-contracts';

function unavailable(): ResourceResult {
	return { kind: 'denied', state: { kind: 'not-usable', firstUnmet: 'service-unavailable' } };
}
function sameOperation(
	left: DispatchInvocation['operationKey'],
	right: DispatchInvocation['operationKey'],
): boolean {
	return (
		left.authority === right.authority &&
		left.principal === right.principal &&
		left.item === right.item
	);
}
function receiptMatches(
	receipt: ApprovalReceipt,
	invocation: DispatchInvocation,
	now: number,
): boolean {
	return (
		sameOperation(receipt.operationKey, invocation.operationKey) &&
		receipt.intentDigest === invocation.intentDigest &&
		receipt.backendKind === invocation.backendKind &&
		canonicalDispatchJson(receipt.bindingRevision) ===
			canonicalDispatchJson(invocation.bindingRevision) &&
		canonicalDispatchJson(jsonValueSchema.parse(receipt.admissionRevisions)) ===
			canonicalDispatchJson(jsonValueSchema.parse(invocation.admissionRevisions)) &&
		receipt.verifiedContextRef === invocation.verifiedContextRef &&
		Date.parse(receipt.expiresAt) > now
	);
}
export interface CapabilityDispatcher {
	readonly dispatch: (request: DispatchRequest) => Promise<ResourceResult>;
	readonly lookup: OperationPort['lookup'];
}

/** Plan one original item. Only the resource can authorize its eventual effect. */
export function createCapabilityDispatcher(props: {
	readonly assessAccess: (input: AssessAccessInput) => AssessAccessResult;
	readonly operations: OperationPort;
	readonly approvals: ApprovalPort;
	readonly backends: ReadonlyMap<BackendKind, ToolBackend<BackendKind>>;
	readonly now: () => number;
	readonly factsRejected?: (reason: string) => void;
}): CapabilityDispatcher {
	return {
		lookup: async (request) => await props.operations.lookup(request),
		dispatch: async (request): Promise<ResourceResult> => {
			let state: AccessState;
			let admissionRevisions: DispatchInvocation['admissionRevisions'];
			try {
				const result = props.assessAccess(request.access);
				if (result.kind === 'facts-rejected') {
					props.factsRejected?.(result.reason);
					return unavailable();
				}
				if (result.assessment.kind !== 'fixed' || request.access.call === null)
					return unavailable();
				state = result.assessment.state;
				admissionRevisions = result.assessment.revisions;
			} catch {
				props.factsRejected?.('invalid-access-facts');
				return unavailable();
			}
			if (state.kind !== 'usable' && state.kind !== 'approval-each-call')
				return { kind: 'denied', state };
			const namespace =
				request.access.facts.assignment.profile.namespaces[request.access.capability.namespace];
			const backend =
				namespace === undefined ? undefined : props.backends.get(namespace.backendKind);
			if (namespace === undefined || backend === undefined || request.access.call === null)
				return unavailable();
			let invocation: DispatchInvocation;
			try {
				const intent = {
					version: 'tool-dispatch-v1' as const,
					authority: request.authority,
					operationKey: {
						authority: request.authority,
						principal: request.principal,
						item: request.item,
					},
					capability: request.access.capability,
					arguments: request.access.call.arguments,
					backendKind: namespace.backendKind,
					bindingRevision: request.access.facts.upstream.binding,
					admissionRevisions,
					verifiedContextRef: request.verifiedContextRef,
					surface: request.access.surface,
					correlation: request.correlation,
				};
				// Validate the JSON object before giving it an intent identity.
				const parsed = dispatchInvocationSchema.parse({
					...intent,
					intentDigest: '0'.repeat(64),
					approvalReceiptRef: null,
				});
				invocation = { ...parsed, intentDigest: await dispatchIntentDigest(parsed) };
			} catch {
				return unavailable();
			}
			try {
				const operation = await props.operations.createOrRead({
					invocation,
					requiresApproval: state.kind === 'approval-each-call',
				});
				if (operation.kind === 'untracked' && state.kind === 'approval-each-call')
					return unavailable();
				if (
					operation.kind !== 'created' &&
					operation.kind !== 'existing' &&
					operation.kind !== 'untracked'
				)
					return { kind: 'not-dispatched', reason: operation.kind };
				if (operation.kind !== 'untracked') {
					const record = operationRecordSchema.parse(operation.record);
					if (
						!sameOperation(record.key, invocation.operationKey) ||
						record.intentDigest !== invocation.intentDigest
					)
						return { kind: 'not-dispatched', reason: 'conflict' };
					if (record.state.kind === 'completed')
						return { kind: 'completed', result: record.state.result };
					if (record.state.kind === 'armed' || record.state.kind === 'ambiguous')
						return { kind: 'ambiguous', reason: 'operation-may-have-dispatched' };
					if (record.state.kind === 'result-expired') return { kind: 'result-expired' };
				}
				if (state.kind === 'approval-each-call') {
					const challenge = await props.approvals.challenge(invocation);
					if (challenge.kind === 'pending') {
						const pending = approvalChallengeSchema.parse(challenge.challenge);
						if (
							pending.authority !== invocation.authority ||
							!sameOperation(pending.operationKey, invocation.operationKey) ||
							pending.intentDigest !== invocation.intentDigest ||
							canonicalDispatchJson(jsonValueSchema.parse(pending.revisions)) !==
								canonicalDispatchJson(jsonValueSchema.parse(invocation.admissionRevisions)) ||
							Date.parse(pending.expiresAt) <= props.now()
						)
							return unavailable();
						return {
							kind: 'pending',
							reference: pending.approvalId,
							detail: jsonValueSchema.parse(pending),
						};
					}
					if (challenge.kind !== 'approved')
						return { kind: 'not-dispatched', reason: challenge.kind };
					const offered = approvalReceiptSchema.parse(challenge.receipt);
					if (!receiptMatches(offered, invocation, props.now())) return unavailable();
					const current = await props.approvals.receipt({
						invocation,
						reference: offered.reference,
					});
					if (current.kind !== 'approved') return { kind: 'not-dispatched', reason: current.kind };
					const receipt = approvalReceiptSchema.parse(current.receipt);
					if (
						receipt.reference !== offered.reference ||
						!receiptMatches(receipt, invocation, props.now())
					)
						return unavailable();
					invocation = { ...invocation, approvalReceiptRef: receipt.reference };
				}
				let armedRevision: string | null = null;
				if (operation.kind !== 'untracked') {
					const armed = await props.operations.transition({
						invocation,
						expectedRevision: operation.record.revision,
						next: { kind: 'armed' },
					});
					if (armed.kind !== 'found') return { kind: 'not-dispatched', reason: armed.kind };
					const armedRecord = operationRecordSchema.parse(armed.record);
					if (
						!sameOperation(armedRecord.key, invocation.operationKey) ||
						armedRecord.intentDigest !== invocation.intentDigest ||
						armedRecord.state.kind !== 'armed'
					)
						return unavailable();
					armedRevision = armed.record.revision;
				}
				const result = resourceResultSchema.parse(await backend.invoke(invocation));
				if (result.kind === 'completed' && armedRevision !== null) {
					const completed = await props.operations.transition({
						invocation,
						expectedRevision: armedRevision,
						next: { kind: 'completed', result: result.result },
					});
					if (completed.kind !== 'found')
						return { kind: 'ambiguous', reason: 'completion-unconfirmed' };
				}
				return result;
			} catch {
				return { kind: 'ambiguous', reason: 'resource-authority-unconfirmed' };
			}
		},
	};
}
