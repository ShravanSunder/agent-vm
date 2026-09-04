import { Buffer } from 'node:buffer';
import nodePath from 'node:path';

import {
	Client,
	type ClientChannel,
	type ExecOptions,
	type FileEntry,
	type SFTPWrapper,
	type Stats,
} from 'ssh2';

import { createGatewayRuntimeSandboxPathContract } from './sandbox-path-contract.js';

export interface StrictToolVmSshAccess {
	readonly host: string;
	readonly identityPem: string | undefined;
	readonly knownHostsLine: string | undefined;
	readonly port: number;
	readonly user: string;
}

export interface StrictToolVmSshLimits {
	readonly maxDirectoryEntries: number;
	readonly maxFileBytes: number;
	readonly maxPathDepth: number;
	readonly maxStderrBytes: number;
	readonly maxStdoutBytes: number;
	readonly maxSymlinkDepth: number;
	readonly maxWriteBytes: number;
}

export interface StrictToolVmSshRuntime {
	readonly clock: { readonly now: () => number };
	readonly createSshClient: () => Client;
	readonly scheduler: {
		readonly schedule: (
			callback: () => void,
			delayMilliseconds: number,
		) => { readonly cancel: () => void };
	};
}

export interface StrictToolVmSshFileStat {
	readonly byteLength: number;
	readonly kind: 'directory' | 'file' | 'other' | 'symbolic-link';
}

export type StrictToolVmSshTransportFailure =
	| { readonly kind: 'transport-close' }
	| { readonly kind: 'transport-end' }
	| { readonly kind: 'transport-error' }
	| { readonly kind: 'transport-unresponsive' };

export interface StrictToolVmSshTransportFailureSubscription {
	readonly unsubscribe: () => void;
}

export type StrictToolVmSshProcessTerminalEvent =
	| { readonly exitCode: number; readonly kind: 'exited' }
	| { readonly kind: 'ambiguous' };

export interface StrictToolVmSshProcessChannel {
	readonly endInput: () => void;
	readonly requestCancellation: () => void;
	readonly resizeTerminal: (size: StrictToolVmSshTerminalSize) => void;
	readonly write: (bytes: Uint8Array) => Promise<void>;
}

export interface StrictToolVmSshTerminalSize {
	readonly columns: number;
	readonly rows: number;
}

export interface StrictToolVmSshEnvironmentVariable {
	readonly name: string;
	readonly value: string;
}

export interface StrictToolVmSshDirectShellRequest {
	readonly command: string;
	readonly cwd: string;
	readonly environmentVariables?: readonly StrictToolVmSshEnvironmentVariable[];
	readonly signal?: AbortSignal;
}

export interface StrictToolVmSshOpenProcessChannelRequest {
	readonly argv: readonly string[];
	readonly cwd: string;
	readonly onStderr: (bytes: Uint8Array) => void;
	readonly onStdout: (bytes: Uint8Array) => void;
	readonly onTerminal: (event: StrictToolVmSshProcessTerminalEvent) => void;
	readonly signal?: AbortSignal;
}

export interface StrictToolVmSshOpenShellProcessChannelRequest extends StrictToolVmSshDirectShellRequest {
	readonly onStderr: (bytes: Uint8Array) => void;
	readonly onStdout: (bytes: Uint8Array) => void;
	readonly onTerminal: (event: StrictToolVmSshProcessTerminalEvent) => void;
	readonly terminalSize?: StrictToolVmSshTerminalSize;
}

export interface StrictToolVmSshProcessChannelClient {
	readonly openShellProcessChannel: (
		request: StrictToolVmSshOpenShellProcessChannelRequest,
	) => Promise<StrictToolVmSshProcessChannel>;
	readonly openProcessChannel: (
		request: StrictToolVmSshOpenProcessChannelRequest,
	) => Promise<StrictToolVmSshProcessChannel>;
}

export interface StrictToolVmSshClient {
	readonly close: (options?: { readonly notifyTransportFailure: true }) => void;
	readonly connect: () => Promise<void>;
	readonly execute: (request: {
		readonly argv: readonly string[];
		readonly cwd: string;
		readonly deadlineMilliseconds?: number;
		readonly maximumStdinBytes?: number;
		readonly output?: {
			readonly stderr: StrictToolVmSshExecutionOutputPolicy;
			readonly stdout: StrictToolVmSshExecutionOutputPolicy;
		};
		readonly signal?: AbortSignal;
		readonly stdin?: Uint8Array;
	}) => Promise<{
		readonly exitCode: number;
		readonly kind: 'exited';
		readonly stderr: Uint8Array;
		readonly stderrTruncated?: boolean;
		readonly stdout: Uint8Array;
		readonly stdoutTruncated?: boolean;
	}>;
	readonly guestListDirectory: (request: {
		readonly path: string;
	}) => Promise<readonly FileEntry[]>;
	readonly guestMkdir: (request: { readonly path: string }) => Promise<void>;
	readonly guestReadFile: (request: { readonly path: string }) => Promise<Uint8Array>;
	readonly guestRemove: (request: {
		readonly kind: 'directory' | 'file';
		readonly path: string;
	}) => Promise<void>;
	readonly guestRename: (request: {
		readonly fromPath: string;
		readonly toPath: string;
	}) => Promise<void>;
	readonly guestStat: (request: { readonly path: string }) => Promise<StrictToolVmSshFileStat>;
	readonly guestWriteFile: (request: {
		readonly bytes: Uint8Array;
		readonly path: string;
	}) => Promise<void>;
	readonly listDirectory: (request: { readonly path: string }) => Promise<readonly FileEntry[]>;
	readonly mkdir: (request: { readonly path: string }) => Promise<void>;
	readonly observeTransportFailure: (
		observer: (failure: StrictToolVmSshTransportFailure) => void,
	) => StrictToolVmSshTransportFailureSubscription;
	readonly readFile: (request: { readonly path: string }) => Promise<Uint8Array>;
	readonly remove: (request: {
		readonly kind: 'directory' | 'file';
		readonly path: string;
	}) => Promise<void>;
	readonly rename: (request: {
		readonly fromPath: string;
		readonly toPath: string;
	}) => Promise<void>;
	readonly stat: (request: { readonly path: string }) => Promise<StrictToolVmSshFileStat>;
	readonly writeFile: (request: {
		readonly bytes: Uint8Array;
		readonly path: string;
	}) => Promise<void>;
}

