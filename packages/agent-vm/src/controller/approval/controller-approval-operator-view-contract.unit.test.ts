import type { GatewayRuntimeApprovalChallenge } from '@agent-vm/gateway-control-contracts';
import { describe, expect, it } from 'vitest';

import type {
	ControllerApprovalDecisionResult,
	ControllerApprovalOperatorIdentity,
	ControllerApprovalOperatorView,
	ControllerApprovalRevocationResult,
} from './controller-approval-ledger.js';

declare const approvalChallenge: GatewayRuntimeApprovalChallenge;
declare const approvalOperator: ControllerApprovalOperatorIdentity;

type AssertControllerApprovalOperatorView<TView extends ControllerApprovalOperatorView> = TView;
type AssertControllerApprovalDecisionResult<TResult extends ControllerApprovalDecisionResult> =
	TResult;
type AssertControllerApprovalRevocationResult<TResult extends ControllerApprovalRevocationResult> =
	TResult;

export type ValidApprovedOperatorView = AssertControllerApprovalOperatorView<{
	readonly challenge: typeof approvalChallenge;
	readonly decision: {
		readonly decidedAt: string;
		readonly decision: 'approve';
		readonly operator: typeof approvalOperator;
	};
	readonly kind: 'approved';
}>;

export type ValidDeniedOperatorView = AssertControllerApprovalOperatorView<{
	readonly challenge: typeof approvalChallenge;
	readonly decision: {
		readonly decidedAt: string;
		readonly decision: 'deny';
		readonly operator: typeof approvalOperator;
	};
	readonly kind: 'denied';
}>;

// @ts-expect-error Approved operator views must contain an approve decision.
export type InvalidApprovedWithDenyDecision = AssertControllerApprovalOperatorView<{
	readonly challenge: typeof approvalChallenge;
	readonly decision: {
		readonly decidedAt: string;
		readonly decision: 'deny';
		readonly operator: typeof approvalOperator;
	};
	readonly kind: 'approved';
}>;

// @ts-expect-error Denied operator views must contain a deny decision.
export type InvalidDeniedWithApproveDecision = AssertControllerApprovalOperatorView<{
	readonly challenge: typeof approvalChallenge;
	readonly decision: {
		readonly decidedAt: string;
		readonly decision: 'approve';
		readonly operator: typeof approvalOperator;
	};
	readonly kind: 'denied';
}>;

// @ts-expect-error Recorded approve results must carry an approved operator view.
export type InvalidApprovedResultWithDeniedView = AssertControllerApprovalDecisionResult<{
	readonly decision: 'approve';
	readonly kind: 'recorded';
	readonly view: ValidDeniedOperatorView;
}>;

// @ts-expect-error Recorded deny results must carry a denied operator view.
export type InvalidDeniedResultWithApprovedView = AssertControllerApprovalDecisionResult<{
	readonly decision: 'deny';
	readonly kind: 'recorded';
	readonly view: ValidApprovedOperatorView;
}>;

// @ts-expect-error Recorded revocations must carry a revoked operator view.
export type InvalidRevocationResultWithApprovedView = AssertControllerApprovalRevocationResult<{
	readonly kind: 'recorded';
	readonly view: ValidApprovedOperatorView;
}>;

describe('controller approval operator view compile contract', () => {
	it('keeps correlated approved and denied variants available to consumers', () => {
		// Arrange / Act / Assert
		expect(true).toBe(true);
	});
});
