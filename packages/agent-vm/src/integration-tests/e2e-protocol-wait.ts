import { setTimeout as waitForRetryInterval } from 'node:timers/promises';

export async function waitForProtocolRetryInterval(intervalMs: number): Promise<void> {
	await waitForRetryInterval(intervalMs);
}