export interface StrictToolVmSshExecutionOutputPolicy {
	readonly captureBytes: number;
	readonly overflow: 'fail' | 'truncate';
}

export interface CreateStrictToolVmSshClientOptions {
	readonly access: StrictToolVmSshAccess;
	readonly deadlineMilliseconds: {
		readonly connect: number;
		readonly operation: number;
	};
	readonly defaultExecuteOutputBytes?: {
		readonly stderr: number;
		readonly stdout: number;
	};
	readonly limits: StrictToolVmSshLimits;
	readonly maximumPerCallExecuteOutputBytes?: {
		readonly stderr: number;
		readonly stdout: number;
	};
	readonly runtime: StrictToolVmSshRuntime;
}

export function createStrictToolVmSshTransport(): Client {
	return new Client();
}

interface StrictHostKeyPin {
	readonly identityPem: string;
	readonly rawKey: Buffer;
}

interface DeadlineHandle {
	readonly cancel: () => void;
}

interface SftpOperationAdmissionGate {
	readonly promise: Promise<void>;
	readonly release: () => void;
}

interface SftpChannelCloseObserver {
	readonly endAndWait: () => Promise<void>;
}

function createSftpOperationAdmissionGate(): SftpOperationAdmissionGate {
	let release: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	if (release === undefined) {
		throw new Error('Strict SSH SFTP operation admission gate was not initialized.');
	}
	return { promise, release };
}

function observeSftpChannelClose(sftp: SFTPWrapper): SftpChannelCloseObserver {
	let channelClosed = false;
	const channelClose = new Promise<void>((resolve) => {
		sftp.once('close', (): void => {
			channelClosed = true;
			resolve();
		});
	});
	return {
		endAndWait: async (): Promise<void> => {
			if (!channelClosed) sftp.end();
			await channelClose;
		},
	};
}

function quotePosixShellToken(token: string): string {
	return `'${token.replaceAll("'", `'"'"'`)}'`;
}

export function encodePosixShellArgv(argv: readonly string[]): string {
	return argv.map(quotePosixShellToken).join(' ');
}

function requireGuestAbsoluteCwd(candidate: string): string {
	if (!nodePath.posix.isAbsolute(candidate) || candidate.includes('\0')) {
		throw new Error('Strict SSH direct shell requires a NUL-free guest-absolute cwd.');
	}
	return nodePath.posix.normalize(candidate);
}

function requireGuestAbsolutePath(candidate: string): string {
	if (candidate.includes('\0')) {
		throw new Error('Strict SSH direct filesystem path must not contain NUL.');
	}
	if (!nodePath.posix.isAbsolute(candidate)) {
		throw new Error('Strict SSH direct filesystem path must be guest-absolute.');
	}
	return nodePath.posix.normalize(candidate);
}

function requireDirectShellCommand(command: string): void {
	if (command.length === 0 || command.includes('\0')) {
		throw new Error('Strict SSH direct shell requires a non-empty NUL-free command.');
	}
}

function directShellExecCommand(request: StrictToolVmSshDirectShellRequest): string {
	requireDirectShellCommand(request.command);
	const cwd = requireGuestAbsoluteCwd(request.cwd);
	const environmentAssignments = directShellEnvironmentAssignments(request);
	return encodePosixShellArgv([
		'/bin/sh',
		'-c',
		'cd -- "$1" && shift && exec "$@"',
		'agent-vm-sandbox',
		cwd,
		...(environmentAssignments.length === 0 ? [] : ['/usr/bin/env', ...environmentAssignments]),
		'/bin/sh',
		'-lc',
		request.command,
	]);
}

function directShellEnvironmentAssignments(
	request: StrictToolVmSshDirectShellRequest,
): readonly string[] {
	const environmentVariables = request.environmentVariables ?? [];
	const environmentVariableNames = new Set<string>();
	for (const variable of environmentVariables) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(variable.name) || variable.value.includes('\0')) {
			throw new Error('Strict SSH direct shell environment is invalid.');
		}
		if (environmentVariableNames.has(variable.name)) {
			throw new Error('Strict SSH direct shell environment contains a duplicate name.');
		}
		environmentVariableNames.add(variable.name);
	}
	return environmentVariables.map((variable) => `${variable.name}=${variable.value}`);
}

function requireTerminalSize(size: StrictToolVmSshTerminalSize): void {
	requirePositiveSafeInteger(size.columns, 'terminal column count');
	requirePositiveSafeInteger(size.rows, 'terminal row count');
}

function requirePositiveSafeInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`Strict SSH ${name} must be a positive safe integer.`);
	}
}

function requireNonNegativeSafeInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`Strict SSH ${name} must be a non-negative safe integer.`);
	}
}

function parseStrictHostKeyPin(access: StrictToolVmSshAccess): StrictHostKeyPin {
	if (
		access.host.length === 0 ||
		access.user.length === 0 ||
		access.identityPem === undefined ||
		access.identityPem.length === 0 ||
		access.knownHostsLine === undefined ||
		access.knownHostsLine.length === 0 ||
		access.knownHostsLine.includes('\n') ||
		access.knownHostsLine.includes('\r')
	) {
		throw new Error(
			'Strict SSH access requires one complete controller-authored identity and pin.',
		);
	}
	const fields = access.knownHostsLine.split(' ');
	if (fields.length !== 3 || fields[0] !== access.host || fields[1] !== 'ssh-ed25519') {
		throw new Error('Strict SSH access requires one exact ssh-ed25519 known_hosts entry.');
	}
	const encodedKey = fields[2];
	if (encodedKey === undefined || encodedKey.length === 0) {
		throw new Error('Strict SSH access requires an encoded ssh-ed25519 key.');
	}
	const rawKey = Buffer.from(encodedKey, 'base64');
	if (rawKey.length === 0 || rawKey.toString('base64') !== encodedKey) {
		throw new Error('Strict SSH access contains a malformed host-key pin.');
	}
	let offset = 0;
	const readSshField = (): Buffer => {
		if (offset + 4 > rawKey.length) throw new Error('Strict SSH access host-key pin is truncated.');
		const fieldLength = rawKey.readUInt32BE(offset);
		offset += 4;
		if (offset + fieldLength > rawKey.length) {
			throw new Error('Strict SSH access host-key pin is truncated.');
		}
		const field = rawKey.subarray(offset, offset + fieldLength);
		offset += fieldLength;
		return field;
	};
	const algorithm = readSshField();
	const publicKey = readSshField();
	if (
		offset !== rawKey.length ||
		algorithm.toString('ascii') !== 'ssh-ed25519' ||
		publicKey.byteLength !== 32
	) {
		throw new Error('Strict SSH access host-key pin is not a raw ssh-ed25519 key.');
	}
	return { identityPem: access.identityPem, rawKey };
}

