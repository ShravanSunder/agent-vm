import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

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
	readonly key: Buffer;
}

export interface VerifyApprovalTokenProps {
	readonly agentId: string;
	readonly calls: readonly ApprovalTokenCallDigest[];
	readonly key: Buffer;
	readonly nowMs: number;
	readonly token: string;
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
				| 'signature-mismatch';
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
	})
	.strict();

type ApprovalTokenPayload = z.infer<typeof approvalTokenPayloadSchema>;

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
	const payload = {
		agentId: props.agentId,
		calls: [...props.calls],
		exp: props.expiresAtMs,
	} satisfies ApprovalTokenPayload;
	const payloadEncoded = base64UrlEncode(canonicalize(payload));
	const signature = createHmac('sha256', props.key).update(payloadEncoded).digest('base64url');
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
	const parts = props.token.split('.');
	if (parts.length !== 2) {
		return { ok: false, reason: 'malformed' };
	}
	const payloadEncoded = parts[0];
	const signatureEncoded = parts[1];
	if (payloadEncoded === undefined || signatureEncoded === undefined) {
		return { ok: false, reason: 'malformed' };
	}
	const expectedSignature = createHmac('sha256', props.key).update(payloadEncoded).digest();
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
	if (payload.agentId !== props.agentId) {
		return { ok: false, reason: 'agent-mismatch' };
	}
	if (!callsMatch(payload.calls, props.calls)) {
		return { ok: false, reason: 'call-mismatch' };
	}
	return { ok: true };
}
