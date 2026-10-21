import {
	approvalUsesSchema,
	type ApprovalTokenUseDecision,
} from '#tool-host-core/organization-authority/models/organization-authority-state';

/** Preserve the row's insertion order and its existing expiry/replay semantics. */
export function decideApprovalTokenUse(props: {
	readonly state: unknown;
	readonly tokenId: string;
	readonly expiresAtMs: number;
	readonly nowMs: number;
	readonly cap: number;
}): ApprovalTokenUseDecision {
	const uses = approvalUsesSchema.parse(props.state ?? {});
	if ((uses[props.tokenId] ?? 0) > props.nowMs)
		return { result: { ok: false, reason: 'replayed' } };
	const retained = Object.fromEntries(
		Object.entries(uses).filter(([, expiry]) => expiry > props.nowMs),
	);
	retained[props.tokenId] = props.expiresAtMs;
	if (new TextEncoder().encode(JSON.stringify(retained)).byteLength > props.cap)
		return { result: { ok: false, reason: 'replay-cache-full' } };
	return { result: { ok: true }, next: retained };
}
