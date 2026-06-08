import { beforeEach, describe, expect, it, vi } from 'vitest';

import { startHeartbeatSender } from './heartbeat-sender.js';

interface ScheduledInterval {
	readonly handle: NodeJS.Timeout;
	readonly callback: () => void | Promise<void>;
	readonly delayMs: number;
}

function createFakeInterval(): {
	readonly active: () => readonly ScheduledInterval[];
	readonly clearIntervalImpl: (handle: NodeJS.Timeout) => void;
	readonly fire: () => Promise<void>;
	readonly setIntervalImpl: (
		callback: () => void | Promise<void>,
		delayMs: number,
	) => NodeJS.Timeout;
} {
	const scheduled: ScheduledInterval[] = [];
	return {
		active: (): readonly ScheduledInterval[] => scheduled.slice(),
		clearIntervalImpl: (handle): void => {
			const index = scheduled.findIndex((item) => item.handle === handle);
			if (index >= 0) {
				scheduled.splice(index, 1);
			}
		},
		fire: async (): Promise<void> => {
			const snapshot = scheduled.slice();
			await Promise.all(snapshot.map(async (item) => await item.callback()));
		},
		setIntervalImpl: (callback, delayMs): NodeJS.Timeout => {
			const handle = setTimeout(() => {}, 0);
			clearTimeout(handle);
			scheduled.push({ handle, callback, delayMs });
			return handle;
		},
	};
}

