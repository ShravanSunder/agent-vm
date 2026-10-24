import { canonicalCallArguments } from '@agent-collaboration/tool-access/contracts';

import {
	type SignApprovalTokenProps,
	type SignAudienceScopedApprovalTokenProps,
	type ApprovalTokenPayload,
	approvalTokenPayloadSchema,
	type ApprovalTokenCallDigest,
	type VerifyApprovalTokenProps,
	type VerifyApprovalTokenResult,
	type VerifyAudienceScopedApprovalTokenProps,
	consumeApprovalTokenResultSchema,
} from '#mcp-gateway/call-approvals/models/call-approval';
import {
	encodeTokenBytes,
	signTokenBytes,
	decodeTokenBytes,
	verifyTokenBytes,
} from '#mcp-gateway/signed-tokens/token-signing-primitives';
export { hashCallArguments } from '@agent-collaboration/tool-access/contracts';

export const mcpPortalApprovalTokenAudience = 'mcp-portal:approval';

export async function signApprovalToken(props: SignApprovalTokenProps): Promise<string> {
	return signAudienceScopedApprovalToken({
		...props,
		audience: mcpPortalApprovalTokenAudience,
	});
}

export async function signAudienceScopedApprovalToken(
	props: SignAudienceScopedApprovalTokenProps,
): Promise<string> {
	assertApprovalTokenAudience(props.audience);
	const payload = {
		agentId: props.agentId,
		calls: [...props.calls],
		exp: props.expiresAtMs,
		iat: props.issuedAtMs ?? Date.now(),
		jti: props.jti ?? globalThis.crypto.randomUUID(),
	} satisfies ApprovalTokenPayload;
	const payloadEncoded = encodeTokenBytes(
		new TextEncoder().encode(canonicalCallArguments(payload)),
	);
	const signature = await signTokenBytes(
		props.key,
		createApprovalTokenSignatureInput(props.audience, payloadEncoded),
	);
	return `${payloadEncoded}.${signature}`;
}

function parseApprovalTokenPayload(payloadEncoded: string): ApprovalTokenPayload | null {
	try {
		return approvalTokenPayloadSchema.parse(
			JSON.parse(
				new TextDecoder('utf-8', { ignoreBOM: true }).decode(decodeTokenBytes(payloadEncoded)),
			),
		);
	} catch {
		return null;
	}
}

function isApprovalTokenParts(parts: readonly string[]): parts is readonly [string, string] {
	return parts.length === 2;
}

function callsMatch(
	leftCalls: readonly ApprovalTokenCallDigest[],
	rightCalls: readonly ApprovalTokenCallDigest[],
): boolean {
	if (leftCalls.length !== rightCalls.length) {
		return false;
	}
	return leftCalls.every((leftCall, index) => {
		const rightCall = rightCalls[index];
		return (
			rightCall !== undefined &&
			leftCall.argumentsHash === rightCall.argumentsHash &&
			leftCall.namespace === rightCall.namespace &&
			leftCall.toolName === rightCall.toolName
		);
	});
}

export async function verifyApprovalToken(
	props: VerifyApprovalTokenProps,
): Promise<VerifyApprovalTokenResult> {
	return verifyAudienceScopedApprovalToken({
		...props,
		audience: mcpPortalApprovalTokenAudience,
	});
}

export async function verifyAudienceScopedApprovalToken(
	props: VerifyAudienceScopedApprovalTokenProps,
): Promise<VerifyApprovalTokenResult> {
	assertApprovalTokenAudience(props.audience);
	const parts = props.token.split('.');
	if (!isApprovalTokenParts(parts)) {
		return { ok: false, reason: 'malformed' };
	}
	const [payloadEncoded, signatureEncoded] = parts;
	try {
		const valid = await verifyTokenBytes({
			key: props.key,
			input: createApprovalTokenSignatureInput(props.audience, payloadEncoded),
			signature: decodeTokenBytes(signatureEncoded),
		});
		if (!valid) return { ok: false, reason: 'signature-mismatch' };
	} catch {
		return { ok: false, reason: 'signature-mismatch' };
	}

	const payload = parseApprovalTokenPayload(payloadEncoded);
	if (payload === null) {
		return { ok: false, reason: 'malformed' };
	}
	if (payload.exp <= props.nowMs) {
		return { ok: false, reason: 'expired' };
	}
	if (props.maxLifetimeMs !== undefined && payload.exp - payload.iat > props.maxLifetimeMs) {
		return { ok: false, reason: 'ttl-exceeded' };
	}
	if (payload.agentId !== props.agentId) {
		return { ok: false, reason: 'agent-mismatch' };
	}
	if (!callsMatch(payload.calls, props.calls)) {
		return { ok: false, reason: 'call-mismatch' };
	}
	try {
		const answer = consumeApprovalTokenResultSchema.safeParse(
			await props.consumeTokenId(payload.jti, payload.exp),
		);
		if (!answer.success) return { ok: false, reason: 'replay-store-unavailable' };
		if (!answer.data.ok) return answer.data;
	} catch {
		return { ok: false, reason: 'replay-store-unavailable' };
	}
	return { ok: true };
}

function createApprovalTokenSignatureInput(audience: string, payloadEncoded: string): string {
	return `${audience}\0${payloadEncoded}`;
}

function assertApprovalTokenAudience(audience: string): void {
	if (audience.length === 0 || audience !== audience.trim() || audience.includes('\0')) {
		throw new Error('Portal approval-token audience must be a non-empty canonical string.');
	}
}
