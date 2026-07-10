import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, rmdir, unlink } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import path from 'node:path';

import type { ReliabilityFaultAuthority } from './reliability-fault-authority.js';
import type { ReliabilityFaultPort } from './reliability-fault-port.js';
import {
	reliabilityFaultApplyRequestSchema,
	reliabilityFaultReceiptSchema,
	type ReliabilityFaultReceipt,
} from './reliability-test-fault-contracts.js';

export const RELIABILITY_FAULT_RUNTIME_DIRECTORY_MODE = 0o700;
export const RELIABILITY_FAULT_SOCKET_MODE = 0o600;
const RELIABILITY_FAULT_MAX_WIRE_BYTES = 16 * 1_024;
const RELIABILITY_FAULT_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export interface ReliabilityFaultSocketPaths {
	readonly runtimeDirectoryMode: typeof RELIABILITY_FAULT_RUNTIME_DIRECTORY_MODE;
	readonly runtimeDirectoryPath: string;
	readonly socketMode: typeof RELIABILITY_FAULT_SOCKET_MODE;
	readonly socketPath: string;
}

interface ReliabilityFaultSocketHarnessOptions {
	readonly authority: ReliabilityFaultAuthority;
	readonly mode: 'production' | 'reliability-test';
	readonly ownedRuntimeDirectory: string;
	readonly port: ReliabilityFaultPort;
	readonly runId: string;
}

export interface ReliabilityFaultSocketHarness {
	readonly paths: ReliabilityFaultSocketPaths;
	close(): Promise<void>;
}

export function resolveReliabilityFaultSocketPaths(
	ownedRuntimeDirectory: string,
	runId: string,
): ReliabilityFaultSocketPaths {
	if (runId.length === 0 || runId.length > 128 || !RELIABILITY_FAULT_RUN_ID_PATTERN.test(runId)) {
		throw new Error('Reliability fault run identifier is invalid.');
	}
	const runtimeDirectoryPath = path.resolve(
		ownedRuntimeDirectory,
		`r-${createHash('sha256').update(runId).digest('hex').slice(0, 12)}`,
	);
	const ownedRuntimeRoot = path.resolve(ownedRuntimeDirectory);
	if (path.dirname(runtimeDirectoryPath) !== ownedRuntimeRoot) {
		throw new Error('Reliability fault runtime directory escaped its owned root.');
	}
	const socketPath = path.join(runtimeDirectoryPath, 'f.sock');
	if (Buffer.byteLength(socketPath) > 100) {
		throw new Error('Reliability fault Unix socket path exceeds the portable length bound.');
	}
	return {
		runtimeDirectoryMode: RELIABILITY_FAULT_RUNTIME_DIRECTORY_MODE,
		runtimeDirectoryPath,
		socketMode: RELIABILITY_FAULT_SOCKET_MODE,
		socketPath,
	};
}

function writeWireReceipt(socket: Socket, receipt: ReliabilityFaultReceipt): void {
	const parsedReceipt = reliabilityFaultReceiptSchema.parse(receipt);
	socket.end(`${JSON.stringify(parsedReceipt)}\n`);
}

function handleFaultSocket(
	socket: Socket,
	authority: ReliabilityFaultAuthority,
	port: ReliabilityFaultPort,
): void {
	let requestBytes = Buffer.alloc(0);
	let settled = false;
	socket.on('data', (chunk: Buffer) => {
		if (settled) {
			return;
		}
		requestBytes = Buffer.concat([requestBytes, chunk]);
		if (requestBytes.byteLength > RELIABILITY_FAULT_MAX_WIRE_BYTES) {
			settled = true;
			socket.end();
			return;
		}
		const delimiterIndex = requestBytes.indexOf(0x0a);
		if (delimiterIndex < 0) {
			return;
		}
		let decoded: unknown;
		try {
			decoded = JSON.parse(requestBytes.subarray(0, delimiterIndex).toString('utf8')) as unknown;
		} catch {
			settled = true;
			socket.end();
			return;
		}
		const parsed = reliabilityFaultApplyRequestSchema.safeParse(decoded);
		if (!parsed.success) {
			settled = true;
			socket.end();
			return;
		}
		settled = true;
		const authorization = authority.authorize(parsed.data);
		if (!authorization.ok) {
			writeWireReceipt(socket, port.refuse(parsed.data, authorization.reason));
			return;
		}
		void port
			.apply(parsed.data)
			.then((receipt) => writeWireReceipt(socket, receipt))
			.catch(() => writeWireReceipt(socket, port.refuse(parsed.data, 'target-unavailable')));
	});
}

async function listenOnUnixSocket(server: Server, socketPath: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(socketPath, () => {
			server.off('error', reject);
			resolve();
		});
	});
}

function isMissingPathError(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function assertOwnedDirectoryWithoutSymlink(directoryPath: string): Promise<void> {
	const directoryStat = await lstat(directoryPath);
	const currentUserId = process.getuid?.();
	if (
		directoryStat.isSymbolicLink() ||
		!directoryStat.isDirectory() ||
		(currentUserId !== undefined && directoryStat.uid !== currentUserId)
	) {
		throw new Error('Reliability fault runtime root is not an owned physical directory.');
	}
}

async function assertPathDoesNotExist(filePath: string): Promise<void> {
	try {
		await lstat(filePath);
	} catch (error) {
		if (isMissingPathError(error)) {
			return;
		}
		throw error;
	}
	throw new Error('Reliability fault runtime path already exists.');
}

export async function startReliabilityFaultSocketHarness(
	options: ReliabilityFaultSocketHarnessOptions,
): Promise<ReliabilityFaultSocketHarness | undefined> {
	if (options.mode !== 'reliability-test') {
		return undefined;
	}
	const paths = resolveReliabilityFaultSocketPaths(options.ownedRuntimeDirectory, options.runId);
	await assertOwnedDirectoryWithoutSymlink(path.resolve(options.ownedRuntimeDirectory));
	await assertPathDoesNotExist(paths.runtimeDirectoryPath);
	await mkdir(paths.runtimeDirectoryPath, {
		mode: paths.runtimeDirectoryMode,
	});
	await chmod(paths.runtimeDirectoryPath, paths.runtimeDirectoryMode);
	await assertOwnedDirectoryWithoutSymlink(paths.runtimeDirectoryPath);
	await assertPathDoesNotExist(paths.socketPath);

	const server = createServer((socket) =>
		handleFaultSocket(socket, options.authority, options.port),
	);
	try {
		await listenOnUnixSocket(server, paths.socketPath);
		await chmod(paths.socketPath, paths.socketMode);
	} catch (error) {
		await unlink(paths.socketPath).catch((unlinkError: unknown) => {
			if (!isMissingPathError(unlinkError)) {
				throw unlinkError;
			}
		});
		await rmdir(paths.runtimeDirectoryPath);
		throw error;
	}

	return {
		paths,
		async close(): Promise<void> {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error === undefined ? resolve() : reject(error)));
			});
			await unlink(paths.socketPath).catch((error: unknown) => {
				if (!isMissingPathError(error)) {
					throw error;
				}
			});
			await rmdir(paths.runtimeDirectoryPath);
		},
	};
}
