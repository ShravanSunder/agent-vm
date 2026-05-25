import type { ResolvedMcpPortalProfile } from '@agent-vm/config-contracts';
import { mcpPortalCallPolicyDecision } from '@agent-vm/config-contracts';

import type { PortalAgentIdentity } from '../portal-access-policy.js';
import { hashCallArguments, verifyApprovalToken } from '../portal-auth/hmac-token.js';
import type {
	PortalApprovalCall,
	PortalApprovalCallDecision,
	PortalApprovalEvaluation,
} from './portal-tools.js';

export interface PortalApprovalPolicyRecord {
	readonly hmacKey?: Buffer;
	readonly profile: ResolvedMcpPortalProfile;
}

export interface CreatePortalPolicyApprovalEvaluatorProps {
	readonly consumeTokenId?: (
		agentId: string,
		jti: string,
		expiresAtMs: number,
	) =>
		| { readonly ok: true }
		| { readonly ok: false; readonly reason: 'replay-cache-full' | 'replayed' };
	readonly missingApprovalTokenDecision?: Extract<
		PortalApprovalCallDecision,
		{ readonly kind: 'approval_required' | 'approval_token_missing' }
	>;
	readonly maxLifetimeMs?: number;
	readonly nowMs?: () => number;
	readonly resolveRecord: (agentId: string) => PortalApprovalPolicyRecord | undefined;
}

function approvalTokenCallDigests(calls: readonly PortalApprovalCall[]): readonly {
	readonly argumentsHash: string;
	readonly namespace: string;
	readonly toolName: string;
}[] {
	return calls.map((call) => ({
		argumentsHash: hashCallArguments(call.arguments),
		namespace: call.namespace,
		toolName: call.toolName,
	}));
}

function callDecisionFromVerifierReason(
	reason: string,
): Extract<PortalApprovalCallDecision, { readonly kind: 'approval_token_invalid' }> {
	return { kind: 'approval_token_invalid', reason };
}

export function createPortalPolicyApprovalEvaluator(
	props: CreatePortalPolicyApprovalEvaluatorProps,
): (
	calls: readonly PortalApprovalCall[],
	identity: PortalAgentIdentity | string,
	token: string | undefined,
) => PortalApprovalEvaluation {
	return (calls, identity, token) => {
		const agentId = typeof identity === 'string' ? identity : identity.agentId;
		const record = props.resolveRecord(agentId);
		if (record === undefined) {
			const decisionsByCallId: Record<string, PortalApprovalCallDecision> = {};
			for (const call of calls) {
				decisionsByCallId[call.id] = callDecisionFromVerifierReason('unknown-agent');
			}
			return { decisionsByCallId };
		}

		const decisionsByCallId: Record<string, PortalApprovalCallDecision> = {};
		const callsRequiringApproval: PortalApprovalCall[] = [];
		for (const call of calls) {
			const policyDecision = mcpPortalCallPolicyDecision(record.profile, {
				...(call.tool.annotations === undefined ? {} : { annotations: call.tool.annotations }),
				namespace: call.namespace,
				toolName: call.toolName,
			});
			if (policyDecision.kind === 'allow_without_approval') {
				decisionsByCallId[call.id] = { kind: 'allow' };
				continue;
			}
			if (policyDecision.kind === 'requires_approval') {
				callsRequiringApproval.push(call);
				continue;
			}
			decisionsByCallId[call.id] = { kind: 'call_blocked' };
		}

		if (callsRequiringApproval.length === 0) {
			return { decisionsByCallId };
		}
		if (record.hmacKey === undefined) {
			for (const call of callsRequiringApproval) {
				decisionsByCallId[call.id] = callDecisionFromVerifierReason('missing-hmac-key');
			}
			return { decisionsByCallId };
		}
		if (token === undefined) {
			const missingTokenDecision = props.missingApprovalTokenDecision ?? {
				kind: 'approval_token_missing',
			};
			for (const call of callsRequiringApproval) {
				decisionsByCallId[call.id] = missingTokenDecision;
			}
			return { decisionsByCallId };
		}

		const consumeTokenId = props.consumeTokenId;
		const verification = verifyApprovalToken({
			agentId,
			calls: approvalTokenCallDigests(callsRequiringApproval),
			...(consumeTokenId === undefined
				? {}
				: {
						consumeTokenId: (jti: string, expiresAtMs: number) =>
							consumeTokenId(agentId, jti, expiresAtMs),
					}),
			key: record.hmacKey,
			...(props.maxLifetimeMs === undefined ? {} : { maxLifetimeMs: props.maxLifetimeMs }),
			nowMs: props.nowMs?.() ?? Date.now(),
			token,
		});

		if (!verification.ok) {
			for (const call of callsRequiringApproval) {
				decisionsByCallId[call.id] = callDecisionFromVerifierReason(verification.reason);
			}
			return { decisionsByCallId };
		}

		for (const call of callsRequiringApproval) {
			decisionsByCallId[call.id] = { kind: 'allow' };
		}
		return { decisionsByCallId };
	};
}
