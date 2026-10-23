/* oxlint-disable eslint/no-await-in-loop -- bounded host liveness observation must remain sequential */
import { readFile, watch } from 'node:fs/promises';
import path from 'node:path';

import { waitForProtocolRetryInterval } from './e2e-protocol-wait.js';
import { portalCompositionLossCancellationWindowMilliseconds } from './portal-composition-hermes-e2e-test-fixture.js';

function hostProcessIsAlive(processId: number): boolean {
	try {
		process.kill(processId, 0);
		return true;
	} catch (error: unknown) {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH') {
			return false;
		}
		throw error;
	}
}

export async function observeLossProbeProcessExit(options: {
	readonly timestampPath: string;
	readonly pidPath: string;
	readonly signal: AbortSignal;
}): Promise<void> {
	const readBarrier = async (): Promise<{ processId: number; startedAtMs: number } | undefined> => {
		const [pidText, timestampText] = await Promise.all([
			readFile(options.pidPath, 'utf8').catch(() => undefined),
			readFile(options.timestampPath, 'utf8').catch(() => undefined),
		]);
		if (pidText === undefined || timestampText === undefined) return undefined;
		if (!/^[1-9][0-9]*$/u.test(pidText.trim()) || !/^[1-9][0-9]*$/u.test(timestampText.trim())) {
			throw new Error('Loss-probe PID or fast timestamp was invalid.');
		}
		return {
			processId: Number.parseInt(pidText, 10),
			startedAtMs: Number.parseInt(timestampText, 10),
		};
	};
	let barrier = await readBarrier();
	if (barrier === undefined) {
		for await (const event of watch(path.dirname(options.pidPath), {
			signal: AbortSignal.any([options.signal, AbortSignal.timeout(180_000)]),
		})) {
			void event;
			barrier = await readBarrier();
			if (barrier !== undefined) break;
		}
	}
	if (barrier === undefined) throw new Error('Loss-probe host barrier was never observed.');
	const deadline = barrier.startedAtMs + portalCompositionLossCancellationWindowMilliseconds;
	while (hostProcessIsAlive(barrier.processId) && Date.now() <= deadline) {
		options.signal.throwIfAborted();
		await waitForProtocolRetryInterval(50);
	}
	if (hostProcessIsAlive(barrier.processId) || Date.now() > deadline) {
		throw new Error(
			`Loss-probe host process ${String(barrier.processId)} did not exit within the cancellation window.`,
		);
	}
}
