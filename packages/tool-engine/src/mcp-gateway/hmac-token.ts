import { canonicalCallArguments } from '@agent-collaboration/tool-access/contracts';
import { z } from 'zod';

import {
	consumeApprovalTokenResultSchema,
	type ConsumeApprovalTokenId,
} from '#mcp-gateway/approval-token-use';
import {
	decodeTokenBytes,
	encodeTokenBytes,
	signTokenBytes,
	verifyTokenBytes,
} from '#mcp-gateway/token-crypto';

export { hashCallArguments } from '@agent-collaboration/tool-access/contracts';

export type ApprovalTokenCallDigest = z.infer<typeof approvalTokenCallDigestSchema>;

export interface SignApprovalTokenProps {
	readonly agentId: string;
	readonly calls: readonly ApprovalTokenCallDigest[];
	readonly expiresAtMs: number;
	readonly issuedAtMs?: number;
	readonly jti?: string;
	readonly key: Uint8Array;
}

export interface SignAudienceScopedApprovalTokenProps extends SignApprovalTokenProps {
	readonly audience: string;
}

export interface VerifyApprovalTokenProps {
	readonly agentId: string;
	readonly calls: readonly ApprovalTokenCallDigest[];
	readonly key: Uint8Array;
	readonly consumeTokenId: ConsumeApprovalTokenId;
	readonly maxLifetimeMs?: number;
	readonly nowMs: number;
	readonly token: string;
}

export interface VerifyAudienceScopedApprovalTokenProps extends VerifyApprovalTokenProps {
	readonly audience: string;
}

export type VerifyApprovalTokenResult =
	| { readonly ok: true }
	| {
			readonly ok: false;
			readonly reason:
				| 'agent-mismatch'
				| 'call-mismatch'
				| 'expired'
				| 'malformed'
				| 'replay-store-unavailable'
				| 'replay-cache-full'
				| 'replayed'
				| 'signature-mismatch'
				| 'ttl-exceeded';
	  };

const approvalTokenCallDigestSchema = z
	.object({
		argumentsHash: z.string().min(1),
		namespace: z.string().min(1),
		toolName: z.string().min(1),
	})
	.strict();

const approvalTokenPayloadSchema = z
	.object({
		agentId: z.string().min(1),
		calls: z.array(approvalTokenCallDigestSchema),
		exp: z.number().int(),
		iat: z.number().int(),
		jti: z.string().min(1),
	})
	.strict();

type ApprovalTokenPayload = z.infer<typeof approvalTokenPayloadSchema>;

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
