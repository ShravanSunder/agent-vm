import { spawn } from 'node:child_process';
import { access, mkdtemp, stat } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
	GatewayRuntimeLocalExecLineDecoder,
	encodeGatewayRuntimeLocalExecFrame,
	parseGatewayRuntimeLocalExecServerFrame,
} from './gateway-runtime-local-exec-protocol.js';
import {
	GATEWAY_RUNTIME_LOCAL_EXEC_SOCKET_ENV,
	GATEWAY_RUNTIME_LOCAL_EXEC_TOKEN_ENV,
	GatewayRuntimeLocalExecTransport,
	type GatewayRuntimeLocalExecOperation,
	type GatewayRuntimeLocalExecReadResult,
	type GatewayRuntimeLocalExecReservationScheduler,
} from './gateway-runtime-local-exec-transport.js';

interface Deferred<TValue> {
	readonly promise: Promise<TValue>;
	readonly reject: (error: Error) => void;
	readonly resolve: (value: TValue) => void;
}

function createDeferred<TValue>(): Deferred<TValue> {
	let resolvePromise: ((value: TValue) => void) | undefined;
	let rejectPromise: ((error: Error) => void) | undefined;
	const promise = new Promise<TValue>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	return {
		promise,
		reject: (error) => rejectPromise?.(error),
		resolve: (value) => resolvePromise?.(value),
	};
}

function createReadQueue(
	contents: readonly string[],
): (maximumBytes: number) => Promise<GatewayRuntimeLocalExecReadResult> {
	const results: GatewayRuntimeLocalExecReadResult[] = [
		...contents.map((content) => ({ content: Buffer.from(content), kind: 'chunk' }) as const),
		{ kind: 'end' },
	];
	return async (maximumBytes) => {
		void maximumBytes;
		return results.shift() ?? { kind: 'end' };
	};
}

function requireValue<TValue>(value: TValue | undefined, label: string): TValue {
	if (value === undefined) throw new Error(`Expected ${label}.`);
	return value;
}

function helperArgv(): readonly string[] {
	return [
		process.execPath,
		'--disable-warning=DEP0205',
		'--import',
		'tsx',
		fileURLToPath(new URL('./gateway-runtime-local-exec-helper.ts', import.meta.url)),
	];
}

async function pathDoesNotExist(path: string): Promise<boolean> {
	try {
		await access(path);
		return false;
	} catch {
		return true;
	}
}

async function connectLocalSocket(socketPath: string): Promise<Socket> {
	const socket = createConnection(socketPath);
	await new Promise<void>((resolve, reject) => {
		socket.once('connect', resolve);
		socket.once('error', reject);
	});
	return socket;
}

async function readServerFrame(
	socket: Socket,
): Promise<ReturnType<typeof parseGatewayRuntimeLocalExecServerFrame>> {
	const decoder = new GatewayRuntimeLocalExecLineDecoder();
	return await new Promise((resolve, reject) => {
		socket.once('data', (chunk: Buffer) => {
			try {
				const [line] = decoder.push(chunk);
				if (line === undefined) throw new Error('Expected one complete local exec frame.');
				resolve(parseGatewayRuntimeLocalExecServerFrame(line));
			} catch (error: unknown) {
				reject(error);
			}
		});
		socket.once('error', reject);
	});
}

