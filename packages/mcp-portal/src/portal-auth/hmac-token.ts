import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

export interface ApprovalTokenCallDigest {
	readonly argumentsHash: string;
	readonly namespace: string;
	readonly toolName: string;
}

export interface SignApprovalTokenProps {
	readonly agentId: string;
	readonly calls: readonly ApprovalTokenCallDigest[];
	readonly expiresAtMs: number;
	readonly issuedAtMs?: number;
	readonly jti?: string;
	readonly key: Buffer;
}

export interface SignAudienceScopedApprovalTokenProps extends SignApprovalTokenProps {
	readonly audience: string;
}

export interface VerifyApprovalTokenProps {
	readonly agentId: string;
	readonly calls: readonly ApprovalTokenCallDigest[];
	readonly key: Buffer;
	readonly consumeTokenId?: (
		jti: string,
		expiresAtMs: number,
	) =>
		| { readonly ok: true }
		| { readonly ok: false; readonly reason: 'replay-cache-full' | 'replayed' };
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

function base64UrlEncode(value: Buffer | string): string {
	const buffer = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
	return buffer.toString('base64url');
}

function canonicalize(value: unknown): string {
	if (value === null || typeof value !== 'object') {
		return JSON.stringify(value ?? null);
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalize).join(',')}]`;
	}
	const entries = Object.entries(value)
		.filter((entry) => entry[1] !== undefined)
		.toSorted(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
		.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalize(entryValue)}`);
	return `{${entries.join(',')}}`;
}

export function hashCallArguments(args: unknown): string {
	return createHash('sha256').update(canonicalize(args)).digest('base64url');
}

export function signApprovalToken(props: SignApprovalTokenProps): string {
	return signAudienceScopedApprovalToken({
		...props,
		audience: mcpPortalApprovalTokenAudience,
	});
}

export function signAudienceScopedApprovalToken(
	props: SignAudienceScopedApprovalTokenProps,
): string {
	assertApprovalTokenAudience(props.audience);
	const payload = {
		agentId: props.agentId,
		calls: [...props.calls],
		exp: props.expiresAtMs,
		iat: props.issuedAtMs ?? Date.now(),
		jti: props.jti ?? randomUUID(),
	} satisfies ApprovalTokenPayload;
	const payloadEncoded = base64UrlEncode(canonicalize(payload));
	const signature = createHmac('sha256', props.key)
		.update(createApprovalTokenSignatureInput(props.audience, payloadEncoded))
		.digest('base64url');
	return `${payloadEncoded}.${signature}`;
}

function parseApprovalTokenPayload(payloadEncoded: string): ApprovalTokenPayload | null {
	try {
		return approvalTokenPayloadSchema.parse(
			JSON.parse(Buffer.from(payloadEncoded, 'base64url').toString('utf8')),
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

export function verifyApprovalToken(props: VerifyApprovalTokenProps): VerifyApprovalTokenResult {
	return verifyAudienceScopedApprovalToken({
		...props,
		audience: mcpPortalApprovalTokenAudience,
	});
}

export function verifyAudienceScopedApprovalToken(
	props: VerifyAudienceScopedApprovalTokenProps,
): VerifyApprovalTokenResult {
	assertApprovalTokenAudience(props.audience);
	const parts = props.token.split('.');
	if (!isApprovalTokenParts(parts)) {
		return { ok: false, reason: 'malformed' };
	}
	const [payloadEncoded, signatureEncoded] = parts;
	const expectedSignature = createHmac('sha256', props.key)
		.update(createApprovalTokenSignatureInput(props.audience, payloadEncoded))
		.digest();
	const providedSignature = Buffer.from(signatureEncoded, 'base64url');
	if (
		providedSignature.length !== expectedSignature.length ||
		!timingSafeEqual(providedSignature, expectedSignature)
	) {
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
	if (props.consumeTokenId !== undefined) {
		const consumeResult = props.consumeTokenId(payload.jti, payload.exp);
		if (!consumeResult.ok) {
			return { ok: false, reason: consumeResult.reason };
		}
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
