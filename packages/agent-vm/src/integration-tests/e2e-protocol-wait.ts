import { setTimeout as waitForRetryInterval } from 'node:timers/promises';

export async function waitForProtocolRetryInterval(intervalMs: number): Promise<void> {
	await waitForRetryInterval(intervalMs);
}

export async function withProtocolDeadline<TValue>(
	promise: Promise<TValue>,
	label: string,
	timeoutMs = 2_000,
): Promise<TValue> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(() => {
					reject(new Error(`${label} exceeded ${String(timeoutMs)}ms protocol deadline`));
				}, timeoutMs);
				timeout.unref?.();
			}),
		]);
	} finally {
		if (timeout !== undefined) {
			clearTimeout(timeout);
		}
	}
}