describe('GatewayRuntimeLocalExecTransport', () => {
	it('relays one admitted operation through a private operation-scoped socket', async () => {
		const temporaryDirectory = await mkdtemp('/tmp/agent-vm-local-exec-test-');
		const receivedInput: Buffer[] = [];
		const firstWriteStarted = createDeferred<void>();
		const releaseFirstWrite = createDeferred<void>();
		let activeWriteCount = 0;
		let maximumActiveWriteCount = 0;
		let stderrReadCount = 0;
		const readStderr = createReadQueue(['remote stderr']);
		const stdinClosed = createDeferred<void>();
		const operation: GatewayRuntimeLocalExecOperation = {
			cancel: async () => undefined,
			closeStdin: async () => stdinClosed.resolve(undefined),
			readStderr: async (maximumBytes) => {
				stderrReadCount += 1;
				return await readStderr(maximumBytes);
			},
			readStdout: createReadQueue(['remote stdout']),
			wait: async () => {
				await stdinClosed.promise;
				return { exitCode: 17 };
			},
			writeStdin: async (content) => {
				activeWriteCount += 1;
				maximumActiveWriteCount = Math.max(maximumActiveWriteCount, activeWriteCount);
				if (receivedInput.length === 0) {
					firstWriteStarted.resolve(undefined);
					await releaseFirstWrite.promise;
				}
				receivedInput.push(Buffer.from(content));
				activeWriteCount -= 1;
			},
		};
		const transport = new GatewayRuntimeLocalExecTransport({
			helperArgv: helperArgv(),
			temporaryDirectory,
		});
		const spec = await transport.reserve(operation);
		const socketPath = requireValue(
			spec.env[GATEWAY_RUNTIME_LOCAL_EXEC_SOCKET_ENV],
			'local exec socket path',
		);
		const token = requireValue(spec.env[GATEWAY_RUNTIME_LOCAL_EXEC_TOKEN_ENV], 'local exec token');
		expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
		expect((await stat(dirname(socketPath))).mode & 0o777).toBe(0o700);
		expect((await stat(socketPath)).mode & 0o777).toBe(0o600);

		const child = spawn(
			requireValue(spec.argv[0], 'local exec helper command'),
			spec.argv.slice(1),
			{
				env: { ...process.env, ...spec.env },
				stdio: ['pipe', 'pipe', 'pipe'],
			},
		);
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
		const localInput = Buffer.alloc(96 * 1024, 0x61);
		child.stdin.end(localInput);
		await firstWriteStarted.promise;
		expect(maximumActiveWriteCount).toBe(1);
		releaseFirstWrite.resolve(undefined);
		const exit = await new Promise<{
			readonly code: number | null;
			readonly signal: NodeJS.Signals | null;
		}>((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));

		expect(exit).toEqual({ code: 17, signal: null });
		expect(Buffer.concat(receivedInput)).toEqual(localInput);
		expect(maximumActiveWriteCount).toBe(1);
		expect(Buffer.concat(stdout).toString()).toBe('remote stdout');
		expect(stderrReadCount).toBe(2);
		expect(Buffer.concat(stderr).toString()).toBe('remote stderr');
		expect(await pathDoesNotExist(dirname(socketPath))).toBe(true);
		await transport.finalize(spec.finalizeToken);
		await transport.close();
	});

	it('expires an unused reservation, cancels its operation, and removes private files', async () => {
		const temporaryDirectory = await mkdtemp('/tmp/agent-vm-local-exec-expiry-');
		const cancelled = createDeferred<void>();
		let expire: (() => void) | undefined;
		const scheduler: GatewayRuntimeLocalExecReservationScheduler = {
			schedule(callback) {
				expire = callback;
				return { cancel: () => undefined };
			},
		};
		const operation: GatewayRuntimeLocalExecOperation = {
			cancel: async () => cancelled.resolve(undefined),
			closeStdin: async () => undefined,
			readStderr: async () => ({ kind: 'end' }),
			readStdout: async () => ({ kind: 'end' }),
			wait: async () => ({ exitCode: 0 }),
			writeStdin: async () => undefined,
		};
		const transport = new GatewayRuntimeLocalExecTransport({
			helperArgv: helperArgv(),
			reservationScheduler: scheduler,
			temporaryDirectory,
		});
		const spec = await transport.reserve(operation);
		const socketPath = requireValue(
			spec.env[GATEWAY_RUNTIME_LOCAL_EXEC_SOCKET_ENV],
			'local exec socket path',
		);

		expire?.();
		await cancelled.promise;
		await transport.finalize(spec.finalizeToken);
		expect(await pathDoesNotExist(dirname(socketPath))).toBe(true);
		await transport.close();
	});

	it('cancels and cleans an admitted operation when the spawned helper receives a signal', async () => {
		const temporaryDirectory = await mkdtemp('/tmp/agent-vm-local-exec-signal-');
		const cancelled = createDeferred<void>();
		const relayStarted = createDeferred<void>();
		const outputEnded = createDeferred<GatewayRuntimeLocalExecReadResult>();
		const waitCompleted = createDeferred<{ readonly exitCode: number | null }>();
		const operation: GatewayRuntimeLocalExecOperation = {
			cancel: async () => {
				cancelled.resolve(undefined);
				outputEnded.resolve({ kind: 'end' });
				waitCompleted.resolve({ exitCode: null });
			},
			closeStdin: async () => undefined,
			readStderr: async () => await outputEnded.promise,
			readStdout: async () => {
				relayStarted.resolve(undefined);
				return await outputEnded.promise;
			},
			wait: async () => await waitCompleted.promise,
			writeStdin: async () => undefined,
		};
		const transport = new GatewayRuntimeLocalExecTransport({
			helperArgv: helperArgv(),
			temporaryDirectory,
		});
		const spec = await transport.reserve(operation);
		const socketPath = requireValue(
			spec.env[GATEWAY_RUNTIME_LOCAL_EXEC_SOCKET_ENV],
			'local exec socket path',
		);
		const child = spawn(
			requireValue(spec.argv[0], 'local exec helper command'),
			spec.argv.slice(1),
			{
				env: { ...process.env, ...spec.env },
				stdio: ['pipe', 'pipe', 'pipe'],
			},
		);
		child.stdin.write('attached');
		await relayStarted.promise;
		child.kill('SIGTERM');

		await cancelled.promise;
		await new Promise<void>((resolve) => child.once('close', () => resolve()));
		await transport.finalize(spec.finalizeToken);
		expect(await pathDoesNotExist(dirname(socketPath))).toBe(true);
		await transport.close();
	});

	it('rejects wrong and duplicate tokens while consuming the reservation exactly once', async () => {
		const temporaryDirectory = await mkdtemp('/tmp/agent-vm-local-exec-token-');
		const cancelled = createDeferred<void>();
		const outputEnded = createDeferred<GatewayRuntimeLocalExecReadResult>();
		const waitCompleted = createDeferred<{ readonly exitCode: number | null }>();
		const operation: GatewayRuntimeLocalExecOperation = {
			cancel: async () => {
				cancelled.resolve(undefined);
				outputEnded.resolve({ kind: 'end' });
				waitCompleted.resolve({ exitCode: null });
			},
			closeStdin: async () => undefined,
			readStderr: async () => await outputEnded.promise,
			readStdout: async () => await outputEnded.promise,
			wait: async () => await waitCompleted.promise,
			writeStdin: async () => undefined,
		};
		const transport = new GatewayRuntimeLocalExecTransport({ temporaryDirectory });
		const spec = await transport.reserve(operation);
		const socketPath = requireValue(
			spec.env[GATEWAY_RUNTIME_LOCAL_EXEC_SOCKET_ENV],
			'local exec socket path',
		);
		const token = requireValue(spec.env[GATEWAY_RUNTIME_LOCAL_EXEC_TOKEN_ENV], 'local exec token');

		const wrongTokenSocket = await connectLocalSocket(socketPath);
		wrongTokenSocket.write(
			encodeGatewayRuntimeLocalExecFrame({ kind: 'authenticate', token: `${token}-wrong` }),
		);
		expect(await readServerFrame(wrongTokenSocket)).toEqual({
			kind: 'rejected',
			message: 'Invalid reservation token.',
		});
		wrongTokenSocket.destroy();

		const firstCandidateSocket = await connectLocalSocket(socketPath);
		const secondCandidateSocket = await connectLocalSocket(socketPath);
		const firstFrame = readServerFrame(firstCandidateSocket);
		const secondFrame = readServerFrame(secondCandidateSocket);
		firstCandidateSocket.write(encodeGatewayRuntimeLocalExecFrame({ kind: 'authenticate', token }));
		secondCandidateSocket.write(
			encodeGatewayRuntimeLocalExecFrame({ kind: 'authenticate', token }),
		);
		const candidateResults = await Promise.all([firstFrame, secondFrame]);
		expect(candidateResults.map((result) => result.kind).toSorted()).toEqual([
			'accepted',
			'rejected',
		]);
		expect(candidateResults.find((result) => result.kind === 'rejected')).toEqual({
			kind: 'rejected',
			message: 'Reservation already consumed.',
		});
		firstCandidateSocket.destroy();
		secondCandidateSocket.destroy();

		await cancelled.promise;
		await transport.finalize(spec.finalizeToken);
		expect(await pathDoesNotExist(dirname(socketPath))).toBe(true);
		await transport.close();
	});

	it('removes private files before reporting a cancellation failure', async () => {
		const temporaryDirectory = await mkdtemp('/tmp/agent-vm-local-exec-cancel-error-');
		const transport = new GatewayRuntimeLocalExecTransport({ temporaryDirectory });
		const expectedError = new Error('cancel failed');
		const operation: GatewayRuntimeLocalExecOperation = {
			cancel: async () => {
				throw expectedError;
			},
			closeStdin: async () => undefined,
			readStderr: async () => ({ kind: 'end' }),
			readStdout: async () => ({ kind: 'end' }),
			wait: async () => ({ exitCode: 0 }),
			writeStdin: async () => undefined,
		};
		const spec = await transport.reserve(operation);
		const socketPath = requireValue(
			spec.env[GATEWAY_RUNTIME_LOCAL_EXEC_SOCKET_ENV],
			'local exec socket path',
		);

		await expect(transport.finalize(spec.finalizeToken)).rejects.toBe(expectedError);
		expect(await pathDoesNotExist(dirname(socketPath))).toBe(true);
		await transport.close();
	});
});
