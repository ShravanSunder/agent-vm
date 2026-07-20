import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	GatewayRuntimeLocalExecLineDecoder,
	GatewayRuntimeLocalExecProtocolError,
	encodeGatewayRuntimeLocalExecFrame,
	parseGatewayRuntimeLocalExecClientFrame,
	type GatewayRuntimeLocalExecServerFrame,
} from './gateway-runtime-local-exec-protocol.js';

export const GATEWAY_RUNTIME_LOCAL_EXEC_SOCKET_ENV = 'AGENT_VM_LOCAL_EXEC_SOCKET';
export const GATEWAY_RUNTIME_LOCAL_EXEC_TOKEN_ENV = 'AGENT_VM_LOCAL_EXEC_TOKEN';

const DEFAULT_RESERVATION_TIMEOUT_MS = 15_000;
const DEFAULT_TEMPORARY_DIRECTORY = '/tmp';
const MAXIMUM_STREAM_CHUNK_BYTES = 64 * 1024;

export type GatewayRuntimeLocalExecReadResult =
	| { readonly content: Uint8Array; readonly kind: 'chunk' }
	| { readonly kind: 'end' };

export interface GatewayRuntimeLocalExecOperation {
	readonly cancel: () => Promise<void>;
	readonly closeStdin: () => Promise<void>;
	readonly readStderr: (maximumBytes: number) => Promise<GatewayRuntimeLocalExecReadResult>;
	readonly readStdout: (maximumBytes: number) => Promise<GatewayRuntimeLocalExecReadResult>;
	readonly resizeTerminal?: (size: {
		readonly columns: number;
		readonly rows: number;
	}) => Promise<void>;
	readonly wait: () => Promise<{ readonly exitCode: number | null }>;
	readonly writeStdin: (content: Uint8Array) => Promise<void>;
}

export interface GatewayRuntimeLocalExecReservationScheduler {
	readonly schedule: (callback: () => void, delayMs: number) => { readonly cancel: () => void };
}

export interface GatewayRuntimeLocalExecFinalizeToken {
	readonly kind: 'gateway-runtime-local-exec';
	readonly reservationId: string;
}

export interface GatewayRuntimeLocalExecSpec {
	readonly argv: readonly string[];
	readonly env: Readonly<Record<string, string>>;
	readonly finalizeToken: GatewayRuntimeLocalExecFinalizeToken;
	readonly stdinMode: 'pipe-open';
}

export interface GatewayRuntimeLocalExecTransportOptions {
	readonly helperArgv?: readonly string[];
	readonly reservationScheduler?: GatewayRuntimeLocalExecReservationScheduler;
	readonly reservationTimeoutMs?: number;
	readonly temporaryDirectory?: string;
}

interface ReservationRecord {
	readonly cancelExpiry: () => void;
	readonly operation: GatewayRuntimeLocalExecOperation;
	readonly reservationDirectory: string;
	readonly reservationId: string;
	readonly server: Server;
	readonly socketPath: string;
	readonly token: string;
	consumed: boolean;
	disposal?: Promise<void>;
	finalized: boolean;
	socket?: Socket;
}

const defaultReservationScheduler: GatewayRuntimeLocalExecReservationScheduler = {
	schedule(callback, delayMs) {
		const timeout = setTimeout(callback, delayMs);
		return { cancel: () => clearTimeout(timeout) };
	},
};

function validateReservationTimeout(timeoutMs: number): number {
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
		throw new RangeError('Local exec reservation timeout must be an integer from 1 through 60000.');
	}
	return timeoutMs;
}

async function closeServer(server: Server): Promise<void> {
	if (!server.listening) return;
	await new Promise<void>((resolve, reject) => {
		server.close((error?: Error) => (error === undefined ? resolve() : reject(error)));
	});
}

async function writeFrame(
	socket: Socket,
	frame: GatewayRuntimeLocalExecServerFrame,
): Promise<void> {
	const encodedFrame = encodeGatewayRuntimeLocalExecFrame(frame);
	if (socket.write(encodedFrame)) return;
	await new Promise<void>((resolve, reject) => {
		const cleanup = (): void => {
			socket.off('drain', handleDrain);
			socket.off('error', handleError);
		};
		const handleDrain = (): void => {
			cleanup();
			resolve();
		};
		const handleError = (error: Error): void => {
			cleanup();
			reject(error);
		};
		socket.once('drain', handleDrain);
		socket.once('error', handleError);
	});
}

class GatewayRuntimeLocalExecFrameWriter {
	#pendingWrite = Promise.resolve();
	readonly #socket: Socket;

	constructor(socket: Socket) {
		this.#socket = socket;
	}

	async write(frame: GatewayRuntimeLocalExecServerFrame): Promise<void> {
		const write = this.#pendingWrite.then(async () => await writeFrame(this.#socket, frame));
		this.#pendingWrite = write.catch(() => undefined);
		await write;
	}
}

async function endSocket(socket: Socket): Promise<void> {
	if (socket.destroyed) return;
	await new Promise<void>((resolve) => socket.end(resolve));
}

