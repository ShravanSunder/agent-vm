import { describe, expect, it, vi } from 'vitest';

import type { GatewayEpochIdentity } from '../vm-ownership/vm-ownership-contracts.js';
import {
	GATEWAY_SEMANTIC_ACTIVE_WINDOW_MS,
	GATEWAY_SEMANTIC_ACTIVE_CAPACITY,
	GATEWAY_SEMANTIC_TOMBSTONE_CAPACITY,
	GATEWAY_SEMANTIC_TOMBSTONE_TTL_MS,
	canonicalGatewaySemanticOperationId,
	canonicalGatewaySemanticPayloadDigest,
	createGatewaySemanticResultLedger,
	type GatewaySemanticEpoch,
	type GatewaySemanticExecutionProof,
	type GatewaySemanticOperationIdentity,
} from './gateway-semantic-result-ledger.js';

const gatewayA = {
	bootId: 'gateway-boot-a',
	controllerEpoch: 'controller-epoch-a',
	gatewayEpochId: 'gateway-epoch-a',
	gatewayVmId: 'gateway-vm-a',
	generationId: 'gateway-generation-a',
	zoneId: 'zone-a',
} as const satisfies GatewayEpochIdentity;

function leaseOperation(options?: {
	readonly gateway?: GatewaySemanticEpoch;
	readonly idempotencyKey?: string;
	readonly principal?: string;
}): GatewaySemanticOperationIdentity {
	return {
		commandId: 'command-a',
		gateway: options?.gateway ?? gatewayA,
		idempotencyKey: options?.idempotencyKey ?? 'idempotency-a',
		operation: 'lease_reacquire',
		profile: {
			compatibilityId: 'compatibility-a',
			currentLeafTargetId: 'leaf-a',
			kind: 'lease_authority',
			stablePrincipal: options?.principal ?? 'zone-a:agent-a',
		},
		target: 'lease-a',
		validUntilMs: 600_000,
	};
}

describe('Gateway semantic canonical payload digest', () => {
	it('freezes the per-zone active and unknown-side-effect bounds', () => {
		expect(GATEWAY_SEMANTIC_ACTIVE_CAPACITY).toBe(2_048);
		expect(GATEWAY_SEMANTIC_ACTIVE_WINDOW_MS).toBe(10 * 60 * 1_000);
		expect(GATEWAY_SEMANTIC_TOMBSTONE_CAPACITY).toBe(4_096);
		expect(GATEWAY_SEMANTIC_TOMBSTONE_TTL_MS).toBe(60 * 60 * 1_000);
	});

	it('uses versioned canonical JSON independent of object insertion order', () => {
		const first = canonicalGatewaySemanticPayloadDigest({
			nested: { second: 2, first: 1 },
			values: [true, null, 'value'],
		});
		const reordered = canonicalGatewaySemanticPayloadDigest({
			values: [true, null, 'value'],
			nested: { first: 1, second: 2 },
		});

		expect(first).toEqual(reordered);
		expect(first).toMatchObject({ algorithm: 'sha256', canonicalVersion: 1 });
		expect(first.digest).toMatch(/^[a-f0-9]{64}$/u);
		expect(canonicalGatewaySemanticPayloadDigest({ values: ['value', null, true] })).not.toEqual(
			first,
		);
	});
});

