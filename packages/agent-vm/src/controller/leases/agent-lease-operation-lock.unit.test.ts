import { describe, expect, it } from 'vitest';

import type { GatewayEpochIdentity } from '../vm-ownership/vm-ownership-contracts.js';
import { createAgentLeaseOperationLock } from './agent-lease-operation-lock.js';
import type { StableToolVmLeasePrincipal } from './tool-vm-lease-authority-contracts.js';

interface Deferred<TValue> {
	readonly promise: Promise<TValue>;
	resolve(value: TValue): void;
}

function createDeferred<TValue>(): Deferred<TValue> {
	let resolvePromise: ((value: TValue) => void) | undefined;
	const promise = new Promise<TValue>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve(value: TValue): void {
			resolvePromise?.(value);
		},
	};
}

const GATEWAY_ONE = {
	bootId: 'gateway-boot-1',
	controllerEpoch: 'controller-epoch-1',
	gatewayEpochId: 'gateway-epoch-1',
	gatewayVmId: 'gateway-vm-1',
	generationId: 'gateway-generation-1',
	zoneId: 'shravan',
} satisfies GatewayEpochIdentity;

const GATEWAY_TWO = {
	...GATEWAY_ONE,
	bootId: 'gateway-boot-2',
	gatewayEpochId: 'gateway-epoch-2',
	gatewayVmId: 'gateway-vm-2',
	generationId: 'gateway-generation-2',
} satisfies GatewayEpochIdentity;

const PRINCIPAL_REVISION_A = {
	agentId: 'main',
	frameworkIdentity: { kind: 'hermes', profileName: 'main' },
	profileAssignmentRevision: 'assignment-main-a',
	toolPortalProfileId: 'standard',
} satisfies StableToolVmLeasePrincipal;

const PRINCIPAL_REVISION_B = {
	...PRINCIPAL_REVISION_A,
	profileAssignmentRevision: 'assignment-main-b',
} satisfies StableToolVmLeasePrincipal;

function currentLeafTransitionIdentity(
	gateway: GatewayEpochIdentity,
	principal: StableToolVmLeasePrincipal,
): { readonly agentId: string; readonly gateway: GatewayEpochIdentity } {
	return { agentId: principal.agentId, gateway };
}

describe('createAgentLeaseOperationLock', () => {
	it('serializes profile-assignment revisions for one Gateway agent in FIFO order', async () => {
		// Arrange
		const operationLock = createAgentLeaseOperationLock();
		const events: string[] = [];
		const firstStarted = createDeferred<void>();
		const releaseFirst = createDeferred<void>();
		const secondStarted = createDeferred<void>();
		const runOperation = async (
			label: string,
			principal: StableToolVmLeasePrincipal,
			started: Deferred<void>,
			release?: Deferred<void>,
		): Promise<string> =>
			await operationLock.runExclusive(
				currentLeafTransitionIdentity({ ...GATEWAY_ONE }, principal),
				async () => {
					events.push(`${label}:start`);
					started.resolve();
					await release?.promise;
					events.push(`${label}:end`);
					return label;
				},
			);

		// Act
		const firstOperation = runOperation(
			'revision-a',
			PRINCIPAL_REVISION_A,
			firstStarted,
			releaseFirst,
		);
		const secondOperation = runOperation('revision-b', PRINCIPAL_REVISION_B, secondStarted);
		await firstStarted.promise;
		await Promise.resolve();
		await Promise.resolve();

		// Assert
		expect(events).toEqual(['revision-a:start']);

		// Act
		releaseFirst.resolve();
		await secondStarted.promise;

		// Assert
		expect(events).toEqual(['revision-a:start', 'revision-a:end', 'revision-b:start']);
		await expect(Promise.all([firstOperation, secondOperation])).resolves.toEqual([
			'revision-a',
			'revision-b',
		]);
	});

	it('allows different agents in one Gateway and one agent in different Gateway epochs to proceed independently', async () => {
		// Arrange
		const operationLock = createAgentLeaseOperationLock();
		const blockedOperationStarted = createDeferred<void>();
		const releaseBlockedOperation = createDeferred<void>();
		const independentStarts: string[] = [];
		const blockedOperation = operationLock.runExclusive(
			currentLeafTransitionIdentity(GATEWAY_ONE, PRINCIPAL_REVISION_A),
			async () => {
				blockedOperationStarted.resolve();
				await releaseBlockedOperation.promise;
				return 'blocked-main';
			},
		);
		await blockedOperationStarted.promise;

		// Act
		const independentOperations = [
			operationLock.runExclusive({ agentId: 'reviewer', gateway: GATEWAY_ONE }, async () => {
				independentStarts.push('sibling-agent');
				return 'sibling-agent';
			}),
			operationLock.runExclusive(
				currentLeafTransitionIdentity(GATEWAY_TWO, PRINCIPAL_REVISION_A),
				async () => {
					independentStarts.push('successor-gateway');
					return 'successor-gateway';
				},
			),
		] as const;
		await Promise.resolve();
		await Promise.resolve();

		// Assert
		try {
			expect(independentStarts).toEqual(['sibling-agent', 'successor-gateway']);
		} finally {
			releaseBlockedOperation.resolve();
			await Promise.allSettled([blockedOperation, ...independentOperations]);
		}

		// Assert
		await expect(Promise.all(independentOperations)).resolves.toEqual([
			'sibling-agent',
			'successor-gateway',
		]);
		await expect(blockedOperation).resolves.toBe('blocked-main');
	});

	it.each(['throw', 'reject'] as const)(
		'releases queued and future operations after the first operation fails by %s',
		async (failureMode) => {
			// Arrange
			const operationLock = createAgentLeaseOperationLock();
			const identity = currentLeafTransitionIdentity(GATEWAY_ONE, PRINCIPAL_REVISION_A);
			const failure = new Error(`first operation ${failureMode}`);
			const firstOperationStarted = createDeferred<void>();
			const releaseFirstOperation = createDeferred<void>();
			const events: string[] = [];
			const firstOperation = operationLock.runExclusive(identity, async () => {
				events.push('first:start');
				firstOperationStarted.resolve();
				await releaseFirstOperation.promise;
				if (failureMode === 'throw') {
					throw failure;
				}
				return await Promise.reject(failure);
			});
			const queuedFollower = operationLock.runExclusive(identity, async () => {
				events.push('follower:start');
				return 'follower';
			});
			await firstOperationStarted.promise;

			// Act
			releaseFirstOperation.resolve();

			// Assert
			await expect(firstOperation).rejects.toBe(failure);
			await expect(queuedFollower).resolves.toBe('follower');
			expect(events).toEqual(['first:start', 'follower:start']);

			// Act
			const futureOperation = operationLock.runExclusive(identity, async () => 'future');

			// Assert
			await expect(futureOperation).resolves.toBe('future');
		},
	);
});
