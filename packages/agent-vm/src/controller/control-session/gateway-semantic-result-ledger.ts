import { createHash } from 'node:crypto';

import type { GatewayEpochIdentity } from '../vm-ownership/vm-ownership-contracts.js';

export const GATEWAY_SEMANTIC_CANONICAL_PAYLOAD_VERSION = 1 as const;
export const GATEWAY_SEMANTIC_ACTIVE_CAPACITY = 2_048;
export const GATEWAY_SEMANTIC_ACTIVE_WINDOW_MS = 10 * 60 * 1_000;
export const GATEWAY_SEMANTIC_TOMBSTONE_CAPACITY = 4_096;
export const GATEWAY_SEMANTIC_TOMBSTONE_TTL_MS = 60 * 60 * 1_000;

export type GatewaySemanticJsonValue =
	| boolean
	| null
	| number
	| string
	| readonly GatewaySemanticJsonValue[]
	| { readonly [key: string]: GatewaySemanticJsonValue };

export type GatewaySemanticEpoch = Pick<
	GatewayEpochIdentity,
	'controllerEpoch' | 'gatewayEpochId' | 'gatewayVmId' | 'zoneId'
>;

export type GatewaySemanticGenerationProfile =
	| {
			readonly compatibilityId: string;
			readonly currentLeafTargetId: string | null;
			readonly kind: 'lease_authority';
			readonly stablePrincipal: string;
	  }
	| {
			readonly kind: 'active_use';
			readonly leafGeneration: string;
			readonly processEpoch: string;
			readonly stablePrincipal: string;
			readonly useId: string;
	  }
	| {
			readonly attachmentGeneration: number;
			readonly kind: 'session_safety';
			readonly processEpoch: string;
			readonly sessionId: string;
	  };

export interface GatewaySemanticOperationIdentity {
	readonly commandId: string;
	readonly gateway: GatewaySemanticEpoch;
	readonly idempotencyKey: string;
	readonly operation: string;
	readonly profile: GatewaySemanticGenerationProfile;
	readonly target: string;
	readonly validUntilMs: number;
}

export interface GatewaySemanticPayloadDigest {
	readonly algorithm: 'sha256';
	readonly canonicalVersion: typeof GATEWAY_SEMANTIC_CANONICAL_PAYLOAD_VERSION;
	readonly digest: string;
}

export type GatewaySemanticLedgerDecision<TResult> =
	| { readonly kind: 'capacity_exhausted' }
	| { readonly kind: 'completed'; readonly value: TResult }
	| { readonly kind: 'gateway_mismatch' }
	| { readonly kind: 'idempotency_collision' }
	| { readonly kind: 'operation_expired' }
	| { readonly kind: 'operation_window_invalid' }
	| { readonly kind: 'unknown_side_effect' };

export interface GatewaySemanticResultLedger {
	executeMutating(options: {
		readonly handler: () => Promise<unknown>;
		readonly identity: GatewaySemanticOperationIdentity;
		readonly payload: GatewaySemanticJsonValue;
	}): Promise<GatewaySemanticLedgerDecision<unknown>>;
	prune(): GatewaySemanticPruneResult;
	snapshot(): GatewaySemanticLedgerSnapshot;
}

export interface GatewaySemanticPruneResult {
	readonly activePruned: number;
	readonly blocked: number;
	readonly tombstonesPruned: number;
}

export interface GatewaySemanticLedgerSnapshot {
	readonly activeCount: number;
	readonly gateway: GatewaySemanticEpoch;
	readonly tombstoneCount: number;
}

interface ActiveSemanticEntry {
	readonly correlationKey: string;
	readonly deadlineMs: number;
	readonly meaningKey: string;
	readonly order: number;
	promise: Promise<GatewaySemanticLedgerDecision<unknown>>;
	status: 'completed' | 'pending' | 'unknown_side_effect';
}

interface UnknownSideEffectTombstone {
	readonly correlationKey: string;
	readonly expiresAtMs: number;
	readonly meaningKey: string;
}

interface CreateGatewaySemanticResultLedgerOptions {
	readonly activeCapacity?: number;
	readonly activeWindowMs?: number;
	readonly gateway: GatewaySemanticEpoch;
	readonly nowMs: () => number;
	readonly tombstoneCapacity?: number;
	readonly tombstoneTtlMs?: number;
}

