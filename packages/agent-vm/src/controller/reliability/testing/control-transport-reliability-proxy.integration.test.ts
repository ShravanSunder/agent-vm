import { createServer, type Server } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
	startControlTransportReliabilityProxy,
	type ControlTransportReliabilityProxy,
} from './control-transport-reliability-proxy.js';

describe('control transport reliability proxy', () => {
	let proxy: ControlTransportReliabilityProxy | undefined;
	let targetServer: Server | undefined;

	afterEach(async () => {
		await proxy?.close();
		await new Promise<void>((resolve, reject) => {
			if (targetServer === undefined || !targetServer.listening) {
				resolve();
				return;
			}
			targetServer.close((error) => (error === undefined ? resolve() : reject(error)));
		});
	});

	it('forwards current traffic, rejects isolated attempts, then explicitly restores forwarding', async () => {
		const createdTargetServer = createServer((socket) => socket.pipe(socket));
		targetServer = createdTargetServer;
		await new Promise<void>((resolve, reject) => {
			createdTargetServer.once('error', reject);
			createdTargetServer.listen(0, '127.0.0.1', () => {
				createdTargetServer.off('error', reject);
				resolve();
			});
		});
		const targetAddress = targetServer.address();
		if (targetAddress === null || typeof targetAddress === 'string') {
			throw new Error('Expected target server to expose a TCP address.');
		}
		proxy = await startControlTransportReliabilityProxy({
			target: { host: '127.0.0.1', port: targetAddress.port },
		});

		await expect(proxy.roundTrip('before-isolation')).resolves.toBe('before-isolation');
		const isolation = proxy.isolate();
		await expect(proxy.roundTrip('during-isolation')).rejects.toThrow();
		await expect(
			proxy.waitForRejectedConnection({
				minimumObservedAtMs: isolation.startedAtMs,
				minimumRejectedConnectionCount: 1,
				timeoutMs: 1_000,
			}),
		).resolves.toMatchObject({ rejectedConnectionCount: 1 });

		proxy.restore();
		await expect(proxy.roundTrip('after-restoration')).resolves.toBe('after-restoration');

		await proxy.close();
		proxy = undefined;
	});
});
