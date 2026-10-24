import { z } from 'zod';

export const consumeApprovalTokenResultSchema = z.discriminatedUnion('ok', [
	z.strictObject({ ok: z.literal(true) }),
	z.strictObject({
		ok: z.literal(false),
		reason: z.enum(['replayed', 'replay-cache-full', 'replay-store-unavailable']),
	}),
]);

export type ConsumeApprovalTokenResult = z.infer<typeof consumeApprovalTokenResultSchema>;

/** Resolves only after the authority atomically records first use, or refuses it. */
export type ConsumeApprovalTokenId = (
	tokenId: string,
	expiresAtMs: number,
) => Promise<ConsumeApprovalTokenResult>;

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

export type ApprovalTokenCallDigest = z.infer<typeof approvalTokenCallDigestSchema>;

export interface SignApprovalTokenProps {
	/** Canonical principal key supplied by the host; never an OAuth credential ID. */
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
	/** Canonical principal key supplied by the host; never an OAuth credential ID. */
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

export const approvalTokenPayloadSchema = z
	.object({
		agentId: z.string().min(1),
		calls: z.array(approvalTokenCallDigestSchema),
		exp: z.number().int(),
		iat: z.number().int(),
		jti: z.string().min(1),
	})
	.strict();

export type ApprovalTokenPayload = z.infer<typeof approvalTokenPayloadSchema>;