function assertNever(value: never): never {
	throw new Error(`Unsupported Gateway semantic generation profile: ${JSON.stringify(value)}`);
}

function isGatewaySemanticJsonArray(
	value: GatewaySemanticJsonValue,
): value is readonly GatewaySemanticJsonValue[] {
	return Array.isArray(value);
}

function canonicalizeJsonValue(value: GatewaySemanticJsonValue): string {
	if (value === null) {
		return 'null';
	}
	if (typeof value === 'boolean' || typeof value === 'string') {
		return JSON.stringify(value);
	}
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) {
			throw new TypeError('Gateway semantic canonical JSON rejects non-finite numbers.');
		}
		return JSON.stringify(Object.is(value, -0) ? 0 : value);
	}
	if (isGatewaySemanticJsonArray(value)) {
		return `[${value.map((item) => canonicalizeJsonValue(item)).join(',')}]`;
	}
	const objectValue: { readonly [key: string]: GatewaySemanticJsonValue } = value;
	return `{${Object.keys(objectValue)
		.toSorted()
		.map((key) => {
			const item = objectValue[key];
			if (item === undefined) {
				throw new TypeError('Gateway semantic canonical JSON rejects undefined object values.');
			}
			return `${JSON.stringify(key)}:${canonicalizeJsonValue(item)}`;
		})
		.join(',')}}`;
}

export function parseGatewaySemanticJsonValue(value: unknown): GatewaySemanticJsonValue {
	if (
		value === null ||
		typeof value === 'boolean' ||
		typeof value === 'string' ||
		(typeof value === 'number' && Number.isFinite(value))
	) {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((item) => parseGatewaySemanticJsonValue(item));
	}
	if (typeof value === 'object') {
		const parsedEntries = Object.entries(value).map(([key, item]) => {
			if (item === undefined) {
				throw new TypeError('Gateway semantic JSON rejects undefined object values.');
			}
			return [key, parseGatewaySemanticJsonValue(item)] as const;
		});
		return Object.fromEntries(parsedEntries);
	}
	throw new TypeError('Gateway semantic payload is not JSON-compatible.');
}

export function canonicalGatewaySemanticPayloadDigest(
	payload: GatewaySemanticJsonValue,
): GatewaySemanticPayloadDigest {
	const canonicalPayload = canonicalizeJsonValue(payload);
	return {
		algorithm: 'sha256',
		canonicalVersion: GATEWAY_SEMANTIC_CANONICAL_PAYLOAD_VERSION,
		digest: createHash('sha256')
			.update(`agent-vm-gateway-semantic-payload-v1\n${canonicalPayload}`, 'utf8')
			.digest('hex'),
	};
}

function gatewaySemanticEpochValue(gateway: GatewaySemanticEpoch): GatewaySemanticJsonValue {
	return {
		controllerEpoch: gateway.controllerEpoch,
		gatewayEpochId: gateway.gatewayEpochId,
		gatewayVmId: gateway.gatewayVmId,
		zoneId: gateway.zoneId,
	};
}

function generationProfileValue(
	profile: GatewaySemanticGenerationProfile,
): GatewaySemanticJsonValue {
	switch (profile.kind) {
		case 'lease_authority':
			return {
				compatibilityId: profile.compatibilityId,
				currentLeafTargetId: profile.currentLeafTargetId,
				kind: profile.kind,
				stablePrincipal: profile.stablePrincipal,
			};
		case 'active_use':
			return {
				kind: profile.kind,
				leafGeneration: profile.leafGeneration,
				processEpoch: profile.processEpoch,
				stablePrincipal: profile.stablePrincipal,
				useId: profile.useId,
			};
		case 'session_safety':
			return {
				attachmentGeneration: profile.attachmentGeneration,
				kind: profile.kind,
				processEpoch: profile.processEpoch,
				sessionId: profile.sessionId,
			};
		default:
			return assertNever(profile);
	}
}