describe('Gateway semantic result ledger', () => {
	it('passes an exact cloned execution proof with a payload-independent semantic operation id', async () => {
		const firstLedger = createGatewaySemanticResultLedger({ gateway: gatewayA, nowMs: () => 0 });
		const secondLedger = createGatewaySemanticResultLedger({ gateway: gatewayA, nowMs: () => 0 });
		const firstIdentity = leaseOperation();
		const refreshedIdentity = {
			...firstIdentity,
			validUntilMs: firstIdentity.validUntilMs - 1,
		};
		let firstProof: GatewaySemanticExecutionProof | undefined;
		let refreshedProof: GatewaySemanticExecutionProof | undefined;

		await firstLedger.executeMutating({
			handler: async (proof) => {
				firstProof = proof;
				return 'first';
			},
			identity: firstIdentity,
			payload: { value: 1 },
		});
		await secondLedger.executeMutating({
			handler: async (proof) => {
				refreshedProof = proof;
				return 'second';
			},
			identity: refreshedIdentity,
			payload: { value: 2 },
		});

		expect(firstProof).toBeDefined();
		expect(firstProof?.identity).toEqual(firstIdentity);
		expect(firstProof?.identity).not.toBe(firstIdentity);
		expect(firstProof?.identity.profile).not.toBe(firstIdentity.profile);
		expect(refreshedProof?.identity).toEqual(refreshedIdentity);
		expect(refreshedProof?.semanticOperationId).toBe(firstProof?.semanticOperationId);
		expect(refreshedProof?.operationPayloadDigest).not.toEqual(firstProof?.operationPayloadDigest);
		expect(firstProof?.semanticOperationId).toMatch(/^[a-f0-9]{64}$/u);
	});

	it('shares an exact pending/completed retry and rejects changed meaning without redispatch', async () => {
		const ledger = createGatewaySemanticResultLedger({ gateway: gatewayA, nowMs: () => 0 });
		let resolveHandler: ((value: string) => void) | undefined;
		const handler = vi.fn(
			async () =>
				await new Promise<string>((resolve) => {
					resolveHandler = resolve;
				}),
		);
		const identity = leaseOperation();

		const first = ledger.executeMutating({ handler, identity, payload: { value: 1 } });
		const retry = ledger.executeMutating({ handler, identity, payload: { value: 1 } });
		const collision = await ledger.executeMutating({
			handler,
			identity,
			payload: { value: 2 },
		});

		expect(collision).toEqual({ kind: 'idempotency_collision' });
		expect(handler).toHaveBeenCalledOnce();
		resolveHandler?.('completed-a');
		await expect(first).resolves.toEqual({ kind: 'completed', value: 'completed-a' });
		await expect(retry).resolves.toEqual({ kind: 'completed', value: 'completed-a' });
		await expect(
			ledger.executeMutating({ handler, identity, payload: { value: 1 } }),
		).resolves.toEqual({ kind: 'completed', value: 'completed-a' });
		expect(handler).toHaveBeenCalledOnce();
	});

	it('treats a refreshed admission deadline as the same semantic retry', async () => {
		const ledger = createGatewaySemanticResultLedger({ gateway: gatewayA, nowMs: () => 0 });
		const handler = vi.fn(async () => 'completed-a');
		const identity = leaseOperation();

		await expect(ledger.executeMutating({ handler, identity, payload: null })).resolves.toEqual({
			kind: 'completed',
			value: 'completed-a',
		});
		await expect(
			ledger.executeMutating({
				handler,
				identity: { ...identity, validUntilMs: identity.validUntilMs - 1 },
				payload: null,
			}),
		).resolves.toEqual({ kind: 'completed', value: 'completed-a' });
		expect(handler).toHaveBeenCalledOnce();
	});

	it('keeps Gateway epochs and stable principals in separate semantic scopes', async () => {
		const gatewayB = { ...gatewayA, gatewayEpochId: 'gateway-epoch-b' };
		const handler = vi.fn(async () => 'completed');
		const ledgerA = createGatewaySemanticResultLedger({ gateway: gatewayA, nowMs: () => 0 });
		const ledgerB = createGatewaySemanticResultLedger({ gateway: gatewayB, nowMs: () => 0 });

		await expect(
			ledgerA.executeMutating({ handler, identity: leaseOperation(), payload: null }),
		).resolves.toMatchObject({ kind: 'completed' });
		await expect(
			ledgerA.executeMutating({
				handler,
				identity: leaseOperation({ principal: 'zone-a:agent-b' }),
				payload: null,
			}),
		).resolves.toMatchObject({ kind: 'completed' });
		await expect(
			ledgerB.executeMutating({
				handler,
				identity: leaseOperation({ gateway: gatewayB }),
				payload: null,
			}),
		).resolves.toMatchObject({ kind: 'completed' });
		await expect(
			ledgerA.executeMutating({
				handler,
				identity: leaseOperation({ gateway: gatewayB }),
				payload: null,
			}),
		).resolves.toEqual({ kind: 'gateway_mismatch' });

		expect(handler).toHaveBeenCalledTimes(3);
	});

	it('refuses a semantically identical operation from another controller epoch', async () => {
		const handler = vi.fn(async () => 'completed');
		const ledger = createGatewaySemanticResultLedger({ gateway: gatewayA, nowMs: () => 0 });
		const otherControllerGateway = { ...gatewayA, controllerEpoch: 'controller-epoch-b' };

		await expect(
			ledger.executeMutating({
				handler,
				identity: leaseOperation({ gateway: otherControllerGateway }),
				payload: null,
			}),
		).resolves.toEqual({ kind: 'gateway_mismatch' });
		expect(handler).not.toHaveBeenCalled();
	});

	it('does not share a semantic operation or result across Gateway boot identities', async () => {
		const handler = vi.fn(async () => 'completed');
		const ledger = createGatewaySemanticResultLedger({ gateway: gatewayA, nowMs: () => 0 });
		const otherBootGateway = { ...gatewayA, bootId: 'gateway-boot-b' };
		const exactGatewayIdentity = leaseOperation();
		const otherBootIdentity = leaseOperation({ gateway: otherBootGateway });

		expect(canonicalGatewaySemanticOperationId(otherBootIdentity)).not.toBe(
			canonicalGatewaySemanticOperationId(exactGatewayIdentity),
		);
		await expect(
			ledger.executeMutating({ handler, identity: exactGatewayIdentity, payload: null }),
		).resolves.toMatchObject({ kind: 'completed' });
		await expect(
			ledger.executeMutating({ handler, identity: otherBootIdentity, payload: null }),
		).resolves.toEqual({ kind: 'gateway_mismatch' });
		expect(handler).toHaveBeenCalledOnce();
	});

	it('does not share a semantic operation or result across Gateway generations', async () => {
		const handler = vi.fn(async () => 'completed');
		const ledger = createGatewaySemanticResultLedger({ gateway: gatewayA, nowMs: () => 0 });
		const otherGenerationGateway = { ...gatewayA, generationId: 'gateway-generation-b' };
		const exactGatewayIdentity = leaseOperation();
		const otherGenerationIdentity = leaseOperation({ gateway: otherGenerationGateway });

		expect(canonicalGatewaySemanticOperationId(otherGenerationIdentity)).not.toBe(
			canonicalGatewaySemanticOperationId(exactGatewayIdentity),
		);
		await expect(
			ledger.executeMutating({ handler, identity: exactGatewayIdentity, payload: null }),
		).resolves.toMatchObject({ kind: 'completed' });
		await expect(
			ledger.executeMutating({ handler, identity: otherGenerationIdentity, payload: null }),
		).resolves.toEqual({ kind: 'gateway_mismatch' });
		expect(handler).toHaveBeenCalledOnce();
	});

	it('turns pending and completed cap eviction into no-replay unknown-side-effect tombstones', async () => {
		const ledger = createGatewaySemanticResultLedger({
			activeCapacity: 1,
			gateway: gatewayA,
			nowMs: () => 0,
			tombstoneCapacity: 4,
		});
		let resolvePending: ((value: string) => void) | undefined;
		const pendingHandler = vi.fn(
			async () =>
				await new Promise<string>((resolve) => {
					resolvePending = resolve;
				}),
		);
		const pendingIdentity = leaseOperation({ idempotencyKey: 'pending' });
		const completedIdentity = leaseOperation({ idempotencyKey: 'completed' });
		const replacementIdentity = leaseOperation({ idempotencyKey: 'replacement' });
		const pending = ledger.executeMutating({
			handler: pendingHandler,
			identity: pendingIdentity,
			payload: null,
		});

		await expect(
			ledger.executeMutating({
				handler: async () => 'completed',
				identity: completedIdentity,
				payload: null,
			}),
		).resolves.toMatchObject({ kind: 'completed' });
		await expect(
			ledger.executeMutating({
				handler: async () => 'replacement',
				identity: replacementIdentity,
				payload: null,
			}),
		).resolves.toMatchObject({ kind: 'completed' });

		resolvePending?.('late-pending-result');
		await expect(pending).resolves.toEqual({ kind: 'unknown_side_effect' });
		await expect(
			ledger.executeMutating({
				handler: pendingHandler,
				identity: pendingIdentity,
				payload: null,
			}),
		).resolves.toEqual({ kind: 'unknown_side_effect' });
		await expect(
			ledger.executeMutating({
				handler: async () => 'must-not-run',
				identity: completedIdentity,
				payload: null,
			}),
		).resolves.toEqual({ kind: 'unknown_side_effect' });
		expect(pendingHandler).toHaveBeenCalledOnce();
	});

	it('turns a pending result that completes after its deadline into unknown side effect', async () => {
		let nowMs = 0;
		const ledger = createGatewaySemanticResultLedger({ gateway: gatewayA, nowMs: () => nowMs });
		let resolveHandler: ((value: string) => void) | undefined;
		const handler = vi.fn(
			async () =>
				await new Promise<string>((resolve) => {
					resolveHandler = resolve;
				}),
		);
		const identity = leaseOperation();
		const pending = ledger.executeMutating({ handler, identity, payload: null });

		nowMs = GATEWAY_SEMANTIC_ACTIVE_WINDOW_MS + 1;
		resolveHandler?.('late-result');

		await expect(pending).resolves.toEqual({ kind: 'unknown_side_effect' });
		await expect(ledger.executeMutating({ handler, identity, payload: null })).resolves.toEqual({
			kind: 'unknown_side_effect',
		});
		expect(handler).toHaveBeenCalledOnce();
	});

	it('fails closed before dispatch when active eviction cannot reserve a tombstone', async () => {
		const ledger = createGatewaySemanticResultLedger({
			activeCapacity: 1,
			gateway: gatewayA,
			nowMs: () => 0,
			tombstoneCapacity: 1,
		});
		await ledger.executeMutating({
			handler: async () => 'first',
			identity: leaseOperation({ idempotencyKey: 'first' }),
			payload: null,
		});
		await ledger.executeMutating({
			handler: async () => 'second',
			identity: leaseOperation({ idempotencyKey: 'second' }),
			payload: null,
		});
		const blockedHandler = vi.fn(async () => 'must-not-run');

		await expect(
			ledger.executeMutating({
				handler: blockedHandler,
				identity: leaseOperation({ idempotencyKey: 'third' }),
				payload: null,
			}),
		).resolves.toEqual({ kind: 'capacity_exhausted' });
		expect(blockedHandler).not.toHaveBeenCalled();
	});

	it('turns an uncertain handler failure into an exact no-replay tombstone', async () => {
		const ledger = createGatewaySemanticResultLedger({ gateway: gatewayA, nowMs: () => 0 });
		const identity = leaseOperation();
		const handler = vi.fn(async () => {
			throw new Error('untrusted handler detail');
		});

		await expect(
			ledger.executeMutating({ handler, identity, payload: { value: 1 } }),
		).resolves.toEqual({ kind: 'unknown_side_effect' });
		await expect(
			ledger.executeMutating({ handler, identity, payload: { value: 1 } }),
		).resolves.toEqual({ kind: 'unknown_side_effect' });
		await expect(
			ledger.executeMutating({ handler, identity, payload: { value: 2 } }),
		).resolves.toEqual({ kind: 'idempotency_collision' });
		expect(handler).toHaveBeenCalledOnce();
	});

	it('explicitly prunes expired active entries to longer-lived tombstones with an injected clock', async () => {
		let nowMs = 0;
		const ledger = createGatewaySemanticResultLedger({ gateway: gatewayA, nowMs: () => nowMs });
		const identity = leaseOperation();
		await ledger.executeMutating({ handler: async () => 'completed', identity, payload: null });

		nowMs = GATEWAY_SEMANTIC_ACTIVE_WINDOW_MS + 1;
		expect(ledger.prune()).toEqual({ activePruned: 1, tombstonesPruned: 0, blocked: 0 });
		await expect(
			ledger.executeMutating({ handler: async () => 'must-not-run', identity, payload: null }),
		).resolves.toEqual({ kind: 'unknown_side_effect' });
		expect(ledger.snapshot()).toMatchObject({ activeCount: 0, tombstoneCount: 1 });

		nowMs += GATEWAY_SEMANTIC_TOMBSTONE_TTL_MS + 1;
		expect(ledger.prune()).toEqual({ activePruned: 0, tombstonesPruned: 1, blocked: 0 });
		expect(ledger.snapshot()).toMatchObject({ activeCount: 0, tombstoneCount: 0 });
		const expiredHandler = vi.fn(async () => 'must-not-run');
		await expect(
			ledger.executeMutating({ handler: expiredHandler, identity, payload: null }),
		).resolves.toEqual({ kind: 'operation_expired' });
		expect(expiredHandler).not.toHaveBeenCalled();
	});

	it('binds active-use and session-safety profiles to exact process/session generations', async () => {
		const ledger = createGatewaySemanticResultLedger({ gateway: gatewayA, nowMs: () => 0 });
		const activeUse = {
			...leaseOperation(),
			operation: 'lease_use_start',
			profile: {
				kind: 'active_use',
				leafGeneration: 'leaf-generation-a',
				processEpoch: 'process-a',
				stablePrincipal: 'zone-a:agent-a',
				useId: 'use-a',
			},
		} as const satisfies GatewaySemanticOperationIdentity;
		const sessionSafety = {
			...leaseOperation({ idempotencyKey: 'session-safety' }),
			operation: 'control_fence',
			profile: {
				attachmentGeneration: 4,
				kind: 'session_safety',
				processEpoch: 'process-a',
				sessionId: 'session-a',
			},
		} as const satisfies GatewaySemanticOperationIdentity;
		const handler = vi.fn(async () => 'completed');

		await ledger.executeMutating({ handler, identity: activeUse, payload: null });
		await expect(
			ledger.executeMutating({
				handler,
				identity: {
					...activeUse,
					profile: { ...activeUse.profile, processEpoch: 'process-b' },
				},
				payload: null,
			}),
		).resolves.toEqual({ kind: 'idempotency_collision' });
		await ledger.executeMutating({ handler, identity: sessionSafety, payload: null });
		await expect(
			ledger.executeMutating({
				handler,
				identity: {
					...sessionSafety,
					profile: { ...sessionSafety.profile, attachmentGeneration: 5 },
				},
				payload: null,
			}),
		).resolves.toEqual({ kind: 'idempotency_collision' });
		expect(handler).toHaveBeenCalledTimes(2);
	});
});
