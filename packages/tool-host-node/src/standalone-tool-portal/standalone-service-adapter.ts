import { randomUUID } from 'node:crypto';

import { createAccessAssessor } from '@agent-collaboration/tool-access/authorization';
import {
	jsonValueSchema,
	type HostAccessBinding,
} from '@agent-collaboration/tool-access/contracts';
import { canonicalDispatchJson } from '@agent-collaboration/tool-engine/capability-dispatch';
import { createStandaloneToolPortalCore } from '@agent-collaboration/tool-engine/standalone-tool-portal';

import type {
	NodeStandaloneInvocation,
	StandaloneToolPortalInvocationOptions,
	StandaloneToolPortalProjectionService,
} from '#node-host/standalone-tool-portal/models/standalone-portal-contracts';
import type { StandaloneToolPortalApprovalCoordinator } from '#node-host/standalone-tool-portal/standalone-batch-approval';
import { prepareStandaloneBatchDispatch } from '#node-host/standalone-tool-portal/standalone-batch-dispatch';

export function createNodeStandaloneToolPortalService(props: {
	readonly binding: HostAccessBinding;
	readonly approvalCoordinator: StandaloneToolPortalApprovalCoordinator;
	readonly resolveInvocation: (
		options: StandaloneToolPortalInvocationOptions,
	) => Promise<NodeStandaloneInvocation>;
	readonly now?: () => number;
}): StandaloneToolPortalProjectionService {
	const now = props.now ?? Date.now;
	const assessAccess = createAccessAssessor(props.binding);
	return createStandaloneToolPortalCore({
		binding: props.binding,
		now,
		resolveInvocation: async (options) => {
			const selected = await props.resolveInvocation(options);
			return {
				...selected,
				prepareBatch: async (plans) =>
					await prepareStandaloneBatchDispatch({
						plans,
						options,
						selected,
						coordinator: props.approvalCoordinator,
						now,
						receiptReference: randomUUID,
						validateCurrent: async (plan, invocation) => {
							const current = await props.resolveInvocation(options);
							if (
								current.authority !== selected.authority ||
								current.principal !== selected.principal ||
								current.verifiedContextRef !== selected.verifiedContextRef ||
								current.owningGeneration !== selected.owningGeneration ||
								canonicalDispatchJson(jsonValueSchema.parse(current.semanticRevisions)) !==
									canonicalDispatchJson(jsonValueSchema.parse(selected.semanticRevisions)) ||
								invocation.verifiedContextRef !== selected.verifiedContextRef ||
								invocation.operationKey.principal !== selected.principal ||
								invocation.operationKey.item !== plan.operationId ||
								invocation.capability.namespace !== plan.call.namespace ||
								invocation.capability.tool !== plan.call.name ||
								canonicalDispatchJson(jsonValueSchema.parse(invocation.arguments)) !==
									canonicalDispatchJson(plan.call.arguments)
							)
								return false;
							const access = await current.accessForCall(plan.call);
							const result = assessAccess(access);
							return (
								result.kind === 'assessed' &&
								result.assessment.kind === 'fixed' &&
								result.assessment.state.kind ===
									(plan.requiresApproval ? 'approval-each-call' : 'usable') &&
								canonicalDispatchJson(jsonValueSchema.parse(access)) ===
									canonicalDispatchJson(jsonValueSchema.parse(plan.request.access))
							);
						},
					}),
			};
		},
	});
}