function principalScopeValue(profile: GatewaySemanticGenerationProfile): GatewaySemanticJsonValue {
	switch (profile.kind) {
		case 'lease_authority':
		case 'active_use':
			return { kind: 'stable_principal', stablePrincipal: profile.stablePrincipal };
		case 'session_safety':
			return { kind: 'session_safety' };
		default:
			return assertNever(profile);
	}
}

function gatewaysEqual(left: GatewaySemanticEpoch, right: GatewaySemanticEpoch): boolean {
	return (
		left.controllerEpoch === right.controllerEpoch &&
		left.gatewayEpochId === right.gatewayEpochId &&
		left.gatewayVmId === right.gatewayVmId &&
		left.zoneId === right.zoneId
	);
}

function correlationKeyForIdentity(identity: GatewaySemanticOperationIdentity): string {
	return canonicalizeJsonValue({
		commandId: identity.commandId,
		gateway: gatewaySemanticEpochValue(identity.gateway),
		idempotencyKey: identity.idempotencyKey,
		principalScope: principalScopeValue(identity.profile),
	});
}

function meaningKeyForIdentity(options: {
	readonly identity: GatewaySemanticOperationIdentity;
	readonly payloadDigest: GatewaySemanticPayloadDigest;
}): string {
	return canonicalizeJsonValue({
		commandId: options.identity.commandId,
		gateway: gatewaySemanticEpochValue(options.identity.gateway),
		idempotencyKey: options.identity.idempotencyKey,
		operation: options.identity.operation,
		payload: {
			algorithm: options.payloadDigest.algorithm,
			canonicalVersion: options.payloadDigest.canonicalVersion,
			digest: options.payloadDigest.digest,
		},
		profile: generationProfileValue(options.identity.profile),
		target: options.identity.target,
	});
}

function requirePositiveInteger(name: string, value: number): number {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new RangeError(`${name} must be a positive safe integer.`);
	}
	return value;
}

