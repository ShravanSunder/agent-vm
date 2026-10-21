import type { ConsumeApprovalTokenId } from '#mcp-gateway/call-approvals/models/call-approval';

/** One instance per signing-key/agent scope; machine lifetime only, never durable. */
export function createInMemoryApprovalTokenUse(props: {
	readonly now: () => number;
	readonly limit?: number;
}): ConsumeApprovalTokenId {
	const consumedTokens = new Map<string, number>();
	const limit = props.limit ?? 4096;
	return async (tokenId, expiresAtMs) => {
		const now = props.now();
		for (const [key, expiry] of consumedTokens) {
			if (expiry <= now) consumedTokens.delete(key);
		}
		if (consumedTokens.has(tokenId)) return { ok: false, reason: 'replayed' };
		if (consumedTokens.size >= limit) return { ok: false, reason: 'replay-cache-full' };
		consumedTokens.set(tokenId, expiresAtMs);
		return { ok: true };
	};
}