describe('startHeartbeatSender', () => {
	let fakeTimer: ReturnType<typeof createFakeInterval>;
	let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
	const warnings: string[] = [];

	beforeEach(() => {
		fakeTimer = createFakeInterval();
		fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
		warnings.length = 0;
	});

	it('fires immediately on start', async () => {
		const handle = startHeartbeatSender('task-1', {
			callerUrl: 'http://caller:3000',
			setIntervalImpl: fakeTimer.setIntervalImpl,
			clearIntervalImpl: fakeTimer.clearIntervalImpl,
			fetchImpl: fetchMock,
			logWarning: (message): void => {
				warnings.push(message);
			},
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [calledUrl] = fetchMock.mock.calls[0] ?? [];
		expect(calledUrl).toBe('http://caller:3000/tasks/task-1/heartbeat');

		handle.stop();
	});

	it('uses the configured cadence', () => {
		const handle = startHeartbeatSender('task-1', {
			callerUrl: 'http://caller:3000',
			cadenceMs: 2_500,
			setIntervalImpl: fakeTimer.setIntervalImpl,
			clearIntervalImpl: fakeTimer.clearIntervalImpl,
			fetchImpl: fetchMock,
		});

		expect(fakeTimer.active()).toHaveLength(1);
		expect(fakeTimer.active()[0]?.delayMs).toBe(2_500);

		handle.stop();
	});

	it('keeps ticking after the immediate send', async () => {
		startHeartbeatSender('task-1', {
			callerUrl: 'http://caller:3000',
			setIntervalImpl: fakeTimer.setIntervalImpl,
			clearIntervalImpl: fakeTimer.clearIntervalImpl,
			fetchImpl: fetchMock,
		});
		await Promise.resolve();
		await Promise.resolve();

		await fakeTimer.fire();
		await fakeTimer.fire();

		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it('logs warnings for non-2xx responses', async () => {
		fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));

		startHeartbeatSender('task-1', {
			callerUrl: 'http://caller:3000',
			setIntervalImpl: fakeTimer.setIntervalImpl,
			clearIntervalImpl: fakeTimer.clearIntervalImpl,
			fetchImpl: fetchMock,
			logWarning: (message): void => {
				warnings.push(message);
			},
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(warnings[0]).toContain('HTTP 503');
	});

	it('logs warnings for transport errors', async () => {
		fetchMock.mockRejectedValueOnce(new Error('connection refused'));

		startHeartbeatSender('task-1', {
			callerUrl: 'http://caller:3000',
			setIntervalImpl: fakeTimer.setIntervalImpl,
			clearIntervalImpl: fakeTimer.clearIntervalImpl,
			fetchImpl: fetchMock,
			logWarning: (message): void => {
				warnings.push(message);
			},
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(warnings[0]).toContain('connection refused');
	});

	it('stops heartbeating when the caller returns 404', async () => {
		fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));

		startHeartbeatSender('task-1', {
			callerUrl: 'http://caller:3000',
			setIntervalImpl: fakeTimer.setIntervalImpl,
			clearIntervalImpl: fakeTimer.clearIntervalImpl,
			fetchImpl: fetchMock,
			logWarning: (message): void => {
				warnings.push(message);
			},
		});
		await Promise.resolve();
		await Promise.resolve();

		await fakeTimer.fire();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(warnings[0]).toContain('stopping heartbeat permanently');
		expect(fakeTimer.active()).toHaveLength(0);
	});

	it('stops heartbeating when the caller returns 410', async () => {
		fetchMock.mockResolvedValueOnce(new Response(null, { status: 410 }));

		startHeartbeatSender('task-1', {
			callerUrl: 'http://caller:3000',
			setIntervalImpl: fakeTimer.setIntervalImpl,
			clearIntervalImpl: fakeTimer.clearIntervalImpl,
			fetchImpl: fetchMock,
			logWarning: (message): void => {
				warnings.push(message);
			},
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(warnings[0]).toContain('HTTP 410');
		expect(fakeTimer.active()).toHaveLength(0);
	});

	it('escalates and periodically re-warns after repeated heartbeat failures', async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 502 }));

		startHeartbeatSender('task-1', {
			callerUrl: 'http://caller:3000',
			setIntervalImpl: fakeTimer.setIntervalImpl,
			clearIntervalImpl: fakeTimer.clearIntervalImpl,
			fetchImpl: fetchMock,
			logWarning: (message): void => {
				warnings.push(message);
			},
		});
		await Promise.resolve();
		await Promise.resolve();
		await fakeTimer.fire();
		await fakeTimer.fire();
		await fakeTimer.fire();
		await fakeTimer.fire();
		await fakeTimer.fire();
		await fakeTimer.fire();
		await fakeTimer.fire();
		await fakeTimer.fire();
		await fakeTimer.fire();

		expect(fetchMock).toHaveBeenCalledTimes(10);
		expect(warnings).toHaveLength(3);
		expect(warnings[0]).toContain('HTTP 502');
		expect(warnings[1]).toContain('3 consecutive times');
		expect(warnings[2]).toContain('10 consecutive times');
	});

	it('aborts an in-flight heartbeat fetch when stopped', async () => {
		let signal: AbortSignal | null | undefined;
		const hangingFetch: typeof fetch = (_url, init) => {
			signal = init?.signal;
			return new Promise<Response>(() => {
				// Keep the request hanging so stop() must abort it.
			});
		};

		const handle = startHeartbeatSender('task-1', {
			callerUrl: 'http://caller:3000',
			setIntervalImpl: fakeTimer.setIntervalImpl,
			clearIntervalImpl: fakeTimer.clearIntervalImpl,
			fetchImpl: hangingFetch,
			logWarning: (message): void => {
				warnings.push(message);
			},
		});
		await Promise.resolve();
		await Promise.resolve();

		handle.stop();

		expect(signal?.aborted).toBe(true);
		expect(fakeTimer.active()).toHaveLength(0);
	});

	it('stop cancels the interval and is idempotent', () => {
		const handle = startHeartbeatSender('task-1', {
			callerUrl: 'http://caller:3000',
			setIntervalImpl: fakeTimer.setIntervalImpl,
			clearIntervalImpl: fakeTimer.clearIntervalImpl,
			fetchImpl: fetchMock,
		});

		handle.stop();
		handle.stop();

		expect(fakeTimer.active()).toHaveLength(0);
	});

	it('uses the exact request task id in the request path', async () => {
		const handle = startHeartbeatSender('request-task-42', {
			callerUrl: 'http://caller:3000',
			setIntervalImpl: fakeTimer.setIntervalImpl,
			clearIntervalImpl: fakeTimer.clearIntervalImpl,
			fetchImpl: fetchMock,
		});
		await Promise.resolve();
		await Promise.resolve();

		const [url] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe('http://caller:3000/tasks/request-task-42/heartbeat');

		handle.stop();
	});
});