async function pumpOutput(props: {
	readonly frameWriter: GatewayRuntimeLocalExecFrameWriter;
	readonly kind: 'stderr' | 'stdout';
	readonly operation: GatewayRuntimeLocalExecOperation;
	readonly socket: Socket;
}): Promise<void> {
	const read =
		props.kind === 'stdout'
			? props.operation.readStdout.bind(props.operation)
			: props.operation.readStderr.bind(props.operation);
	if (props.socket.destroyed) return;
	const result = await read(MAXIMUM_STREAM_CHUNK_BYTES);
	if (result.kind === 'end') {
		await props.frameWriter.write({ kind: `${props.kind}-end` });
		return;
	}
	await props.frameWriter.write({
		contentBase64: Buffer.from(result.content).toString('base64'),
		kind: `${props.kind}-chunk`,
	});
	await pumpOutput(props);
}

export class GatewayRuntimeLocalExecTransport {
	readonly #helperArgv: readonly string[];
	readonly #reservationScheduler: GatewayRuntimeLocalExecReservationScheduler;
	readonly #reservationTimeoutMs: number;
	readonly #reservations = new Map<string, ReservationRecord>();
	readonly #temporaryDirectory: string;

	constructor(options: GatewayRuntimeLocalExecTransportOptions = {}) {
		this.#helperArgv =
			options.helperArgv ??
			Object.freeze([
				process.execPath,
				fileURLToPath(
					new URL(
						'./gateway-runtime-local-exec/gateway-runtime-local-exec-helper.js',
						import.meta.url,
					),
				),
			]);
		if (this.#helperArgv.length === 0)
			throw new TypeError('Local exec helper argv cannot be empty.');
		this.#reservationScheduler = options.reservationScheduler ?? defaultReservationScheduler;
		this.#reservationTimeoutMs = validateReservationTimeout(
			options.reservationTimeoutMs ?? DEFAULT_RESERVATION_TIMEOUT_MS,
		);
		this.#temporaryDirectory = options.temporaryDirectory ?? DEFAULT_TEMPORARY_DIRECTORY;
	}