function beginDeadline(options: {
	readonly delayMilliseconds: number;
	readonly onExpire: () => void;
	readonly runtime: StrictToolVmSshRuntime;
}): DeadlineHandle {
	const startedAt = options.runtime.clock.now();
	if (!Number.isFinite(startedAt)) {
		throw new Error('Strict SSH monotonic clock returned a non-finite value.');
	}
	return options.runtime.scheduler.schedule(options.onExpire, options.delayMilliseconds);
}

function appendExecutionOutput(options: {
	readonly chunks: Buffer[];
	readonly chunk: Buffer;
	readonly currentBytes: number;
	readonly policy: StrictToolVmSshExecutionOutputPolicy;
}): { readonly nextBytes: number; readonly overflow: boolean } {
	const nextBytes = options.currentBytes + options.chunk.byteLength;
	const remainingBytes = Math.max(0, options.policy.captureBytes - options.currentBytes);
	if (remainingBytes > 0) options.chunks.push(options.chunk.subarray(0, remainingBytes));
	return { nextBytes, overflow: nextBytes > options.policy.captureBytes };
}

function promisifySftp<TValue>(
	invoke: (callback: (error: Error | undefined, value: TValue) => void) => void,
): Promise<TValue> {
	return new Promise<TValue>((resolve, reject) => {
		invoke((error, value) => {
			if (error !== undefined) {
				reject(new Error('Strict SSH SFTP operation failed.', { cause: error }));
				return;
			}
			resolve(value);
		});
	});
}

function promisifySftpVoid(
	invoke: (callback: (error?: Error | null) => void) => void,
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		invoke((error) => {
			if (error !== undefined && error !== null) {
				reject(new Error('Strict SSH SFTP operation failed.', { cause: error }));
				return;
			}
			resolve();
		});
	});
}

function isMissingSftpPathError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const code: unknown = Reflect.get(error, 'code');
	return code === 2 || code === 'ENOENT' || isMissingSftpPathError(error.cause);
}

