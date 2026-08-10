import { describe, expect, it } from 'vitest';

import { runWorkerServeLifecycle } from './worker-cli-operations.js';

interface FakeSignalTarget {
	readonly listeners: Map<'SIGINT' | 'SIGTERM', () => void>;
	readonly off: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => void;
	readonly on: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => void;
	readonly emit: (signal: 'SIGINT' | 'SIGTERM') => void;
}

function createFakeSignalTarget(): FakeSignalTarget {
	const listeners = new Map<'SIGINT' | 'SIGTERM', () => void>();
	return {
		listeners,
		off: (signal, listener) => {
			if (listeners.get(signal) === listener) listeners.delete(signal);
		},
		on: (signal, listener) => {
			listeners.set(signal, listener);
		},
		emit: (signal) => {
			listeners.get(signal)?.();
		},
	};
}

describe('worker serve lifecycle', () => {
	it('waits for a shutdown signal, closes server then control service, and disposes logging last', async () => {
		const signalTarget = createFakeSignalTarget();
		const events: string[] = [];
		const lifecycle = runWorkerServeLifecycle({
			signalTarget,
			server: {
				close: async (): Promise<void> => {
					events.push('server.close');
				},
			},
			workerControlService: {
				close: async (): Promise<void> => {
					events.push('control.close');
				},
			},
			logging: {
				shutdown: async (): Promise<void> => {
					events.push('logging.shutdown');
				},
			},
		});

		expect(signalTarget.listeners.get('SIGINT')).toBeDefined();
		signalTarget.emit('SIGTERM');
		await lifecycle;

		expect(events).toEqual(['server.close', 'control.close', 'logging.shutdown']);
		expect(signalTarget.listeners).toHaveLength(0);
	});

	it('shares one close promise when shutdown signals race', async () => {
		const signalTarget = createFakeSignalTarget();
		const closeGate = Promise.withResolvers<void>();
		let serverCloseCalls = 0;
		let loggingShutdownCalls = 0;
		const lifecycle = runWorkerServeLifecycle({
			signalTarget,
			server: {
				close: async (): Promise<void> => {
					serverCloseCalls += 1;
					await closeGate.promise;
				},
			},
			logging: {
				shutdown: async (): Promise<void> => {
					loggingShutdownCalls += 1;
				},
			},
		});

		signalTarget.emit('SIGINT');
		signalTarget.emit('SIGTERM');
		closeGate.resolve();
		await lifecycle;

		expect(serverCloseCalls).toBe(1);
		expect(loggingShutdownCalls).toBe(1);
		expect(signalTarget.listeners).toHaveLength(0);
	});

	it('keeps a product close failure primary and still disposes logging', async () => {
		const signalTarget = createFakeSignalTarget();
		const loggingShutdown = Promise.withResolvers<void>();
		const lifecycle = runWorkerServeLifecycle({
			signalTarget,
			server: {
				close: async (): Promise<void> => {
					throw new Error('server close failed');
				},
			},
			logging: {
				shutdown: async (): Promise<void> => {
					loggingShutdown.resolve();
					throw new Error('logging close failed');
				},
			},
		});

		signalTarget.emit('SIGTERM');
		await expect(lifecycle).rejects.toThrow('server close failed');
		await loggingShutdown.promise;
		expect(signalTarget.listeners).toHaveLength(0);
	});
});
