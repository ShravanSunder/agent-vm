#!/usr/bin/env node
import { createConnection } from 'node:net';

import {
	GatewayRuntimeLocalExecLineDecoder,
	encodeGatewayRuntimeLocalExecFrame,
	parseGatewayRuntimeLocalExecServerFrame,
	type GatewayRuntimeLocalExecClientFrame,
} from './gateway-runtime-local-exec-protocol.js';
import {
	GATEWAY_RUNTIME_LOCAL_EXEC_SOCKET_ENV,
	GATEWAY_RUNTIME_LOCAL_EXEC_TOKEN_ENV,
} from './gateway-runtime-local-exec-transport.js';

const CONNECTION_DEADLINE_MS = 10_000;

function requireEnvironmentValue(name: string): string {
	const value = process.env[name];
	if (value === undefined || value.length === 0) {
		throw new Error(`Required environment '${name}' is absent.`);
	}
	return value;
}

async function writeProcessOutput(stream: NodeJS.WriteStream, content: Buffer): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		stream.write(content, (error?: Error | null) => {
			if (error === undefined || error === null) resolve();
			else reject(error);
		});
	});
}

async function writeClientFrame(
	socket: ReturnType<typeof createConnection>,
	frame: GatewayRuntimeLocalExecClientFrame,
): Promise<void> {
	if (socket.write(encodeGatewayRuntimeLocalExecFrame(frame))) return;
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

async function run(): Promise<void> {
	const socketPath = requireEnvironmentValue(GATEWAY_RUNTIME_LOCAL_EXEC_SOCKET_ENV);
	const token = requireEnvironmentValue(GATEWAY_RUNTIME_LOCAL_EXEC_TOKEN_ENV);
	const socket = createConnection(socketPath);
	const decoder = new GatewayRuntimeLocalExecLineDecoder();
	let accepted = false;
	let exited = false;
	let inputWrites = Promise.resolve();
	let outputWrites = Promise.resolve();
	const connectionDeadline = setTimeout(
		() => socket.destroy(new Error('Local exec connection deadline expired.')),
		CONNECTION_DEADLINE_MS,
	);
	const cancelAndClose = (): void => {
		process.stdin.destroy();
		if (!socket.destroyed && accepted && !exited) {
			void writeClientFrame(socket, { kind: 'cancel' })
				.catch(() => undefined)
				.finally(() => socket.end());
		}
	};
	process.once('SIGINT', cancelAndClose);
	process.once('SIGTERM', cancelAndClose);

	await new Promise<void>((resolve, reject) => {
		socket.once('connect', () => {
			void writeClientFrame(socket, { kind: 'authenticate', token }).catch(reject);
		});
		socket.on('data', (chunk: Buffer) => {
			try {
				for (const line of decoder.push(chunk)) {
					const frame = parseGatewayRuntimeLocalExecServerFrame(line);
					switch (frame.kind) {
						case 'accepted':
							accepted = true;
							clearTimeout(connectionDeadline);
							process.stdin.on('data', (stdinChunk: Buffer) => {
								if (!socket.destroyed) {
									process.stdin.pause();
									inputWrites = inputWrites.then(
										async () =>
											await writeClientFrame(socket, {
												contentBase64: stdinChunk.toString('base64'),
												kind: 'stdin-chunk',
											}),
									);
									void inputWrites.then(
										() => process.stdin.resume(),
										(error: unknown) => reject(error),
									);
								}
							});
							process.stdin.once('end', () => {
								if (!socket.destroyed) {
									inputWrites = inputWrites.then(
										async () => await writeClientFrame(socket, { kind: 'stdin-end' }),
									);
									void inputWrites.catch(reject);
								}
							});
							continue;
						case 'stdout-chunk':
							outputWrites = outputWrites.then(
								async () =>
									await writeProcessOutput(
										process.stdout,
										Buffer.from(frame.contentBase64, 'base64'),
									),
							);
							continue;
						case 'stderr-chunk':
							outputWrites = outputWrites.then(
								async () =>
									await writeProcessOutput(
										process.stderr,
										Buffer.from(frame.contentBase64, 'base64'),
									),
							);
							continue;
						case 'stdout-end':
						case 'stderr-end':
							continue;
						case 'exited':
							exited = true;
							process.exitCode = frame.exitCode ?? 1;
							void outputWrites.then(resolve, reject);
							continue;
						case 'rejected':
							reject(new Error(frame.message));
							continue;
					}
				}
			} catch (error: unknown) {
				reject(error);
			}
		});
		socket.once('error', reject);
		socket.once('close', () => {
			if (!exited) reject(new Error('Local exec relay closed before an exit result.'));
		});
	});
	clearTimeout(connectionDeadline);
	process.off('SIGINT', cancelAndClose);
	process.off('SIGTERM', cancelAndClose);
	socket.destroy();
}

run().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : 'Local exec helper failed.'}\n`);
	process.exitCode = 1;
});