export function createStrictToolVmSshClient(
	options: CreateStrictToolVmSshClientOptions,
): StrictToolVmSshClient & StrictToolVmSshProcessChannelClient {
	requirePositiveSafeInteger(options.access.port, 'port');
	requirePositiveSafeInteger(options.deadlineMilliseconds.connect, 'connect deadline');
	requirePositiveSafeInteger(options.deadlineMilliseconds.operation, 'operation deadline');
	requirePositiveSafeInteger(options.limits.maxDirectoryEntries, 'directory-entry limit');
	requirePositiveSafeInteger(options.limits.maxFileBytes, 'file-byte limit');
	requirePositiveSafeInteger(options.limits.maxPathDepth, 'path-depth limit');
	requirePositiveSafeInteger(options.limits.maxStderrBytes, 'stderr limit');
	requirePositiveSafeInteger(options.limits.maxStdoutBytes, 'stdout limit');
	requireNonNegativeSafeInteger(options.limits.maxSymlinkDepth, 'symlink-depth limit');
	requirePositiveSafeInteger(options.limits.maxWriteBytes, 'write-byte limit');
	if (options.defaultExecuteOutputBytes !== undefined) {
		requirePositiveSafeInteger(
			options.defaultExecuteOutputBytes.stderr,
			'default execute stderr limit',
		);
		requirePositiveSafeInteger(
			options.defaultExecuteOutputBytes.stdout,
			'default execute stdout limit',
		);
	}
	if (options.maximumPerCallExecuteOutputBytes !== undefined) {
		requirePositiveSafeInteger(
			options.maximumPerCallExecuteOutputBytes.stderr,
			'maximum per-call execute stderr limit',
		);
		requirePositiveSafeInteger(
			options.maximumPerCallExecuteOutputBytes.stdout,
			'maximum per-call execute stdout limit',
		);
	}

	const pathContract = createGatewayRuntimeSandboxPathContract({
		guestWorkRoot: '/work',
		limits: {
			maxBytes: options.limits.maxFileBytes,
			maxDepth: options.limits.maxPathDepth,
			maxElapsedMs: options.deadlineMilliseconds.operation,
			maxEntries: options.limits.maxDirectoryEntries,
			maxSymlinkDepth: options.limits.maxSymlinkDepth,
		},
	});
	let connected = false;
	let closeRequested = false;
	let connectionPromise: Promise<void> | undefined;
	let observedTransportFailure: StrictToolVmSshTransportFailure | undefined;
	let transport: Client | undefined;
	const processChannelTransportFailureObservers = new Set<() => void>();
	const transportFailureObservers = new Set<(failure: StrictToolVmSshTransportFailure) => void>();
	const publishConnectedTransportFailure = (failure: StrictToolVmSshTransportFailure): void => {
		if (closeRequested || observedTransportFailure !== undefined) return;
		observedTransportFailure = failure;
		connected = false;
		for (const observer of processChannelTransportFailureObservers) {
			try {
				observer();
			} catch {}
		}
		for (const observer of transportFailureObservers) {
			try {
				observer(failure);
			} catch {}
		}
	};
	const onConnectedTransportError = (): void =>
		publishConnectedTransportFailure({ kind: 'transport-error' });
	const onConnectedTransportEnd = (): void =>
		publishConnectedTransportFailure({ kind: 'transport-end' });
	const onConnectedTransportClose = (): void =>
		publishConnectedTransportFailure({ kind: 'transport-close' });

	const requireConnectedTransport = (): Client => {
		if (!connected || transport === undefined) {
			throw new Error('Strict SSH client is not connected.');
		}
		return transport;
	};

	const connect = (): Promise<void> => {
		if (connectionPromise !== undefined) {
			if (observedTransportFailure !== undefined || closeRequested) {
				return Promise.reject(new Error('Strict SSH connection is no longer usable.'));
			}
			return connectionPromise;
		}
		connectionPromise = new Promise<void>((resolve, reject) => {
			let hostKeyPin: StrictHostKeyPin;
			try {
				hostKeyPin = parseStrictHostKeyPin(options.access);
			} catch (error: unknown) {
				reject(error);
				return;
			}
			const client = options.runtime.createSshClient();
			transport = client;
			closeRequested = false;
			observedTransportFailure = undefined;
			let settled = false;
			const deadline = beginDeadline({
				delayMilliseconds: options.deadlineMilliseconds.connect,
				onExpire: (): void => {
					if (settled) return;
					settled = true;
					client.destroy();
					reject(new Error('Strict SSH connection deadline expired.'));
				},
				runtime: options.runtime,
			});
			const onError = (): void => {
				if (settled) return;
				settled = true;
				deadline.cancel();
				reject(new Error('Strict SSH transport rejected the connection.'));
			};
			const onReady = (): void => {
				if (settled) return;
				settled = true;
				connected = true;
				deadline.cancel();
				client.off('error', onError);
				client.on('error', onConnectedTransportError);
				client.on('end', onConnectedTransportEnd);
				client.on('close', onConnectedTransportClose);
				resolve();
			};
			client.once('error', onError);
			client.once('ready', onReady);
			client.connect({
				algorithms: { serverHostKey: ['ssh-ed25519'] },
				host: options.access.host,
				hostVerifier: (presentedKey: Buffer): boolean => presentedKey.equals(hostKeyPin.rawKey),
				port: options.access.port,
				privateKey: hostKeyPin.identityPem,
				username: options.access.user,
			});
		});
		return connectionPromise;
	};

	const executeCommand = async (request: {
		readonly command: string;
		readonly deadlineMilliseconds?: number;
		readonly execOptions: ExecOptions;
		readonly maximumStdinBytes?: number;
		readonly output?: {
			readonly stderr: StrictToolVmSshExecutionOutputPolicy;
			readonly stdout: StrictToolVmSshExecutionOutputPolicy;
		};
		readonly signal?: AbortSignal;
		readonly stdin?: Uint8Array;
	}): ReturnType<StrictToolVmSshClient['execute']> => {
		const client = requireConnectedTransport();
		const deadlineMilliseconds =
			request.deadlineMilliseconds ?? options.deadlineMilliseconds.operation;
		if (
			!Number.isSafeInteger(deadlineMilliseconds) ||
			deadlineMilliseconds <= 0 ||
			deadlineMilliseconds > 28_800_000
		) {
			throw new Error('Strict SSH execution deadline is outside the supported range.');
		}
		const maximumStdinBytes = request.maximumStdinBytes ?? options.limits.maxWriteBytes;
		if (
			!Number.isSafeInteger(maximumStdinBytes) ||
			maximumStdinBytes <= 0 ||
			maximumStdinBytes > 1_048_576
		) {
			throw new Error('Strict SSH execute stdin limit is outside the supported range.');
		}
		if (request.stdin !== undefined && request.stdin.byteLength > maximumStdinBytes) {
			throw new Error('Strict SSH write byte limit exceeded.');
		}
		const stderrPolicy = request.output?.stderr ?? {
			captureBytes: options.defaultExecuteOutputBytes?.stderr ?? options.limits.maxStderrBytes,
			overflow: 'fail' as const,
		};
		const stdoutPolicy = request.output?.stdout ?? {
			captureBytes: options.defaultExecuteOutputBytes?.stdout ?? options.limits.maxStdoutBytes,
			overflow: 'fail' as const,
		};
		for (const [name, policy, maximumBytes] of [
			[
				'stderr',
				stderrPolicy,
				request.output === undefined
					? options.limits.maxStderrBytes
					: (options.maximumPerCallExecuteOutputBytes?.stderr ?? options.limits.maxStderrBytes),
			],
			[
				'stdout',
				stdoutPolicy,
				request.output === undefined
					? options.limits.maxStdoutBytes
					: (options.maximumPerCallExecuteOutputBytes?.stdout ?? options.limits.maxStdoutBytes),
			],
		] as const) {
			if (
				!Number.isSafeInteger(policy.captureBytes) ||
				policy.captureBytes <= 0 ||
				policy.captureBytes > maximumBytes
			) {
				throw new Error(`Strict SSH ${name} capture limit is outside the supported range.`);
			}
		}
		return await new Promise((resolve, reject) => {
			let channel: ClientChannel | undefined;
			let exitCode: number | null | undefined;
			let settled = false;
			let stderrBytes = 0;
			let stderrTruncated = false;
			let stdoutBytes = 0;
			let stdoutTruncated = false;
			const stderrChunks: Buffer[] = [];
			const stdoutChunks: Buffer[] = [];
			const finishRejected = (error: Error, closeChannel: boolean): void => {
				if (settled) return;
				settled = true;
				deadline.cancel();
				request.signal?.removeEventListener('abort', onAbort);
				if (closeChannel) channel?.close();
				reject(error);
			};
			const onAbort = (): void =>
				finishRejected(new Error('Strict SSH operation was cancelled.'), true);
			const deadline = beginDeadline({
				delayMilliseconds: deadlineMilliseconds,
				onExpire: (): void =>
					finishRejected(new Error('Strict SSH operation deadline expired.'), true),
				runtime: options.runtime,
			});
			if (request.signal?.aborted === true) {
				onAbort();
				return;
			}
			request.signal?.addEventListener('abort', onAbort, { once: true });
			client.exec(request.command, request.execOptions, (error, openedChannel) => {
				if (settled) {
					openedChannel?.close();
					return;
				}
				if (error !== undefined) {
					finishRejected(new Error('Strict SSH command dispatch failed.'), false);
					return;
				}
				channel = openedChannel;
				openedChannel.on('data', (chunk: Buffer): void => {
					const appended = appendExecutionOutput({
						chunk,
						chunks: stdoutChunks,
						currentBytes: stdoutBytes,
						policy: stdoutPolicy,
					});
					stdoutBytes = appended.nextBytes;
					stdoutTruncated ||= appended.overflow;
					if (appended.overflow && stdoutPolicy.overflow === 'fail') {
						finishRejected(new Error('Strict SSH stdout output limit exceeded.'), true);
					}
				});
				openedChannel.stderr.on('data', (chunk: Buffer): void => {
					const appended = appendExecutionOutput({
						chunk,
						chunks: stderrChunks,
						currentBytes: stderrBytes,
						policy: stderrPolicy,
					});
					stderrBytes = appended.nextBytes;
					stderrTruncated ||= appended.overflow;
					if (appended.overflow && stderrPolicy.overflow === 'fail') {
						finishRejected(new Error('Strict SSH stderr output limit exceeded.'), true);
					}
				});
				openedChannel.once('error', (): void => {
					finishRejected(new Error('Strict SSH command channel failed.'), true);
				});
				openedChannel.once('exit', (code: number | null): void => {
					exitCode = code;
				});
				openedChannel.once('close', (): void => {
					if (settled) return;
					if (typeof exitCode !== 'number') {
						finishRejected(new Error('Strict SSH command closed without an exit result.'), false);
						return;
					}
					settled = true;
					deadline.cancel();
					request.signal?.removeEventListener('abort', onAbort);
					resolve({
						exitCode,
						kind: 'exited',
						stderr: Buffer.concat(stderrChunks),
						...(stderrTruncated ? { stderrTruncated: true } : {}),
						stdout: Buffer.concat(stdoutChunks),
						...(stdoutTruncated ? { stdoutTruncated: true } : {}),
					});
				});
				const writeInput = async (): Promise<void> => {
					if (request.stdin !== undefined && request.stdin.byteLength > 0) {
						const writable = openedChannel.write(request.stdin);
						if (!writable) {
							await new Promise<void>((drained) => openedChannel.once('drain', drained));
						}
					}
					openedChannel.end();
				};
				void writeInput().catch((): void => {
					finishRejected(new Error('Strict SSH command input failed.'), true);
				});
			});
		});
	};
	const execute: StrictToolVmSshClient['execute'] = async (request) => {
		if (
			request.argv.length === 0 ||
			request.argv.some((token) => token.length === 0 || token.includes('\0'))
		) {
			throw new Error('Strict SSH execute requires non-empty NUL-free argv tokens.');
		}
		const pathResolution = pathContract.resolve(request.cwd);
		if (pathResolution.kind === 'rejected') {
			throw new Error(
				`Strict SSH execute requires a work-relative path (${pathResolution.reason}).`,
			);
		}
		return await executeCommand({
			command: `cd -- ${quotePosixShellToken(pathResolution.guestPath)} && exec -- ${encodePosixShellArgv(request.argv)}`,
			...(request.deadlineMilliseconds === undefined
				? {}
				: { deadlineMilliseconds: request.deadlineMilliseconds }),
			execOptions: {},
			...(request.maximumStdinBytes === undefined
				? {}
				: { maximumStdinBytes: request.maximumStdinBytes }),
			...(request.output === undefined ? {} : { output: request.output }),
			...(request.signal === undefined ? {} : { signal: request.signal }),
			...(request.stdin === undefined ? {} : { stdin: request.stdin }),
		});
	};

	const openCommandProcessChannel = async (request: {
		readonly command: string;
		readonly execOptions: ExecOptions;
		readonly onStderr: (bytes: Uint8Array) => void;
		readonly onStdout: (bytes: Uint8Array) => void;
		readonly onTerminal: (event: StrictToolVmSshProcessTerminalEvent) => void;
		readonly signal?: AbortSignal;
		readonly terminalAllocated: boolean;
	}): Promise<StrictToolVmSshProcessChannel> => {
		const client = requireConnectedTransport();
		return await new Promise<StrictToolVmSshProcessChannel>((resolve, reject) => {
			let openingSettled = false;
			const finishOpeningRejected = (error: Error): void => {
				if (openingSettled) return;
				openingSettled = true;
				deadline.cancel();
				request.signal?.removeEventListener('abort', onAbort);
				reject(error);
			};
			const onAbort = (): void =>
				finishOpeningRejected(new Error('Strict SSH process open was cancelled.'));
			const deadline = beginDeadline({
				delayMilliseconds: options.deadlineMilliseconds.operation,
				onExpire: (): void => {
					finishOpeningRejected(new Error('Strict SSH process open deadline expired.'));
					publishConnectedTransportFailure({ kind: 'transport-unresponsive' });
				},
				runtime: options.runtime,
			});
			if (request.signal?.aborted === true) {
				onAbort();
				return;
			}
			request.signal?.addEventListener('abort', onAbort, { once: true });
			client.exec(request.command, request.execOptions, (error, openedChannel) => {
				if (openingSettled) {
					openedChannel?.close();
					return;
				}
				if (error !== undefined || openedChannel === undefined) {
					finishOpeningRejected(new Error('Strict SSH process dispatch failed.'));
					return;
				}
				openingSettled = true;
				deadline.cancel();
				request.signal?.removeEventListener('abort', onAbort);

				let cancellationRequested = false;
				let exitCode: number | null | undefined;
				let inputEnded = false;
				let stderrBytes = 0;
				let stdoutBytes = 0;
				let terminalObserved = false;
				const pendingDrainWaiters = new Set<{
					readonly onDrain: () => void;
					readonly reject: (error: Error) => void;
				}>();
				const closeChannelOnce = (): void => {
					if (cancellationRequested) return;
					cancellationRequested = true;
					openedChannel.close();
				};
				const requestChannelCancellation = (): void => {
					if (terminalObserved) return;
					closeChannelOnce();
				};
				const observeTerminal = (event: StrictToolVmSshProcessTerminalEvent): void => {
					if (terminalObserved) return;
					terminalObserved = true;
					processChannelTransportFailureObservers.delete(onTransportError);
					const terminalError = new Error('Strict SSH process channel is terminal.');
					for (const waiter of pendingDrainWaiters) {
						openedChannel.off('drain', waiter.onDrain);
						waiter.reject(terminalError);
					}
					pendingDrainWaiters.clear();
					try {
						request.onTerminal(event);
					} catch {
						return;
					}
				};
				const onTransportError = (): void => {
					observeTerminal(
						typeof exitCode === 'number' ? { exitCode, kind: 'exited' } : { kind: 'ambiguous' },
					);
					closeChannelOnce();
				};
				const deliverBoundedOutput = (output: {
					readonly bytes: Buffer;
					readonly currentBytes: number;
					readonly maximumBytes: number;
					readonly onOutput: (bytes: Uint8Array) => void;
				}): number => {
					if (terminalObserved) return output.currentBytes;
					const nextBytes = output.currentBytes + output.bytes.byteLength;
					if (nextBytes > output.maximumBytes) {
						observeTerminal({ kind: 'ambiguous' });
						closeChannelOnce();
						return output.currentBytes;
					}
					try {
						output.onOutput(Buffer.from(output.bytes));
					} catch {
						observeTerminal({ kind: 'ambiguous' });
						closeChannelOnce();
						return output.currentBytes;
					}
					return nextBytes;
				};
				openedChannel.on('data', (chunk: Buffer): void => {
					stdoutBytes = deliverBoundedOutput({
						bytes: chunk,
						currentBytes: stdoutBytes,
						maximumBytes: options.limits.maxStdoutBytes,
						onOutput: request.onStdout,
					});
				});
				openedChannel.stderr.on('data', (chunk: Buffer): void => {
					stderrBytes = deliverBoundedOutput({
						bytes: chunk,
						currentBytes: stderrBytes,
						maximumBytes: options.limits.maxStderrBytes,
						onOutput: request.onStderr,
					});
				});
				openedChannel.once('error', (): void => {
					observeTerminal(
						typeof exitCode === 'number' ? { exitCode, kind: 'exited' } : { kind: 'ambiguous' },
					);
					closeChannelOnce();
				});
				openedChannel.once('exit', (code: number | null): void => {
					exitCode = code;
				});
				openedChannel.once('close', (): void => {
					observeTerminal(
						typeof exitCode === 'number' ? { exitCode, kind: 'exited' } : { kind: 'ambiguous' },
					);
				});
				processChannelTransportFailureObservers.add(onTransportError);
				resolve({
					endInput: (): void => {
						if (inputEnded || terminalObserved) return;
						inputEnded = true;
						openedChannel.end();
					},
					requestCancellation: requestChannelCancellation,
					resizeTerminal: (size): void => {
						if (!request.terminalAllocated || terminalObserved) {
							throw new Error('Strict SSH process does not have an active terminal.');
						}
						requireTerminalSize(size);
						openedChannel.setWindow(size.rows, size.columns, 0, 0);
					},
					write: async (bytes): Promise<void> => {
						if (terminalObserved) {
							throw new Error('Strict SSH process channel is terminal.');
						}
						if (inputEnded) {
							throw new Error('Strict SSH process input is closed.');
						}
						if (cancellationRequested) {
							throw new Error('Strict SSH process cancellation was requested.');
						}
						if (bytes.byteLength > options.limits.maxWriteBytes) {
							throw new Error('Strict SSH process write byte limit exceeded.');
						}
						if (openedChannel.write(Buffer.from(bytes))) return;
						await new Promise<void>((drained, rejectDrain) => {
							const waiter = {
								onDrain: (): void => {
									pendingDrainWaiters.delete(waiter);
									drained();
								},
								reject: rejectDrain,
							};
							pendingDrainWaiters.add(waiter);
							openedChannel.once('drain', waiter.onDrain);
						});
					},
				});
			});
		});
	};
	const openProcessChannel: StrictToolVmSshProcessChannelClient['openProcessChannel'] = async (
		request,
	) => {
		if (
			request.argv.length === 0 ||
			request.argv.some((token) => token.length === 0 || token.includes('\0'))
		) {
			throw new Error('Strict SSH process requires non-empty NUL-free argv tokens.');
		}
		const pathResolution = pathContract.resolve(request.cwd);
		if (pathResolution.kind === 'rejected') {
			throw new Error(
				`Strict SSH process requires a work-relative path (${pathResolution.reason}).`,
			);
		}
		return await openCommandProcessChannel({
			command: `cd -- ${quotePosixShellToken(pathResolution.guestPath)} && exec -- ${encodePosixShellArgv(request.argv)}`,
			execOptions: {},
			onStderr: request.onStderr,
			onStdout: request.onStdout,
			onTerminal: request.onTerminal,
			...(request.signal === undefined ? {} : { signal: request.signal }),
			terminalAllocated: false,
		});
	};
	const openShellProcessChannel: StrictToolVmSshProcessChannelClient['openShellProcessChannel'] =
		async (request) => {
			const execOptions: ExecOptions = {};
			if (request.terminalSize !== undefined) {
				requireTerminalSize(request.terminalSize);
				execOptions.pty = {
					cols: request.terminalSize.columns,
					height: 0,
					rows: request.terminalSize.rows,
					width: 0,
				};
			}
			return await openCommandProcessChannel({
				command: directShellExecCommand(request),
				execOptions,
				onStderr: request.onStderr,
				onStdout: request.onStdout,
				onTerminal: request.onTerminal,
				...(request.signal === undefined ? {} : { signal: request.signal }),
				terminalAllocated: request.terminalSize !== undefined,
			});
		};

	const getSftp = async (): Promise<SFTPWrapper> => {
		const client = requireConnectedTransport();
		return await promisifySftp<SFTPWrapper>((callback) => client.sftp(callback));
	};
	let sftpOperationAdmission = Promise.resolve();
	const authorizeRemotePath = async (
		sftp: SFTPWrapper,
		requestedPath: string,
	): Promise<{
		readonly depth: number;
		readonly guestPath: string;
		readonly startedAt: number;
		readonly symlinkDepth: number;
	}> => {
		const resolution = pathContract.resolve(requestedPath);
		if (resolution.kind === 'rejected') {
			throw new Error(`Strict SSH requires a work-relative path (${resolution.reason}).`);
		}
		const components = resolution.relativePath === '' ? [] : resolution.relativePath.split('/');
		if (components.length > options.limits.maxPathDepth) {
			throw new Error('Strict SSH filesystem depth limit exceeded.');
		}
		const startedAt = options.runtime.clock.now();
		let symlinkDepth = 0;
		for (let componentIndex = 0; componentIndex < components.length; componentIndex += 1) {
			const componentPath = `/work/${components.slice(0, componentIndex + 1).join('/')}`;
			// oxlint-disable-next-line no-await-in-loop -- Each component must be fenced in path order before the next component is inspected.
			const stats = await promisifySftp<Stats>((callback) => sftp.lstat(componentPath, callback));
			if (stats.isSymbolicLink()) symlinkDepth += 1;
			if (symlinkDepth > options.limits.maxSymlinkDepth) {
				throw new Error('Strict SSH filesystem symlink limit exceeded.');
			}
			// oxlint-disable-next-line no-await-in-loop -- Realpath evidence for this component is required before traversing deeper.
			const realPath = await promisifySftp<string>((callback) =>
				sftp.realpath(componentPath, callback),
			);
			if (realPath !== '/work' && !realPath.startsWith('/work/')) {
				throw new Error('Strict SSH symlink resolved outside /work.');
			}
		}
		return { depth: components.length, guestPath: resolution.guestPath, startedAt, symlinkDepth };
	};
	const runSftpOperation = async <TValue>(
		operation: (sftp: SFTPWrapper) => Promise<TValue>,
	): Promise<TValue> => {
		const client = requireConnectedTransport();
		const precedingAdmission = sftpOperationAdmission;
		const nextAdmission = createSftpOperationAdmissionGate();
		sftpOperationAdmission = nextAdmission.promise;
		return await new Promise<TValue>((resolve, reject) => {
			let deadline: DeadlineHandle | undefined;
			let settled = false;
			void (async (): Promise<TValue> => {
				await precedingAdmission;
				if (settled) throw new Error('Strict SSH SFTP operation deadline expired.');
				deadline = beginDeadline({
					delayMilliseconds: options.deadlineMilliseconds.operation,
					onExpire: (): void => {
						if (settled) return;
						settled = true;
						client.destroy();
						reject(new Error('Strict SSH SFTP operation deadline expired.'));
					},
					runtime: options.runtime,
				});
				const sftp = await getSftp();
				const channelClose = observeSftpChannelClose(sftp);
				if (settled) {
					await channelClose.endAndWait();
					throw new Error('Strict SSH SFTP operation deadline expired.');
				}
				try {
					return await operation(sftp);
				} finally {
					await channelClose.endAndWait();
				}
			})()
				.finally(nextAdmission.release)
				.then(
					(value): void => {
						if (settled) return;
						settled = true;
						deadline?.cancel();
						resolve(value);
					},
					(error: unknown): void => {
						if (settled) return;
						settled = true;
						deadline?.cancel();
						reject(
							error instanceof Error && error.message.startsWith('Strict SSH')
								? error
								: new Error('Strict SSH SFTP operation failed.'),
						);
					},
				);
		});
	};
	const authorizeMutationTarget = async (
		sftp: SFTPWrapper,
		requestedPath: string,
	): Promise<string> => {
		const resolution = pathContract.resolve(requestedPath);
		if (resolution.kind === 'rejected' || resolution.relativePath === '') {
			throw new Error('Strict SSH mutation requires a non-root work-relative path.');
		}
		const components = resolution.relativePath.split('/');
		if (components.length > options.limits.maxPathDepth) {
			throw new Error('Strict SSH filesystem depth limit exceeded.');
		}
		await authorizeRemotePath(sftp, components.slice(0, -1).join('/'));
		try {
			await authorizeRemotePath(sftp, resolution.relativePath);
		} catch (error: unknown) {
			if (!isMissingSftpPathError(error)) throw error;
		}
		return resolution.guestPath;
	};
	const authorizeExistingMutationPath = async (
		sftp: SFTPWrapper,
		requestedPath: string,
	): Promise<string> => {
		const resolution = pathContract.resolve(requestedPath);
		if (resolution.kind === 'rejected' || resolution.relativePath === '') {
			throw new Error('Strict SSH mutation requires a non-root work-relative path.');
		}
		return (await authorizeRemotePath(sftp, resolution.relativePath)).guestPath;
	};
	const guestStat = async (
		sftp: SFTPWrapper,
		requestedPath: string,
	): Promise<StrictToolVmSshFileStat> => {
		const guestPath = requireGuestAbsolutePath(requestedPath);
		const stats = await promisifySftp<Stats>((callback) => sftp.lstat(guestPath, callback));
		requireNonNegativeSafeInteger(stats.size, 'guest file stat byte length');
		return {
			byteLength: stats.size,
			kind: stats.isSymbolicLink()
				? 'symbolic-link'
				: stats.isDirectory()
					? 'directory'
					: stats.isFile()
						? 'file'
						: 'other',
		};
	};

	return {
		close: (closeOptions): void => {
			if (closeOptions?.notifyTransportFailure === true) {
				publishConnectedTransportFailure({ kind: 'transport-close' });
			}
			closeRequested = true;
			connected = false;
			transport?.end();
		},
		connect,
		execute,
		guestListDirectory: async ({ path: requestedPath }) =>
			await runSftpOperation(async (sftp) => {
				const guestPath = requireGuestAbsolutePath(requestedPath);
				const entries = await promisifySftp<FileEntry[]>((callback) =>
					sftp.readdir(guestPath, callback),
				);
				if (entries.length > options.limits.maxDirectoryEntries) {
					throw new Error('Strict SSH guest directory entry limit exceeded.');
				}
				return entries;
			}),
		guestMkdir: async ({ path: requestedPath }) =>
			await runSftpOperation(async (sftp) => {
				const guestPath = requireGuestAbsolutePath(requestedPath);
				await promisifySftpVoid((callback) => sftp.mkdir(guestPath, callback));
			}),
		guestReadFile: async ({ path: requestedPath }) =>
			await runSftpOperation(async (sftp) => {
				const guestPath = requireGuestAbsolutePath(requestedPath);
				const bytes = await promisifySftp<Buffer>((callback) => sftp.readFile(guestPath, callback));
				if (bytes.byteLength > options.limits.maxFileBytes) {
					throw new Error('Strict SSH guest file byte limit exceeded.');
				}
				return Buffer.from(bytes);
			}),
		guestRemove: async ({ kind, path: requestedPath }) =>
			await runSftpOperation(async (sftp) => {
				const guestPath = requireGuestAbsolutePath(requestedPath);
				await promisifySftpVoid((callback) =>
					kind === 'directory' ? sftp.rmdir(guestPath, callback) : sftp.unlink(guestPath, callback),
				);
			}),
		guestRename: async ({ fromPath, toPath }) =>
			await runSftpOperation(async (sftp) => {
				const guestFromPath = requireGuestAbsolutePath(fromPath);
				const guestToPath = requireGuestAbsolutePath(toPath);
				await promisifySftpVoid((callback) =>
					sftp.ext_openssh_rename(guestFromPath, guestToPath, callback),
				);
			}),
		guestStat: async ({ path: requestedPath }) =>
			await runSftpOperation(async (sftp) => await guestStat(sftp, requestedPath)),
		guestWriteFile: async ({ bytes, path: requestedPath }) =>
			await runSftpOperation(async (sftp) => {
				if (bytes.byteLength > options.limits.maxWriteBytes) {
					throw new Error('Strict SSH guest file write byte limit exceeded.');
				}
				const guestPath = requireGuestAbsolutePath(requestedPath);
				await promisifySftpVoid((callback) =>
					sftp.writeFile(guestPath, Buffer.from(bytes), callback),
				);
			}),
		listDirectory: async ({ path }) =>
			await runSftpOperation(async (sftp) => {
				const authorizedPath = await authorizeRemotePath(sftp, path);
				const entries = await promisifySftp<FileEntry[]>((callback) =>
					sftp.readdir(authorizedPath.guestPath, callback),
				);
				const authorization = pathContract.authorizeTraversal({
					bytesRead: 0,
					depth: authorizedPath.depth,
					elapsedMs: options.runtime.clock.now() - authorizedPath.startedAt,
					entriesVisited: entries.length,
					symlinkDepth: authorizedPath.symlinkDepth,
				});
				if (authorization.kind === 'rejected') {
					throw new Error('Strict SSH directory entry limit exceeded.');
				}
				return entries;
			}),
		mkdir: async ({ path }) =>
			await runSftpOperation(async (sftp) => {
				const guestPath = await authorizeMutationTarget(sftp, path);
				await promisifySftpVoid((callback) => sftp.mkdir(guestPath, callback));
			}),
		observeTransportFailure: (observer) => {
			transportFailureObservers.add(observer);
			if (observedTransportFailure !== undefined) {
				try {
					observer(observedTransportFailure);
				} catch {}
			}
			return { unsubscribe: (): void => void transportFailureObservers.delete(observer) };
		},
		openProcessChannel,
		openShellProcessChannel,
		readFile: async ({ path }) =>
			await runSftpOperation(async (sftp) => {
				const authorizedPath = await authorizeRemotePath(sftp, path);
				const contents = await promisifySftp<Buffer>((callback) =>
					sftp.readFile(authorizedPath.guestPath, callback),
				);
				const authorization = pathContract.authorizeTraversal({
					bytesRead: contents.byteLength,
					depth: authorizedPath.depth,
					elapsedMs: options.runtime.clock.now() - authorizedPath.startedAt,
					entriesVisited: 1,
					symlinkDepth: authorizedPath.symlinkDepth,
				});
				if (authorization.kind === 'rejected') {
					throw new Error('Strict SSH file byte limit exceeded.');
				}
				return contents;
			}),
		remove: async ({ kind, path }) =>
			await runSftpOperation(async (sftp) => {
				const guestPath = await authorizeExistingMutationPath(sftp, path);
				await promisifySftpVoid((callback) =>
					kind === 'directory' ? sftp.rmdir(guestPath, callback) : sftp.unlink(guestPath, callback),
				);
			}),
		rename: async ({ fromPath, toPath }) =>
			await runSftpOperation(async (sftp) => {
				const sourceGuestPath = await authorizeExistingMutationPath(sftp, fromPath);
				const destination = await authorizeMutationTarget(sftp, toPath);
				await promisifySftpVoid((callback) => sftp.rename(sourceGuestPath, destination, callback));
			}),
		stat: async ({ path }) =>
			await runSftpOperation(async (sftp) => {
				const authorizedPath = await authorizeRemotePath(sftp, path);
				const stats = await promisifySftp<Stats>((callback) =>
					sftp.lstat(authorizedPath.guestPath, callback),
				);
				requireNonNegativeSafeInteger(stats.size, 'file stat byte length');
				return {
					byteLength: stats.size,
					kind: stats.isSymbolicLink()
						? 'symbolic-link'
						: stats.isDirectory()
							? 'directory'
							: stats.isFile()
								? 'file'
								: 'other',
				};
			}),
		writeFile: async ({ bytes, path }) =>
			await runSftpOperation(async (sftp) => {
				if (bytes.byteLength > options.limits.maxWriteBytes) {
					throw new Error('Strict SSH file write byte limit exceeded.');
				}
				const guestPath = await authorizeMutationTarget(sftp, path);
				await promisifySftpVoid((callback) =>
					sftp.writeFile(guestPath, Buffer.from(bytes), callback),
				);
			}),
	};
}
