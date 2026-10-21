import {
	hashCallArguments,
	type AssessAccessInput,
	type AssessAccessResult,
} from '@agent-collaboration/tool-access/contracts';
import type {
	ApprovalPort,
	ApprovalReceipt,
	DispatchInvocation,
} from '@agent-collaboration/tool-engine/dispatch';

import type { ConsumeApprovalTokenId } from '#mcp-gateway/approval-token-use';
import { verifyApprovalToken } from '#mcp-gateway/hmac-token';
import type { PreparedPortalCall } from '#mcp-gateway/portal-tool-contracts';
import { decodeTokenBytes } from '#mcp-gateway/token-crypto';

export interface GatewayApprovalTokens {
	readonly key: Uint8Array;
	readonly consumeTokenId: ConsumeApprovalTokenId;
	readonly maxLifetimeMs?: number;
}
export interface VerifiedCallApproval {
	readonly reference: string;
	readonly expiresAtMs: number;
}
export type PortalCallAuthorization =
	| { readonly kind: 'token-approved'; readonly approval: VerifiedCallApproval }
	| { readonly kind: 'token-missing' }
	| { readonly kind: 'refused'; readonly reason: string };

export async function authorizeGatewayCalls(props: {
	readonly calls: readonly PreparedPortalCall[];
	readonly token: string | undefined;
	readonly tokens: GatewayApprovalTokens | undefined;
	readonly agentId: string;
	readonly now: () => number;
	readonly accessFor: (
		capability: AssessAccessInput['capability'],
		call: AssessAccessInput['call'],
	) => Promise<AssessAccessInput>;
	readonly assessAccess: (input: AssessAccessInput) => AssessAccessResult;
}): Promise<ReadonlyMap<string, PortalCallAuthorization>> {
	const authorizations = new Map<string, PortalCallAuthorization>();
	// Hosts without proxy token configuration keep their assigned ApprovalPort behavior.
	if (props.token === undefined && props.tokens === undefined) return authorizations;
	const assessments = await Promise.all(
		props.calls.map(async (call) => {
			const argumentsHash = await hashCallArguments(call.validatedArguments);
			const digest = Array.from(decodeTokenBytes(argumentsHash), (byte) =>
				byte.toString(16).padStart(2, '0'),
			).join('');
			const access = await props.accessFor(
				{ namespace: call.tool.namespace, tool: call.tool.toolName },
				{ arguments: call.validatedArguments, digest, account: null },
			);
			return { call, argumentsHash, assessed: props.assessAccess(access) };
		}),
	);
	const protectedCalls = assessments.filter(
		({ assessed }) =>
			assessed.kind === 'assessed' &&
			assessed.assessment.kind === 'fixed' &&
			assessed.assessment.state.kind === 'approval-each-call',
	);
	if (protectedCalls.length === 0) return authorizations;
	if (props.token === undefined) {
		for (const { call } of protectedCalls)
			authorizations.set(call.input.id, { kind: 'token-missing' });
		return authorizations;
	}
	const tokens = props.tokens;
	let approval: VerifiedCallApproval | undefined;
	const verification =
		tokens === undefined
			? ({ ok: false, reason: 'approval-configuration-missing' } as const)
			: await verifyApprovalToken({
					agentId: props.agentId,
					calls: protectedCalls.map(({ call, argumentsHash }) => ({
						argumentsHash,
						namespace: call.tool.namespace,
						toolName: call.tool.toolName,
					})),
					key: tokens.key,
					...(tokens.maxLifetimeMs === undefined ? {} : { maxLifetimeMs: tokens.maxLifetimeMs }),
					nowMs: props.now(),
					token: props.token,
					consumeTokenId: async (tokenId, expiresAtMs) => {
						const result = await tokens.consumeTokenId(tokenId, expiresAtMs);
						if (result?.ok) approval = { reference: `mcp-approval:${tokenId}`, expiresAtMs };
						return result;
					},
				});
	if (!verification.ok || approval === undefined) {
		for (const { call } of protectedCalls)
			authorizations.set(call.input.id, {
				kind: 'refused',
				reason: verification.ok ? 'replay-store-unavailable' : verification.reason,
			});
		return authorizations;
	}
	for (const { call } of protectedCalls)
		authorizations.set(call.input.id, { kind: 'token-approved', approval });
	return authorizations;
}

/** The signed batch is already consumed; each protected item still needs its exact receipt. */
export function approvedTokenPort(approval: VerifiedCallApproval): ApprovalPort {
	function receipt(invocation: DispatchInvocation): ApprovalReceipt {
		return {
			reference: approval.reference,
			decision: 'approve',
			authoritativeRevision: invocation.bindingRevision,
			operationKey: invocation.operationKey,
			intentDigest: invocation.intentDigest,
			backendKind: invocation.backendKind,
			bindingRevision: invocation.bindingRevision,
			admissionRevisions: invocation.admissionRevisions,
			verifiedContextRef: invocation.verifiedContextRef,
			expiresAt: new Date(approval.expiresAtMs).toISOString(),
		};
	}
	return {
		challenge: async (invocation) => ({ kind: 'approved', receipt: receipt(invocation) }),
		receipt: async ({ invocation, reference }) =>
			reference === approval.reference
				? { kind: 'approved', receipt: receipt(invocation) }
				: { kind: 'denied' },
		decision: async () => ({ kind: 'denied' }),
	};
}
