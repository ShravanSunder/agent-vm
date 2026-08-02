import { createServer, connect, type Server, type Socket } from 'node:net';

export interface ControlTransportProxyEndpoint {
	readonly host: string;
	readonly port: number;
}

export interface ControlTransportIsolationReceipt {
	readonly rejectedConnectionCount: number;
	readonly startedAtMs: number;
}

export interface ControlTransportRejectedConnectionObservation {
	readonly observedAtMs: number;
	readonly rejectedConnectionCount: number;
}

export interface ControlTransportReliabilityProxy {
	readonly endpoint: ControlTransportProxyEndpoint;
	close(): Promise<void>;
	isolate(): ControlTransportIsolationReceipt;
	restore(): void;
	roundTrip(payload: string): Promise<string>;
	waitForRejectedConnection(options: {
		readonly minimumObservedAtMs: number;
		readonly minimumRejectedConnectionCount: number;
		readonly timeoutMs: number;
	}): Promise<ControlTransportRejectedConnectionObservation>;
}

interface RejectedConnectionWaiter {
	readonly minimumObservedAtMs: number;
	readonly minimumRejectedConnectionCount: number;
	readonly reject: (error: Error) => void;
	readonly resolve: (observation: ControlTransportRejectedConnectionObservation) => void;
	readonly timeout: NodeJS.Timeout;
}

function listenOnLoopback(server: Server): Promise<ControlTransportProxyEndpoint> {
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			server.off('error', reject);
			const address = server.address();
			if (address === null || typeof address === 'string') {
				reject(new Error('Control transport reliability proxy did not expose a TCP address.'));
				return;
			}
			resolve({ host: '127.0.0.1', port: address.port });
		});
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => (error === undefined ? resolve() : reject(error)));
	});
}

export async function startControlTransportReliabilityProxy(options: {
	readonly target: ControlTransportProxyEndpoint;
}): Promise<ControlTransportReliabilityProxy> {
	let closed = false;
	let isolated = false;
	let rejectedConnectionCount = 0;
	let latestRejectedConnection: ControlTransportRejectedConnectionObservation | undefined;
	const liveSockets = new Set<Socket>();
	const waiters = new Set<RejectedConnectionWaiter>();

	const notifyRejectedConnection = (): void => {
		const observation = latestRejectedConnection;
		if (observation === undefined) {
			return;
		}
		for (const waiter of waiters) {
			if (
				observation.observedAtMs >= waiter.minimumObservedAtMs &&
				observation.rejectedConnectionCount >= waiter.minimumRejectedConnectionCount
			) {
				clearTimeout(waiter.timeout);
				waiters.delete(waiter);
				waiter.resolve(observation);
			}
		}
	};

	const trackSocket = (socket: Socket): void => {
		liveSockets.add(socket);
		socket.once('close', () => liveSockets.delete(socket));
		socket.on('error', () => socket.destroy());
	};

	const server = createServer((downstream) => {
		trackSocket(downstream);
		if (isolated || closed) {
			rejectedConnectionCount += 1;
			latestRejectedConnection = {
				observedAtMs: Date.now(),
				rejectedConnectionCount,
			};
			downstream.destroy();
			notifyRejectedConnection();
			return;
		}
		const upstream = connect({ host: options.target.host, port: options.target.port });
		trackSocket(upstream);
		upstream.once('connect', () => {
			downstream.pipe(upstream);
			upstream.pipe(downstream);
		});
		upstream.once('close', () => downstream.destroy());
		downstream.once('close', () => upstream.destroy());
	});
	const endpoint = await listenOnLoopback(server);

	return {
		endpoint,
		async close(): Promise<void> {
			if (closed) {
				return;
			}
			closed = true;
			for (const waiter of waiters) {
				clearTimeout(waiter.timeout);
				waiter.reject(new Error('Control transport reliability proxy closed.'));
			}
			waiters.clear();
			for (const socket of liveSockets) {
				socket.destroy();
			}
			await closeServer(server);
		},
		isolate(): ControlTransportIsolationReceipt {
			if (closed) {
				throw new Error('Control transport reliability proxy is closed.');
			}
			isolated = true;
			const startedAtMs = Date.now();
			for (const socket of liveSockets) {
				socket.destroy();
			}
			return { rejectedConnectionCount, startedAtMs };
		},
		restore(): void {
			if (closed) {
				throw new Error('Control transport reliability proxy is closed.');
			}
			isolated = false;
		},
		async roundTrip(payload: string): Promise<string> {
			return await new Promise<string>((resolve, reject) => {
				const socket = connect(endpoint);
				let response = '';
				const timeout = setTimeout(() => {
					socket.destroy();
					reject(new Error('Control transport reliability proxy round trip timed out.'));
				}, 1_000);
				socket.setEncoding('utf8');
				socket.once('connect', () => socket.write(payload));
				socket.on('data', (chunk: string) => {
					response += chunk;
					if (response.length >= payload.length) {
						clearTimeout(timeout);
						socket.destroy();
						resolve(response);
					}
				});
				socket.once('error', (error) => {
					clearTimeout(timeout);
					reject(error);
				});
				socket.once('close', () => {
					if (response.length < payload.length) {
						clearTimeout(timeout);
						reject(new Error('Control transport reliability proxy round trip closed early.'));
					}
				});
			});
		},
		async waitForRejectedConnection(
			waitOptions,
		): Promise<ControlTransportRejectedConnectionObservation> {
			const currentObservation = latestRejectedConnection;
			if (
				currentObservation !== undefined &&
				currentObservation.observedAtMs >= waitOptions.minimumObservedAtMs &&
				currentObservation.rejectedConnectionCount >= waitOptions.minimumRejectedConnectionCount
			) {
				return currentObservation;
			}
			return await new Promise((resolve, reject) => {
				const waiter: RejectedConnectionWaiter = {
					minimumObservedAtMs: waitOptions.minimumObservedAtMs,
					minimumRejectedConnectionCount: waitOptions.minimumRejectedConnectionCount,
					reject,
					resolve,
					timeout: setTimeout(() => {
						waiters.delete(waiter);
						reject(
							new Error(
								`Timed out waiting for rejected control connection count ${String(waitOptions.minimumRejectedConnectionCount)} after ${String(waitOptions.minimumObservedAtMs)}.`,
							),
						);
					}, waitOptions.timeoutMs),
				};
				waiters.add(waiter);
			});
		},
	};
}
