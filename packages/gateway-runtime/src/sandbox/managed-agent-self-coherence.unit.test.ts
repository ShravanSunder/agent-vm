import { describe, expect, it, vi } from 'vitest';

import {
	ManagedAgentSelfCoherenceFatalError,
	createManagedAgentSelfContentDigest,
	createManagedAgentSelfCoherenceCoordinator,
	type ManagedAgentSelfReadbackAttempt,
	type ManagedAgentSelfRevisionManifest,
} from './managed-agent-self-coherence.js';

const digestA = `sha256:${'a'.repeat(64)}`;
const digestB = `sha256:${'b'.repeat(64)}`;

function manifest(revision: number, contentDigest = digestA): ManagedAgentSelfRevisionManifest {
	return {
		contentDigest,
		profileAssignmentRevision: 'assignment-v1',
		revision,
	};
}

function resolvedReadbackAttempt(
	value: ManagedAgentSelfRevisionManifest | null,
): ManagedAgentSelfReadbackAttempt {
	return { dispose: vi.fn(), result: Promise.resolve(value) };
}

function createCoordinatorOptions(): Parameters<
	typeof createManagedAgentSelfCoherenceCoordinator
>[0] {
	return {
		maxReadbackAttempts: 2,
		profileAssignmentRevision: 'assignment-v1',
		readbackAttemptTimeoutMs: 100,
		startGatewayManifestReadback: vi.fn(() => resolvedReadbackAttempt(manifest(1))),
		startToolVmManifestReadback: vi.fn(() => resolvedReadbackAttempt(manifest(1))),
		writeManifest: vi.fn(async () => {}),
	};
}

