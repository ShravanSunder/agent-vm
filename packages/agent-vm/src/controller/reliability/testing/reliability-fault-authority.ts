import type {
	ReliabilityFaultApplyRequest,
	ReliabilityFaultRefusalReason,
} from './reliability-test-fault-contracts.js';

export type ReliabilityFaultAuthorizationResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: ReliabilityFaultRefusalReason };

interface ReliabilityFaultAuthorityOptions {
	readonly authorityId: string;
	readonly nowMs: () => number;
	readonly runId: string;
}

export class ReliabilityFaultAuthority {
	readonly #authorityId: string;
	readonly #nowMs: () => number;
	readonly #runId: string;
	readonly #usedActionIds = new Set<string>();
	readonly #usedNonces = new Set<string>();

	constructor(options: ReliabilityFaultAuthorityOptions) {
		this.#authorityId = options.authorityId;
		this.#nowMs = options.nowMs;
		this.#runId = options.runId;
	}

	authorize(request: ReliabilityFaultApplyRequest): ReliabilityFaultAuthorizationResult {
		if (request.authorityId !== this.#authorityId) {
			return { ok: false, reason: 'invalid-authority' };
		}
		if (request.runId !== this.#runId) {
			return { ok: false, reason: 'wrong-run' };
		}
		if (request.expiresAtMs <= this.#nowMs()) {
			return { ok: false, reason: 'expired-request' };
		}
		if (this.#usedActionIds.has(request.actionId) || this.#usedNonces.has(request.nonce)) {
			return { ok: false, reason: 'replayed-request' };
		}

		this.#usedActionIds.add(request.actionId);
		this.#usedNonces.add(request.nonce);
		return { ok: true };
	}
}