	async reserve(operation: GatewayRuntimeLocalExecOperation): Promise<GatewayRuntimeLocalExecSpec> {
		const reservationId = randomBytes(16).toString('hex');
		const token = randomBytes(32).toString('base64url');
		const reservationDirectory = await mkdtemp(
			join(this.#temporaryDirectory, 'agent-vm-local-exec-'),
		);
		await chmod(reservationDirectory, 0o700);
		const socketPath = join(reservationDirectory, 'relay.sock');
		const server = createServer();
		const expiry = this.#reservationScheduler.schedule(() => {
			void this.#expireReservation(reservationId).catch(() => undefined);
		}, this.#reservationTimeoutMs);
		const reservation: ReservationRecord = {
			cancelExpiry: expiry.cancel,
			consumed: false,
			finalized: false,
			operation,
			reservationDirectory,
			reservationId,
			server,
			socketPath,
			token,
		};
		this.#reservations.set(reservationId, reservation);
		server.on('connection', (socket) => this.#acceptConnection(reservation, socket));
		try {
			await new Promise<void>((resolve, reject) => {
				server.once('error', reject);
				server.listen(socketPath, () => {
					server.off('error', reject);
					resolve();
				});
			});
			await chmod(socketPath, 0o600);
		} catch (error: unknown) {
			await this.#disposeReservation(reservation, true);
			throw error;
		}
		return {
			argv: [...this.#helperArgv],
			env: {
				[GATEWAY_RUNTIME_LOCAL_EXEC_SOCKET_ENV]: socketPath,
				[GATEWAY_RUNTIME_LOCAL_EXEC_TOKEN_ENV]: token,
			},
			finalizeToken: { kind: 'gateway-runtime-local-exec', reservationId },
			stdinMode: 'pipe-open',
		};
	}

	async finalize(token: unknown): Promise<void> {
		const reservationId =
			typeof token === 'object' && token !== null ? Reflect.get(token, 'reservationId') : undefined;
		if (
			typeof token !== 'object' ||
			token === null ||
			Reflect.get(token, 'kind') !== 'gateway-runtime-local-exec' ||
			typeof reservationId !== 'string'
		) {
			return;
		}
		const reservation = this.#reservations.get(reservationId);
		if (reservation === undefined) return;
		await this.#disposeReservation(reservation, !reservation.consumed);
	}

	async close(): Promise<void> {
		await Promise.all(
			[...this.#reservations.values()].map(
				async (reservation) => await this.#disposeReservation(reservation, true),
			),
		);
	}

	async #expireReservation(reservationId: string): Promise<void> {
		const reservation = this.#reservations.get(reservationId);
		if (reservation === undefined || reservation.consumed) return;
		await this.#disposeReservation(reservation, true);
	}

	#acceptConnection(reservation: ReservationRecord, socket: Socket): void {
		if (reservation.finalized || reservation.consumed) {
			void writeFrame(socket, {
				kind: 'rejected',
				message: 'Reservation already consumed.',
			})
				.catch(() => undefined)
				.finally(() => socket.destroy());
			return;
		}
		const decoder = new GatewayRuntimeLocalExecLineDecoder();
		const connectionState = { authenticated: false };
		socket.once('close', () => {
			if (connectionState.authenticated && !reservation.finalized) {
				void this.#disposeReservation(reservation, true).catch(() => undefined);
			}
		});
		socket.on('data', (chunk: Buffer) => {
			socket.pause();
			void this.#processClientFrames({
				chunk,
				connectionState,
				decoder,
				reservation,
				socket,
			})
				.then(() => {
					if (!socket.destroyed) socket.resume();
				})
				.catch((error: unknown) => {
					void writeFrame(socket, {
						kind: 'rejected',
						message: error instanceof Error ? error.message : 'Invalid local exec frame.',
					})
						.catch(() => undefined)
						.finally(() => socket.destroy());
				});
		});
	}

	async #processClientFrames(props: {
		readonly chunk: Buffer;
		readonly connectionState: { authenticated: boolean };
		readonly decoder: GatewayRuntimeLocalExecLineDecoder;
		readonly reservation: ReservationRecord;
		readonly socket: Socket;
	}): Promise<void> {
		// oxlint-disable no-await-in-loop -- input frames must preserve order and backpressure.
		for (const line of props.decoder.push(props.chunk)) {
			const frame = parseGatewayRuntimeLocalExecClientFrame(line);
			if (!props.connectionState.authenticated) {
				if (
					frame.kind !== 'authenticate' ||
					frame.token !== props.reservation.token ||
					props.reservation.consumed
				) {
					await writeFrame(props.socket, {
						kind: 'rejected',
						message:
							frame.kind === 'authenticate' && frame.token === props.reservation.token
								? 'Reservation already consumed.'
								: 'Invalid reservation token.',
					});
					props.socket.destroy();
					return;
				}
				props.connectionState.authenticated = true;
				props.reservation.consumed = true;
				props.reservation.cancelExpiry();
				props.reservation.socket = props.socket;
				props.reservation.server.close();
				await writeFrame(props.socket, { kind: 'accepted' });
				void this.#runAuthenticatedOperation(props.reservation, props.socket).catch(
					() => undefined,
				);
				continue;
			}
			switch (frame.kind) {
				case 'authenticate':
					throw new GatewayRuntimeLocalExecProtocolError('Duplicate authentication frame.');
				case 'cancel':
					await props.reservation.operation.cancel();
					return;
				case 'stdin-chunk':
					await props.reservation.operation.writeStdin(Buffer.from(frame.contentBase64, 'base64'));
					continue;
				case 'stdin-end':
					await props.reservation.operation.closeStdin();
					continue;
				case 'terminal-resize':
					if (props.reservation.operation.resizeTerminal === undefined) {
						throw new GatewayRuntimeLocalExecProtocolError('Terminal resize is unavailable.');
					}
					await props.reservation.operation.resizeTerminal({
						columns: frame.columns,
						rows: frame.rows,
					});
			}
		}
		// oxlint-enable no-await-in-loop
	}

	async #runAuthenticatedOperation(reservation: ReservationRecord, socket: Socket): Promise<void> {
		try {
			const frameWriter = new GatewayRuntimeLocalExecFrameWriter(socket);
			const [waitResult] = await Promise.all([
				reservation.operation.wait(),
				pumpOutput({ frameWriter, kind: 'stdout', operation: reservation.operation, socket }),
				pumpOutput({ frameWriter, kind: 'stderr', operation: reservation.operation, socket }),
			]);
			if (!socket.destroyed) {
				await frameWriter.write({ exitCode: waitResult.exitCode, kind: 'exited' });
				await endSocket(socket);
			}
		} catch {
			socket.destroy();
		} finally {
			await this.#disposeReservation(reservation, false);
		}
	}

	async #disposeReservation(reservation: ReservationRecord, cancel: boolean): Promise<void> {
		if (reservation.disposal !== undefined) return await reservation.disposal;
		reservation.disposal = this.#disposeReservationOnce(reservation, cancel);
		await reservation.disposal;
	}

	async #disposeReservationOnce(reservation: ReservationRecord, cancel: boolean): Promise<void> {
		if (reservation.finalized) return;
		reservation.finalized = true;
		reservation.cancelExpiry();
		let cancellationError: unknown;
		if (cancel) {
			try {
				await reservation.operation.cancel();
			} catch (error: unknown) {
				cancellationError = error;
			}
		}
		let cleanupError: unknown;
		try {
			reservation.socket?.destroy();
			await closeServer(reservation.server).catch(() => undefined);
			await rm(reservation.reservationDirectory, { force: true, recursive: true });
		} catch (error: unknown) {
			cleanupError = error;
		} finally {
			this.#reservations.delete(reservation.reservationId);
		}
		if (cancellationError !== undefined && cleanupError !== undefined) {
			throw new AggregateError(
				[cancellationError, cleanupError],
				'Local exec cancellation and cleanup both failed.',
			);
		}
		if (cancellationError !== undefined) throw cancellationError;
		if (cleanupError !== undefined) throw cleanupError;
	}
}