describe('managed agent self coherence', () => {
	it('creates an order-independent bounded content digest without framing collisions', () => {
		const firstDigest = createManagedAgentSelfContentDigest({
			entries: [
				{ content: Buffer.from('bc'), relativePath: 'a' },
				{ content: Buffer.from('d'), relativePath: 'skills/c' },
			],
			maximumBytes: 100,
			maximumEntries: 2,
		});
		const reorderedDigest = createManagedAgentSelfContentDigest({
			entries: [
				{ content: Buffer.from('d'), relativePath: 'skills/c' },
				{ content: Buffer.from('bc'), relativePath: 'a' },
			],
			maximumBytes: 100,
			maximumEntries: 2,
		});
		const differentlyFramedDigest = createManagedAgentSelfContentDigest({
			entries: [{ content: Buffer.from('abc'), relativePath: 'skills/c' }],
			maximumBytes: 100,
			maximumEntries: 2,
		});

		expect(firstDigest).toBe(reorderedDigest);
		expect(firstDigest).not.toBe(differentlyFramedDigest);
		expect(firstDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
	});

	it('orders non-ASCII paths by UTF-8 bytes rather than host locale', () => {
		const digest = createManagedAgentSelfContentDigest({
			entries: [
				{ content: Buffer.from('umlaut'), relativePath: 'ä' },
				{ content: Buffer.from('z'), relativePath: 'z' },
			],
			maximumBytes: 100,
			maximumEntries: 2,
		});

		expect(digest).toBe('sha256:194b8bfed76e4dd7c0b92a2bd102b4116fb082ce7c3e3d438fd83a4ded8c4f46');
	});

	it('rejects digest traversal, duplicate paths, and byte/entry overflow', () => {
		expect(() =>
			createManagedAgentSelfContentDigest({
				entries: [{ content: Buffer.from('x'), relativePath: '../secret' }],
				maximumBytes: 100,
				maximumEntries: 1,
			}),
		).toThrow(/canonical and relative/u);
		expect(() =>
			createManagedAgentSelfContentDigest({
				entries: [
					{ content: Buffer.from('a'), relativePath: 'memory.md' },
					{ content: Buffer.from('b'), relativePath: 'memory.md' },
				],
				maximumBytes: 100,
				maximumEntries: 2,
			}),
		).toThrow(/duplicate/u);
		expect(() =>
			createManagedAgentSelfContentDigest({
				entries: [{ content: Buffer.from('overflow'), relativePath: 'memory.md' }],
				maximumBytes: 1,
				maximumEntries: 1,
			}),
		).toThrow(/byte count/u);
		expect(() =>
			createManagedAgentSelfContentDigest({
				entries: [
					{ content: Buffer.from('a'), relativePath: 'a' },
					{ content: Buffer.from('b'), relativePath: 'b' },
				],
				maximumBytes: 100,
				maximumEntries: 1,
			}),
		).toThrow(/entry count/u);
		expect(() =>
			createManagedAgentSelfContentDigest({
				entries: [
					{
						content: Buffer.from('{}'),
						relativePath: '.agent-vm-self-revision.json',
					},
				],
				maximumBytes: 100,
				maximumEntries: 1,
			}),
		).toThrow(/canonical and relative/u);
	});

	it('writes the bound manifest before positive opposite-view readback', async () => {
		const options = createCoordinatorOptions();
		const coordinator = createManagedAgentSelfCoherenceCoordinator(options);
		const mutation = coordinator.beginMutation({ origin: 'tool-vm' });

		await expect(
			mutation.complete({ contentDigest: digestA, flushCompleted: true, handlesClosed: true }),
		).resolves.toEqual(manifest(1));
		expect(options.writeManifest).toHaveBeenCalledWith(manifest(1));
		expect(options.startGatewayManifestReadback).toHaveBeenCalledWith(1, expect.any(AbortSignal));
		expect(coordinator.state).toEqual({ kind: 'available', revision: 1 });
	});

	it('requires positive Tool VM readback after a Gateway mutation', async () => {
		const options = createCoordinatorOptions();
		const coordinator = createManagedAgentSelfCoherenceCoordinator(options);

		await coordinator.beginMutation({ origin: 'gateway' }).complete({
			contentDigest: digestA,
			flushCompleted: true,
			handlesClosed: true,
		});

		expect(options.startToolVmManifestReadback).toHaveBeenCalledWith(1, expect.any(AbortSignal));
	});

	it('denies concurrent writers and caller-selected assignment revisions', async () => {
		const options = createCoordinatorOptions();
		const coordinator = createManagedAgentSelfCoherenceCoordinator(options);
		const mutation = coordinator.beginMutation({ origin: 'tool-vm' });

		expect(() => coordinator.beginMutation({ origin: 'gateway' })).toThrow(
			/mutation already active/u,
		);
		await mutation.complete({
			contentDigest: digestA,
			flushCompleted: true,
			handlesClosed: true,
		});

		const freshOptions = createCoordinatorOptions();
		const freshCoordinator = createManagedAgentSelfCoherenceCoordinator(freshOptions);
		expect(() =>
			freshCoordinator.beginMutation({
				expectedProfileAssignmentRevision: 'wrong-first-revision',
				origin: 'tool-vm',
			} as unknown as Parameters<typeof freshCoordinator.beginMutation>[0]),
		).toThrow(/unsupported mutation option/u);
		expect(freshCoordinator.activeReadbackAttemptCount).toBe(0);
		expect(freshOptions.writeManifest).not.toHaveBeenCalled();
		expect(freshOptions.startGatewayManifestReadback).not.toHaveBeenCalled();
	});

	it('makes every post-mutation proof failure fatal before readback or reuse', async () => {
		const failureCases = [
			{
				completion: { contentDigest: digestA, flushCompleted: false, handlesClosed: true },
				label: 'flush',
			},
			{
				completion: { contentDigest: digestA, flushCompleted: true, handlesClosed: false },
				label: 'handles',
			},
			{
				completion: { contentDigest: 'not-a-digest', flushCompleted: true, handlesClosed: true },
				label: 'digest',
			},
		] as const;
		for (const failureCase of failureCases) {
			const options = createCoordinatorOptions();
			const coordinator = createManagedAgentSelfCoherenceCoordinator(options);
			// oxlint-disable-next-line no-await-in-loop -- each proof failure owns an independent fatal-state assertion.
			await expect(
				coordinator.beginMutation({ origin: 'tool-vm' }).complete(failureCase.completion),
			).rejects.toBeInstanceOf(ManagedAgentSelfCoherenceFatalError);
			expect(coordinator.state, failureCase.label).toEqual({ kind: 'fatal' });
			expect(options.startGatewayManifestReadback).not.toHaveBeenCalled();
			expect(() => coordinator.beginMutation({ origin: 'tool-vm' })).toThrow(
				ManagedAgentSelfCoherenceFatalError,
			);
		}

		const writerFailureOptions = {
			...createCoordinatorOptions(),
			writeManifest: vi.fn(async () => {
				throw new Error('manifest write failed');
			}),
		};
		const writerFailureCoordinator =
			createManagedAgentSelfCoherenceCoordinator(writerFailureOptions);
		await expect(
			writerFailureCoordinator.beginMutation({ origin: 'gateway' }).complete({
				contentDigest: digestA,
				flushCompleted: true,
				handlesClosed: true,
			}),
		).rejects.toBeInstanceOf(ManagedAgentSelfCoherenceFatalError);
		expect(writerFailureCoordinator.state).toEqual({ kind: 'fatal' });
		expect(writerFailureOptions.startToolVmManifestReadback).not.toHaveBeenCalled();
	});

	it('fails Gateway-fatally when readback is stale or withheld', async () => {
		for (const observedManifest of [manifest(1, digestB), null]) {
			const options = {
				...createCoordinatorOptions(),
				startGatewayManifestReadback: vi.fn(() => resolvedReadbackAttempt(observedManifest)),
			};
			const coordinator = createManagedAgentSelfCoherenceCoordinator(options);

			// oxlint-disable-next-line no-await-in-loop -- each readback failure owns an independent fatal-state assertion.
			await expect(
				coordinator.beginMutation({ origin: 'tool-vm' }).complete({
					contentDigest: digestA,
					flushCompleted: true,
					handlesClosed: true,
				}),
			).rejects.toBeInstanceOf(ManagedAgentSelfCoherenceFatalError);
			expect(coordinator.state).toEqual({ kind: 'fatal' });
			expect(coordinator.activeReadbackAttemptCount).toBe(0);
		}
	});

	it('disposes timed-out owned reads before retry and leaves zero active reads', async () => {
		vi.useFakeTimers();
		try {
			let activeReads = 0;
			let maximumConcurrentReads = 0;
			const observedAbortSignals: AbortSignal[] = [];
			const options = {
				...createCoordinatorOptions(),
				readbackAttemptTimeoutMs: 10,
				startGatewayManifestReadback: vi.fn((_revision, signal) => {
					activeReads += 1;
					maximumConcurrentReads = Math.max(maximumConcurrentReads, activeReads);
					observedAbortSignals.push(signal);
					let disposed = false;
					return {
						dispose(): void {
							if (!disposed) {
								disposed = true;
								activeReads -= 1;
							}
						},
						result: new Promise<ManagedAgentSelfRevisionManifest | null>(() => {}),
					};
				}),
			};
			const coordinator = createManagedAgentSelfCoherenceCoordinator(options);
			const completion = coordinator.beginMutation({ origin: 'tool-vm' }).complete({
				contentDigest: digestA,
				flushCompleted: true,
				handlesClosed: true,
			});
			const completionExpectation = expect(completion).rejects.toBeInstanceOf(
				ManagedAgentSelfCoherenceFatalError,
			);

			await vi.advanceTimersByTimeAsync(20);
			await completionExpectation;

			expect(maximumConcurrentReads).toBe(1);
			expect(activeReads).toBe(0);
			expect(coordinator.activeReadbackAttemptCount).toBe(0);
			expect(observedAbortSignals).toHaveLength(2);
			expect(observedAbortSignals.every((signal) => signal.aborted)).toBe(true);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});
