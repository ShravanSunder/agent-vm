import { describe, expect, it } from 'vitest';

import {
	createAgentLeaseOperationLock,
	type AgentLeaseIdentity,
} from './agent-lease-operation-lock.js';

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

const TEST_AGENT_IDENTITY = {
	agentId: 'main',
	zoneId: 'shravan',
} satisfies AgentLeaseIdentity;

describe('createAgentLeaseOperationLock', () => {
	it('serializes same-agent operations in FIFO order without overlap', async () => {
		// Arrange
		const operationLock = createAgentLeaseOperationLock();
		const events: string[] = [];
		const firstStarted = createDeferred<void>();
		const releaseFirst = createDeferred<void>();
		const secondStarted = createDeferred<void>();
		const releaseSecond = createDeferred<void>();
		const thirdStarted = createDeferred<void>();
		const releaseThird = createDeferred<void>();
		let activeOperationCount = 0;
		let maximumActiveOperationCount = 0;
		const runOperation = async (
			label: string,
			started: Deferred<void>,
			release: Deferred<void>,
		): Promise<string> =>
			await operationLock.runExclusive(TEST_AGENT_IDENTITY, async () => {
				activeOperationCount += 1;
				maximumActiveOperationCount = Math.max(maximumActiveOperationCount, activeOperationCount);
				events.push(`${label}:start`);
				started.resolve();
				await release.promise;
				events.push(`${label}:end`);
				activeOperationCount -= 1;
				return label;
			});

		// Act
		const firstOperation = runOperation('first', firstStarted, releaseFirst);
		const secondOperation = runOperation('second', secondStarted, releaseSecond);
		const thirdOperation = runOperation('third', thirdStarted, releaseThird);
		await firstStarted.promise;

		// Assert
		expect(events).toEqual(['first:start']);
		expect(activeOperationCount).toBe(1);

		// Act
		releaseFirst.resolve();
		await secondStarted.promise;

		// Assert
		expect(events).toEqual(['first:start', 'first:end', 'second:start']);
		expect(activeOperationCount).toBe(1);

		// Act
		releaseSecond.resolve();
		await thirdStarted.promise;

		// Assert
		expect(events).toEqual([
			'first:start',
			'first:end',
			'second:start',
			'second:end',
			'third:start',
		]);
		expect(activeOperationCount).toBe(1);

		// Act
		releaseThird.resolve();

		// Assert
		await expect(Promise.all([firstOperation, secondOperation, thirdOperation])).resolves.toEqual([
			'first',
			'second',
			'third',
		]);
		expect(activeOperationCount).toBe(0);
		expect(maximumActiveOperationCount).toBe(1);
	});

	it('allows sibling agents and the same agent in sibling zones to proceed independently', async () => {
		// Arrange
		const operationLock = createAgentLeaseOperationLock();
		const blockedOperationStarted = createDeferred<void>();
		const releaseBlockedOperation = createDeferred<void>();
		const blockedOperation = operationLock.runExclusive(TEST_AGENT_IDENTITY, async () => {
			blockedOperationStarted.resolve();
			await releaseBlockedOperation.promise;
			return 'blocked-main';
		});
		await blockedOperationStarted.promise;

		// Act
		const independentResults = await Promise.all([
			operationLock.runExclusive(
				{ agentId: 'reviewer', zoneId: TEST_AGENT_IDENTITY.zoneId },
				async () => 'sibling-agent',
			),
			operationLock.runExclusive(
				{ agentId: TEST_AGENT_IDENTITY.agentId, zoneId: 'work' },
				async () => 'sibling-zone',
			),
		]);

		// Assert
		expect(independentResults).toEqual(['sibling-agent', 'sibling-zone']);

		// Act
		releaseBlockedOperation.resolve();

		// Assert
		await expect(blockedOperation).resolves.toBe('blocked-main');
	});

	it.each(['throw', 'reject'] as const)(
		'releases queued and future operations after the first operation fails by %s',
		async (failureMode) => {
			// Arrange
			const operationLock = createAgentLeaseOperationLock();
			const failure = new Error(`first operation ${failureMode}`);
			const firstOperationStarted = createDeferred<void>();
			const releaseFirstOperation = createDeferred<void>();
			const events: string[] = [];
			const firstOperation = operationLock.runExclusive(TEST_AGENT_IDENTITY, async () => {
				events.push('first:start');
				firstOperationStarted.resolve();
				await releaseFirstOperation.promise;
				if (failureMode === 'throw') {
					throw failure;
				}
				return await Promise.reject(failure);
			});
			const queuedFollower = operationLock.runExclusive(TEST_AGENT_IDENTITY, async () => {
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
			const futureOperation = operationLock.runExclusive(TEST_AGENT_IDENTITY, async () => 'future');

			// Assert
			await expect(futureOperation).resolves.toBe('future');
		},
	);
});
