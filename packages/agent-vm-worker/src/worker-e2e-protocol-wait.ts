import { setTimeout as waitForRetryInterval } from 'node:timers/promises';

export async function waitForWorkerProtocolRetryInterval(intervalMs: number): Promise<void> {
	await waitForRetryInterval(intervalMs);
}