export function createGatewaySemanticResultLedger(
	options: CreateGatewaySemanticResultLedgerOptions,
): GatewaySemanticResultLedger {
	const activeCapacity = requirePositiveInteger(
		'activeCapacity',
		options.activeCapacity ?? GATEWAY_SEMANTIC_ACTIVE_CAPACITY,
	);
	const activeWindowMs = requirePositiveInteger(
		'activeWindowMs',
		options.activeWindowMs ?? GATEWAY_SEMANTIC_ACTIVE_WINDOW_MS,
	);
	const tombstoneCapacity = requirePositiveInteger(
		'tombstoneCapacity',
		options.tombstoneCapacity ?? GATEWAY_SEMANTIC_TOMBSTONE_CAPACITY,
	);
	const tombstoneTtlMs = requirePositiveInteger(
		'tombstoneTtlMs',
		options.tombstoneTtlMs ?? GATEWAY_SEMANTIC_TOMBSTONE_TTL_MS,
	);
	const activeEntries = new Map<string, ActiveSemanticEntry>();
	const tombstones = new Map<string, UnknownSideEffectTombstone>();
	let nextOrder = 1;

	const pruneExpiredTombstones = (nowMs: number): number => {
		let pruned = 0;
		for (const [correlationKey, tombstone] of tombstones) {
			if (tombstone.expiresAtMs > nowMs) {
				continue;
			}
			tombstones.delete(correlationKey);
			pruned += 1;
		}
		return pruned;
	};

	const moveActiveEntryToTombstone = (entry: ActiveSemanticEntry, nowMs: number): boolean => {
		if (tombstones.size >= tombstoneCapacity) {
			return false;
		}
		activeEntries.delete(entry.correlationKey);
		tombstones.set(entry.correlationKey, {
			correlationKey: entry.correlationKey,
			expiresAtMs: nowMs + tombstoneTtlMs,
			meaningKey: entry.meaningKey,
		});
		return true;
	};

	const pruneAt = (nowMs: number): GatewaySemanticPruneResult => {
		const tombstonesPruned = pruneExpiredTombstones(nowMs);
		let activePruned = 0;
		let blocked = 0;
		for (const entry of activeEntries.values()) {
			if (entry.deadlineMs > nowMs) {
				continue;
			}
			if (moveActiveEntryToTombstone(entry, nowMs)) {
				activePruned += 1;
			} else {
				blocked += 1;
			}
		}
		return { activePruned, blocked, tombstonesPruned };
	};

	const reserveActiveCapacity = (nowMs: number): boolean => {
		pruneAt(nowMs);
		if (activeEntries.size < activeCapacity) {
			return true;
		}
		let oldestEntry: ActiveSemanticEntry | undefined;
		for (const entry of activeEntries.values()) {
			if (oldestEntry === undefined || entry.order < oldestEntry.order) {
				oldestEntry = entry;
			}
		}
		return oldestEntry !== undefined && moveActiveEntryToTombstone(oldestEntry, nowMs);
	};

	return {
		async executeMutating(executeOptions: {
			readonly handler: () => Promise<unknown>;
			readonly identity: GatewaySemanticOperationIdentity;
			readonly payload: GatewaySemanticJsonValue;
		}): Promise<GatewaySemanticLedgerDecision<unknown>> {
			const nowMs = options.nowMs();
			if (!gatewaysEqual(executeOptions.identity.gateway, options.gateway)) {
				return { kind: 'gateway_mismatch' };
			}
			if (executeOptions.identity.validUntilMs > nowMs + activeWindowMs) {
				return { kind: 'operation_window_invalid' };
			}
			pruneExpiredTombstones(nowMs);
			const payloadDigest = canonicalGatewaySemanticPayloadDigest(executeOptions.payload);
			const correlationKey = correlationKeyForIdentity(executeOptions.identity);
			const meaningKey = meaningKeyForIdentity({
				identity: executeOptions.identity,
				payloadDigest,
			});
			const tombstone = tombstones.get(correlationKey);
			if (tombstone !== undefined) {
				return tombstone.meaningKey === meaningKey
					? { kind: 'unknown_side_effect' }
					: { kind: 'idempotency_collision' };
			}
			const activeEntry = activeEntries.get(correlationKey);
			if (activeEntry !== undefined) {
				if (activeEntry.meaningKey !== meaningKey) {
					return { kind: 'idempotency_collision' };
				}
				if (activeEntry.deadlineMs <= nowMs) {
					moveActiveEntryToTombstone(activeEntry, nowMs);
					return { kind: 'unknown_side_effect' };
				}
				if (activeEntry.status === 'unknown_side_effect') {
					return { kind: 'unknown_side_effect' };
				}
				return activeEntry.promise;
			}
			if (executeOptions.identity.validUntilMs <= nowMs) {
				return { kind: 'operation_expired' };
			}
			if (!reserveActiveCapacity(nowMs)) {
				return { kind: 'capacity_exhausted' };
			}

			const entry: ActiveSemanticEntry = {
				correlationKey,
				deadlineMs: Math.min(executeOptions.identity.validUntilMs, nowMs + activeWindowMs),
				meaningKey,
				order: nextOrder,
				promise: Promise.resolve({ kind: 'unknown_side_effect' }),
				status: 'pending',
			};
			nextOrder += 1;
			activeEntries.set(correlationKey, entry);
			entry.promise = (async (): Promise<GatewaySemanticLedgerDecision<unknown>> => {
				try {
					const value = await executeOptions.handler();
					if (activeEntries.get(correlationKey) !== entry || entry.status !== 'pending') {
						return { kind: 'unknown_side_effect' };
					}
					const completedAtMs = options.nowMs();
					if (entry.deadlineMs <= completedAtMs) {
						entry.status = 'unknown_side_effect';
						moveActiveEntryToTombstone(entry, completedAtMs);
						return { kind: 'unknown_side_effect' };
					}
					entry.status = 'completed';
					return { kind: 'completed', value };
				} catch {
					if (activeEntries.get(correlationKey) === entry) {
						entry.status = 'unknown_side_effect';
						moveActiveEntryToTombstone(entry, options.nowMs());
					}
					return { kind: 'unknown_side_effect' };
				}
			})();
			return entry.promise;
		},
		prune(): GatewaySemanticPruneResult {
			return pruneAt(options.nowMs());
		},
		snapshot(): GatewaySemanticLedgerSnapshot {
			return {
				activeCount: activeEntries.size,
				gateway: options.gateway,
				tombstoneCount: tombstones.size,
			};
		},
	};
}
