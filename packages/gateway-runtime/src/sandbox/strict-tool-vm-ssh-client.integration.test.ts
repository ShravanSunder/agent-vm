import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';

import type {
	Client,
	ClientCallback,
	ClientChannel,
	ClientSFTPCallback,
	ConnectConfig,
	ExecOptions,
	FileEntry,
	SFTPWrapper,
	Stats,
	SyncHostVerifier,
} from 'ssh2';
import { describe, expect, it, vi } from 'vitest';

import {
	createStrictToolVmSshClient,
	encodePosixShellArgv,
	type StrictToolVmSshProcessTerminalEvent,
} from './strict-tool-vm-ssh-client.js';

const IDENTITY_PEM = [
	'-----BEGIN OPENSSH PRIVATE KEY-----',
	'test-private-key-material-that-must-never-escape',
	'-----END OPENSSH PRIVATE KEY-----',
].join('\n');
const CONTROLLER_HOST = 'tool-7.vm.internal';
const CONTROLLER_USER = 'sandbox';
const CONTROLLER_PORT = 2207;
const OPERATION_DEADLINE_MILLISECONDS = 5_000;

function encodeSshString(value: Uint8Array): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(value.byteLength);
	return Buffer.concat([length, value]);
}

const ED25519_ALGORITHM_BYTES = Buffer.from('ssh-ed25519');
const PINNED_HOST_KEY = Buffer.concat([
	encodeSshString(ED25519_ALGORITHM_BYTES),
	encodeSshString(Buffer.alloc(32, 0x2a)),
]);
const DIFFERENT_HOST_KEY = Buffer.concat([
	encodeSshString(ED25519_ALGORITHM_BYTES),
	encodeSshString(Buffer.alloc(32, 0x7f)),
]);

const validAccess = {
	host: CONTROLLER_HOST,
	identityPem: IDENTITY_PEM,
	knownHostsLine: `${CONTROLLER_HOST} ssh-ed25519 ${PINNED_HOST_KEY.toString('base64')}`,
	port: CONTROLLER_PORT,
	user: CONTROLLER_USER,
} as const;

const strictLimits = {
	maxDirectoryEntries: 2,
	maxFileBytes: 8,
	maxPathDepth: 3,
	maxStderrBytes: 8,
	maxStdoutBytes: 8,
	maxSymlinkDepth: 1,
	maxWriteBytes: 8,
} as const;

const deadlineMilliseconds = {
	connect: OPERATION_DEADLINE_MILLISECONDS,
	operation: OPERATION_DEADLINE_MILLISECONDS,
} as const;

interface ScheduledDeadline {
	readonly callback: () => void;
	readonly delayMilliseconds: number;
	readonly id: number;
}

class ManualDeadlineScheduler {
	readonly #scheduledDeadlines = new Map<number, ScheduledDeadline>();
	#nextId = 1;
	readonly cancelledDeadlineIds: number[] = [];

	readonly schedule = (
		callback: () => void,
		delayMilliseconds: number,
	): { readonly cancel: () => void } => {
		const id = this.#nextId;
		this.#nextId += 1;
		this.#scheduledDeadlines.set(id, { callback, delayMilliseconds, id });
		return {
			cancel: (): void => {
				if (this.#scheduledDeadlines.delete(id)) this.cancelledDeadlineIds.push(id);
			},
		};
	};

	get pendingDeadlineDelays(): readonly number[] {
		return Array.from(this.#scheduledDeadlines.values(), (deadline) => deadline.delayMilliseconds);
	}

	expireOnlyPendingDeadline(): void {
		const pendingDeadlines = Array.from(this.#scheduledDeadlines.values());
		if (pendingDeadlines.length !== 1) {
			throw new Error(`Expected one pending deadline, received ${pendingDeadlines.length}.`);
		}
		const deadline = pendingDeadlines[0];
		if (deadline === undefined) throw new Error('Pending deadline disappeared.');
		this.#scheduledDeadlines.delete(deadline.id);
		deadline.callback();
	}
}

class FakeSshChannel extends EventEmitter {
	readonly stderr = new EventEmitter();
	readonly writeCalls: Uint8Array[] = [];
	closeCallCount = 0;
	destroyCallCount = 0;
	endCallCount = 0;
	nextWriteResult = true;
	readonly setWindowCalls: {
		readonly columns: number;
		readonly height: number;
		readonly rows: number;
		readonly width: number;
	}[] = [];

	close(): void {
		this.closeCallCount += 1;
	}

	destroy(): this {
		this.destroyCallCount += 1;
		return this;
	}

	end(): this {
		this.endCallCount += 1;
		return this;
	}

	write(bytes: Uint8Array): boolean {
		this.writeCalls.push(bytes);
		return this.nextWriteResult;
	}

	setWindow(rows: number, columns: number, height: number, width: number): void {
		this.setWindowCalls.push({ columns, height, rows, width });
	}
}

class FakeSftpClient extends EventEmitter {
	readonly lstatCalls: string[] = [];
	readonly mkdirCalls: string[] = [];
	readonly missingPaths = new Set<string>();
	readonly realpathCalls: string[] = [];
	readonly readFileCalls: string[] = [];
	readonly readdirCalls: string[] = [];
	readonly opensshRenameCalls: { readonly fromPath: string; readonly toPath: string }[] = [];
	readonly renameCalls: { readonly fromPath: string; readonly toPath: string }[] = [];
	readonly rmdirCalls: string[] = [];
	readonly unlinkCalls: string[] = [];
	readonly writeFileCalls: { readonly bytes: Buffer; readonly remotePath: string }[] = [];
	endCallCount = 0;
	fileBytes = Buffer.from('contents');
	readFileError: Error | undefined;
	directoryEntries: FileEntry[] = [];
	realpathResults = new Map<string, string>();
	symlinkPaths = new Set<string>();

	lstat(remotePath: string, callback: (error: Error | undefined, stats: Stats) => void): void {
		this.lstatCalls.push(remotePath);
		if (this.missingPaths.has(remotePath)) {
			callback(Object.assign(new Error('missing'), { code: 2 }), undefined as unknown as Stats);
			return;
		}
		callback(undefined, {
			isDirectory: (): boolean => false,
			isFile: (): boolean => true,
			isSymbolicLink: (): boolean => this.symlinkPaths.has(remotePath),
			size: this.fileBytes.byteLength,
		} as Stats);
	}

	mkdir(remotePath: string, callback: (error?: Error) => void): void {
		this.mkdirCalls.push(remotePath);
		callback();
	}

	readdir(
		remotePath: string,
		callback: (error: Error | undefined, entries: FileEntry[]) => void,
	): void {
		this.readdirCalls.push(remotePath);
		callback(undefined, this.directoryEntries);
	}

	readFile(
		remotePath: string,
		callback: (error: Error | undefined, contents: Buffer) => void,
	): void {
		this.readFileCalls.push(remotePath);
		if (this.readFileError !== undefined) {
			callback(this.readFileError, undefined as unknown as Buffer);
			return;
		}
		callback(undefined, this.fileBytes);
	}

	end(): this {
		this.endCallCount += 1;
		queueMicrotask(() => this.emit('close'));
		return this;
	}

	realpath(
		remotePath: string,
		callback: (error: Error | undefined, absolutePath: string) => void,
	): void {
		this.realpathCalls.push(remotePath);
		callback(undefined, this.realpathResults.get(remotePath) ?? remotePath);
	}

	rename(fromPath: string, toPath: string, callback: (error?: Error) => void): void {
		this.renameCalls.push({ fromPath, toPath });
		callback();
	}

	ext_openssh_rename(fromPath: string, toPath: string, callback: (error?: Error) => void): void {
		this.opensshRenameCalls.push({ fromPath, toPath });
		callback();
	}

	rmdir(remotePath: string, callback: (error?: Error) => void): void {
		this.rmdirCalls.push(remotePath);
		callback();
	}

	unlink(remotePath: string, callback: (error?: Error) => void): void {
		this.unlinkCalls.push(remotePath);
		callback();
	}

	writeFile(remotePath: string, bytes: Buffer, callback: (error?: Error) => void): void {
		this.writeFileCalls.push({ bytes, remotePath });
		callback();
	}
}

class DelayedCloseSftpClient extends EventEmitter {
	readonly #onCloseAcknowledged: () => void;
	#closeRequested = false;

	constructor(onCloseAcknowledged: () => void) {
		super();
		this.#onCloseAcknowledged = onCloseAcknowledged;
	}

	end(): this {
		if (this.#closeRequested) return this;
		this.#closeRequested = true;
		queueMicrotask(() => {
			this.#onCloseAcknowledged();
			this.emit('close');
		});
		return this;
	}

	lstat(_remotePath: string, callback: (error: Error | undefined, stats: Stats) => void): void {
		callback(undefined, {
			isDirectory: (): boolean => false,
			isFile: (): boolean => true,
			isSymbolicLink: (): boolean => false,
			size: 1,
		} as Stats);
	}
}

class FakeSshTransport extends EventEmitter {
	connectConfiguration: ConnectConfig | undefined;
	connectCallCount = 0;
	destroyCallCount = 0;
	endCallCount = 0;
	execCommands: string[] = [];
	execOptions: ExecOptions[] = [];
	readonly channel = new FakeSshChannel();
	readonly sftpClient = new FakeSftpClient();
	onConnect: (transport: FakeSshTransport) => void = (transport) => {
		queueMicrotask(() => transport.emit('ready'));
	};
	onExec: (command: string, callback: ClientCallback) => void = (_command, callback) => {
		callback(undefined, this.channel as unknown as ClientChannel);
		queueMicrotask(() => {
			this.channel.emit('exit', 0);
			this.channel.emit('close');
		});
	};
	onSftp: (callback: ClientSFTPCallback) => void = (callback) => {
		callback(undefined, this.sftpClient as unknown as SFTPWrapper);
	};

	connect(configuration: ConnectConfig): this {
		this.connectCallCount += 1;
		this.connectConfiguration = configuration;
		this.onConnect(this);
		return this;
	}

	destroy(): this {
		this.destroyCallCount += 1;
		return this;
	}

	end(): this {
		this.endCallCount += 1;
		return this;
	}

	exec(command: string, callback: ClientCallback): this;
	exec(command: string, options: ExecOptions, callback: ClientCallback): this;
	exec(
		command: string,
		optionsOrCallback: ExecOptions | ClientCallback,
		callback?: ClientCallback,
	): this {
		this.execCommands.push(command);
		const resolvedCallback = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
		if (resolvedCallback === undefined) throw new Error('SSH exec callback is required.');
		this.execOptions.push(typeof optionsOrCallback === 'function' ? {} : optionsOrCallback);
		this.onExec(command, resolvedCallback);
		return this;
	}

	sftp(callback: ClientSFTPCallback): this {
		this.onSftp(callback);
		return this;
	}
}

interface StrictSshFixture {
	readonly client: ReturnType<typeof createStrictToolVmSshClient>;
	readonly deadlineScheduler: ManualDeadlineScheduler;
	readonly sshTransport: FakeSshTransport;
}

function createStrictSshFixture(
	options: {
		readonly access?: typeof validAccess;
		readonly sshTransport?: FakeSshTransport;
	} = {},
): StrictSshFixture {
	const sshTransport = options.sshTransport ?? new FakeSshTransport();
	const deadlineScheduler = new ManualDeadlineScheduler();
	const monotonicMilliseconds = 0;
	return {
		client: createStrictToolVmSshClient({
			access: options.access ?? validAccess,
			deadlineMilliseconds,
			limits: strictLimits,
			runtime: {
				clock: { now: (): number => monotonicMilliseconds },
				createSshClient: (): Client => sshTransport as unknown as Client,
				scheduler: { schedule: deadlineScheduler.schedule },
			},
		}),
		deadlineScheduler,
		sshTransport,
	};
}

async function connectFixture(fixture: StrictSshFixture): Promise<void> {
	await fixture.client.connect();
}

describe('strict Tool VM SSH client', () => {
	it('encodes argv as individually quoted POSIX shell tokens without accepting a shell string', () => {
		// Arrange
		const argv = [
			'/usr/bin/printf',
			'argument with spaces',
			"quote'value",
			'$(touch /work/escaped)',
			'line-one\nline-two',
		] as const;

		// Act
		const encodedArgv = encodePosixShellArgv(argv);

		// Assert
		expect(encodedArgv).toBe(
			"'/usr/bin/printf' 'argument with spaces' 'quote'\"'\"'value' '$(touch /work/escaped)' 'line-one\nline-two'",
		);
	});

	it.each([
		['missing private identity', { ...validAccess, identityPem: undefined }],
		['missing host-key pin', { ...validAccess, knownHostsLine: undefined }],
		[
			'multiple known_hosts lines',
			{
				...validAccess,
				knownHostsLine: `${validAccess.knownHostsLine}\n${validAccess.knownHostsLine}`,
			},
		],
		[
			'malformed known_hosts line',
			{ ...validAccess, knownHostsLine: `${CONTROLLER_HOST} ssh-ed25519` },
		],
		[
			'wrong known_hosts host',
			{
				...validAccess,
				knownHostsLine: `attacker.invalid ssh-ed25519 ${PINNED_HOST_KEY.toString('base64')}`,
			},
		],
		[
			'wrong host-key algorithm',
			{
				...validAccess,
				knownHostsLine: `${CONTROLLER_HOST} ssh-rsa ${PINNED_HOST_KEY.toString('base64')}`,
			},
		],
		[
			'extra known_hosts fields',
			{ ...validAccess, knownHostsLine: `${validAccess.knownHostsLine} comment` },
		],
	] as const)('fails closed before transport creation for %s', async (_label, access) => {
		// Arrange
		let transportCreationCount = 0;
		const deadlineScheduler = new ManualDeadlineScheduler();
		const client = createStrictToolVmSshClient({
			access,
			deadlineMilliseconds,
			limits: strictLimits,
			runtime: {
				clock: { now: (): number => 0 },
				createSshClient: (): Client => {
					transportCreationCount += 1;
					return new FakeSshTransport() as unknown as Client;
				},
				scheduler: { schedule: deadlineScheduler.schedule },
			},
		});

		// Act
		const connection = client.connect();

		// Assert
		await expect(connection).rejects.toThrow(/strict ssh access/i);
		expect(transportCreationCount).toBe(0);
	});

	it('uses only controller-authored destination, private key, and exact ssh-ed25519 raw host-key pin', async () => {
		// Arrange
		const fixture = createStrictSshFixture();

		// Act
		await connectFixture(fixture);
		const configuration = fixture.sshTransport.connectConfiguration;
		const verifyHostKey = configuration?.hostVerifier as SyncHostVerifier | undefined;

		// Assert
		expect(configuration).toMatchObject({
			algorithms: { serverHostKey: ['ssh-ed25519'] },
			host: CONTROLLER_HOST,
			port: CONTROLLER_PORT,
			privateKey: IDENTITY_PEM,
			username: CONTROLLER_USER,
		});
		expect(configuration?.hostHash).toBeUndefined();
		expect(verifyHostKey?.(PINNED_HOST_KEY)).toBe(true);
		expect(verifyHostKey?.(DIFFERENT_HOST_KEY)).toBe(false);
		expect(configuration).not.toHaveProperty('updateHostKeys');
		expect(fixture.deadlineScheduler.cancelledDeadlineIds).toHaveLength(1);
	});

	it('redacts the controller private key from transport errors and console output', async () => {
		// Arrange
		const sshTransport = new FakeSshTransport();
		sshTransport.onConnect = (transport) => {
			queueMicrotask(() =>
				transport.emit('error', new Error(`authentication failed: ${IDENTITY_PEM}`)),
			);
		};
		const fixture = createStrictSshFixture({ sshTransport });
		const consoleSpies = [
			vi.spyOn(console, 'debug').mockImplementation(() => undefined),
			vi.spyOn(console, 'error').mockImplementation(() => undefined),
			vi.spyOn(console, 'info').mockImplementation(() => undefined),
			vi.spyOn(console, 'warn').mockImplementation(() => undefined),
		];

		// Act
		const connectionError = await fixture.client.connect().catch((error: unknown) => error);

		// Assert
		expect(String(connectionError)).not.toContain(IDENTITY_PEM);
		for (const consoleSpy of consoleSpies) {
			expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain(IDENTITY_PEM);
			consoleSpy.mockRestore();
		}
	});

	it('publishes one safe typed failure when an established transport becomes unavailable', async () => {
		// Arrange
		const fixture = createStrictSshFixture();
		await connectFixture(fixture);
		const observedFailures: unknown[] = [];
		const observeTransportFailure = Reflect.get(fixture.client, 'observeTransportFailure');

		// Act
		expect(observeTransportFailure).toBeTypeOf('function');
		if (typeof observeTransportFailure !== 'function') return;
		observeTransportFailure((failure: unknown) => observedFailures.push(failure));
		fixture.sshTransport.emit('error', new Error(`connection lost: ${IDENTITY_PEM}`));
		fixture.sshTransport.emit('end');
		fixture.sshTransport.emit('close');

		// Assert
		expect(observedFailures).toEqual([{ kind: 'transport-error' }]);
		expect(JSON.stringify(observedFailures)).not.toContain(IDENTITY_PEM);
	});

	it('does not report a cached connection as ready after established transport failure', async () => {
		// Arrange
		const fixture = createStrictSshFixture();
		await connectFixture(fixture);
		fixture.sshTransport.emit('close');

		// Act
		const reconnect = fixture.client.connect();

		// Assert
		await expect(reconnect).rejects.toThrow(/no longer usable/i);
		expect(fixture.sshTransport.connectCallCount).toBe(1);
	});

	it('does not publish replacement evidence after unsubscribe or an intentional close', async () => {
		// Arrange
		const unsubscribedFixture = createStrictSshFixture();
		await connectFixture(unsubscribedFixture);
		const unsubscribedFailures: unknown[] = [];
		const subscription = unsubscribedFixture.client.observeTransportFailure((failure) =>
			unsubscribedFailures.push(failure),
		);
		subscription.unsubscribe();

		const closedFixture = createStrictSshFixture();
		await connectFixture(closedFixture);
		const closedFailures: unknown[] = [];
		closedFixture.client.observeTransportFailure((failure) => closedFailures.push(failure));

		// Act
		unsubscribedFixture.sshTransport.emit('error', new Error('connection lost'));
		closedFixture.client.close();
		closedFixture.sshTransport.emit('error', new Error('close acknowledgement'));
		closedFixture.sshTransport.emit('end');
		closedFixture.sshTransport.emit('close');

		// Assert
		expect(unsubscribedFailures).toEqual([]);
		expect(closedFailures).toEqual([]);
	});

	it('publishes invalidation before ending a replaced transport', async () => {
		// Arrange
		const fixture = createStrictSshFixture();
		await connectFixture(fixture);
		const observedOrder: string[] = [];
		fixture.client.observeTransportFailure((failure) => {
			observedOrder.push(failure.kind);
		});
		const endTransport = vi.spyOn(fixture.sshTransport, 'end').mockImplementationOnce(() => {
			observedOrder.push('transport-ended');
			return fixture.sshTransport;
		});

		// Act
		fixture.client.close({ notifyTransportFailure: true });
		await Promise.resolve();

		// Assert
		expect(observedOrder).toEqual(['transport-close', 'transport-ended']);
		expect(endTransport).toHaveBeenCalledOnce();
	});

	it('executes argv under a normalized /work cwd and returns bounded stdout/stderr bytes', async () => {
		// Arrange
		const fixture = createStrictSshFixture();
		fixture.sshTransport.onExec = (_command, callback) => {
			callback(undefined, fixture.sshTransport.channel as unknown as ClientChannel);
			queueMicrotask(() => {
				fixture.sshTransport.channel.emit('data', Buffer.from('stdout'));
				fixture.sshTransport.channel.stderr.emit('data', Buffer.from('stderr'));
				fixture.sshTransport.channel.emit('exit', 7);
				fixture.sshTransport.channel.emit('close');
			});
		};
		await connectFixture(fixture);

		// Act
		const result = await fixture.client.execute({
			argv: ['/usr/bin/printf', "a'b", '$(not-a-command)'],
			cwd: 'src//component/./tests',
		});

		// Assert
		expect(fixture.sshTransport.execCommands).toEqual([
			"cd -- '/work/src/component/tests' && exec -- '/usr/bin/printf' 'a'\"'\"'b' '$(not-a-command)'",
		]);
		expect(result).toEqual({
			exitCode: 7,
			kind: 'exited',
			stderr: Buffer.from('stderr'),
			stdout: Buffer.from('stdout'),
		});
	});

	it('rejects a signal-only command exit without returning a null exit code', async () => {
		// Arrange
		const fixture = createStrictSshFixture();
		fixture.sshTransport.onExec = (_command, callback) => {
			callback(undefined, fixture.sshTransport.channel as unknown as ClientChannel);
			queueMicrotask(() => {
				fixture.sshTransport.channel.emit('exit', null, 'SIGKILL', false, '');
				fixture.sshTransport.channel.emit('close');
			});
		};
		await connectFixture(fixture);

		// Act
		const execution = fixture.client.execute({ argv: ['/usr/bin/sleep', '30'], cwd: '' });

		// Assert
		await expect(execution).rejects.toThrow(/without an exit result/i);
	});

	it.each([
		['stdout', 'data', Buffer.alloc(strictLimits.maxStdoutBytes + 1)],
		['stderr', 'stderr-data', Buffer.alloc(strictLimits.maxStderrBytes + 1)],
	] as const)(
		'closes the command channel when %s exceeds its byte cap',
		async (_label, eventName, bytes) => {
			// Arrange
			const fixture = createStrictSshFixture();
			fixture.sshTransport.onExec = (_command, callback) => {
				callback(undefined, fixture.sshTransport.channel as unknown as ClientChannel);
				queueMicrotask(() => {
					if (eventName === 'data') fixture.sshTransport.channel.emit('data', bytes);
					else fixture.sshTransport.channel.stderr.emit('data', bytes);
				});
			};
			await connectFixture(fixture);

			// Act
			const execution = fixture.client.execute({ argv: ['/bin/true'], cwd: '' });

			// Assert
			await expect(execution).rejects.toThrow(/output limit/i);
			expect(fixture.sshTransport.channel.closeCallCount).toBe(1);
		},
	);

	it('waits for command-input drain before sending EOF', async () => {
		// Arrange
		const fixture = createStrictSshFixture();
		fixture.sshTransport.channel.nextWriteResult = false;
		fixture.sshTransport.onExec = (_command, callback) => {
			callback(undefined, fixture.sshTransport.channel as unknown as ClientChannel);
		};
		await connectFixture(fixture);

		// Act
		const execution = fixture.client.execute({
			argv: ['/usr/bin/cat'],
			cwd: '',
			stdin: Buffer.from('input'),
		});
		await vi.waitFor(() => expect(fixture.sshTransport.channel.writeCalls).toHaveLength(1));

		// Assert
		expect(fixture.sshTransport.channel.endCallCount).toBe(0);
		fixture.sshTransport.channel.emit('drain');
		await vi.waitFor(() => expect(fixture.sshTransport.channel.endCallCount).toBe(1));
		fixture.sshTransport.channel.emit('exit', 0);
		fixture.sshTransport.channel.emit('close');
		await expect(execution).resolves.toMatchObject({ kind: 'exited' });
	});

	it('closes the active command channel when the operation is cancelled', async () => {
		// Arrange
		const fixture = createStrictSshFixture();
		const cancellation = new AbortController();
		fixture.sshTransport.onExec = (_command, callback) => {
			callback(undefined, fixture.sshTransport.channel as unknown as ClientChannel);
		};
		await connectFixture(fixture);

		// Act
		const execution = fixture.client.execute({
			argv: ['/usr/bin/tail', '-f', '/dev/null'],
			cwd: '',
			signal: cancellation.signal,
		});
		cancellation.abort();

		// Assert
		await expect(execution).rejects.toThrow(/cancelled/i);
		expect(fixture.sshTransport.channel.closeCallCount).toBe(1);
	});

	it('closes a command channel that arrives after cancellation without writing input', async () => {
		// Arrange
		const fixture = createStrictSshFixture();
		const cancellation = new AbortController();
		let dispatchCallback: ClientCallback | undefined;
		fixture.sshTransport.onExec = (_command, callback) => {
			dispatchCallback = callback;
		};
		await connectFixture(fixture);

		// Act
		const execution = fixture.client.execute({
			argv: ['/usr/bin/cat'],
			cwd: '',
			signal: cancellation.signal,
			stdin: Buffer.from('blocked'),
		});
		cancellation.abort();
		await expect(execution).rejects.toThrow(/cancelled/i);
		if (dispatchCallback === undefined) throw new Error('SSH command dispatch was not recorded.');
		dispatchCallback(undefined, fixture.sshTransport.channel as unknown as ClientChannel);
		await Promise.resolve();

		// Assert
		expect(fixture.sshTransport.channel.closeCallCount).toBe(1);
		expect(fixture.sshTransport.channel.writeCalls).toHaveLength(0);
		expect(fixture.sshTransport.channel.endCallCount).toBe(0);
	});

	it('opens a bounded process channel beneath /work without exposing the ssh2 channel', async () => {
		// Arrange
		const fixture = createStrictSshFixture();
		const stdoutChunks: Uint8Array[] = [];
		const stderrChunks: Uint8Array[] = [];
		const terminalEvents: StrictToolVmSshProcessTerminalEvent[] = [];
		fixture.sshTransport.onExec = (_command, callback) => {
			callback(undefined, fixture.sshTransport.channel as unknown as ClientChannel);
		};
		await connectFixture(fixture);

		// Act
		const channel = await fixture.client.openProcessChannel({
			argv: ['/usr/bin/cat', "quote'value", '$(not-a-command)'],
			cwd: 'src//component/./tests',
			onStderr: (bytes) => stderrChunks.push(bytes),
			onStdout: (bytes) => stdoutChunks.push(bytes),
			onTerminal: (event) => terminalEvents.push(event),
		});
		fixture.sshTransport.channel.emit('data', Buffer.from('out'));
		fixture.sshTransport.channel.stderr.emit('data', Buffer.from('err'));
		await channel.write(Buffer.from('input'));
		channel.endInput();
		fixture.sshTransport.channel.emit('exit', 0);
		fixture.sshTransport.channel.emit('close');

		// Assert
		expect(fixture.sshTransport.execCommands).toEqual([
			"cd -- '/work/src/component/tests' && exec -- '/usr/bin/cat' 'quote'\"'\"'value' '$(not-a-command)'",
		]);
		expect(stdoutChunks).toEqual([Buffer.from('out')]);
		expect(stderrChunks).toEqual([Buffer.from('err')]);
		expect(fixture.sshTransport.channel.writeCalls).toEqual([Buffer.from('input')]);
		expect(fixture.sshTransport.channel.endCallCount).toBe(1);
		expect(terminalEvents).toEqual([{ exitCode: 0, kind: 'exited' }]);
		expect(fixture.deadlineScheduler.pendingDeadlineDelays).toEqual([]);
		expect(channel).not.toHaveProperty('stderr');
		expect(channel).not.toHaveProperty('emit');
	});

	it('opens a direct shell process with guest cwd, native environment, PTY, and resize', async () => {
		// Arrange
		const fixture = createStrictSshFixture();
		fixture.sshTransport.onExec = (_command, callback) => {
			callback(undefined, fixture.sshTransport.channel as unknown as ClientChannel);
		};
		await connectFixture(fixture);

		// Act
		const channel = await fixture.client.openShellProcessChannel({
			command: `printf '%s' "$AGENT_VALUE"; echo $(touch /work/not-expanded-by-wrapper)`,
			cwd: "/workspace/agent's files",
			environmentVariables: [{ name: 'AGENT_VALUE', value: "value with ' quotes" }],
			onStderr: () => undefined,
			onStdout: () => undefined,
			onTerminal: () => undefined,
			terminalSize: { columns: 120, rows: 40 },
		});
		channel.resizeTerminal({ columns: 160, rows: 55 });

		// Assert
		expect(fixture.sshTransport.execCommands).toEqual([
			"'/bin/sh' '-c' 'cd -- \"$1\" && shift && exec \"$@\"' 'agent-vm-sandbox' '/workspace/agent'\"'\"'s files' '/usr/bin/env' 'AGENT_VALUE=value with '\"'\"' quotes' '/bin/sh' '-lc' 'printf '\"'\"'%s'\"'\"' \"$AGENT_VALUE\"; echo $(touch /work/not-expanded-by-wrapper)'",
		]);
		expect(fixture.sshTransport.execOptions).toEqual([
			{
				pty: { cols: 120, height: 0, rows: 40, width: 0 },
			},
		]);
		expect(fixture.sshTransport.channel.setWindowCalls).toEqual([
			{ columns: 160, height: 0, rows: 55, width: 0 },
		]);
	});

	it.each([
		['relative cwd', { command: 'true', cwd: 'work' }],
		['NUL cwd', { command: 'true', cwd: '/work/bad\0cwd' }],
		['empty command', { command: '', cwd: '/work' }],
		['NUL command', { command: 'bad\0command', cwd: '/work' }],
	] as const)('rejects direct shell %s before SSH dispatch', async (_label, request) => {
		// Arrange
		const fixture = createStrictSshFixture();
		await connectFixture(fixture);

		// Act
		const opening = fixture.client.openShellProcessChannel({
			...request,
			onStderr: () => undefined,
			onStdout: () => undefined,
			onTerminal: () => undefined,
		});

		// Assert
		await expect(opening).rejects.toThrow(/command|guest-absolute/i);
		expect(fixture.sshTransport.execCommands).toHaveLength(0);
	});

	it.each([
		['empty argv', { argv: [] as readonly string[], cwd: '' }],
		['empty argv token', { argv: ['/bin/echo', ''], cwd: '' }],
		['NUL argv token', { argv: ['/bin/echo', 'bad\0token'], cwd: '' }],
		['absolute cwd', { argv: ['/bin/echo'], cwd: '/etc' }],
		['parent-traversing cwd', { argv: ['/bin/echo'], cwd: '../outside' }],
	] as const)('rejects process-channel %s before SSH dispatch', async (_label, request) => {
		// Arrange
		const fixture = createStrictSshFixture();
		await connectFixture(fixture);

		// Act
		const opening = fixture.client.openProcessChannel({
			...request,
			onStderr: () => undefined,
			onStdout: () => undefined,
			onTerminal: () => undefined,
		});

		// Assert
		await expect(opening).rejects.toThrow(/argv|work-relative/i);
		expect(fixture.sshTransport.execCommands).toHaveLength(0);
	});

	it('rejects process input beyond its per-write bound and after EOF', async () => {
		// Arrange
		const fixture = createStrictSshFixture();
		fixture.sshTransport.onExec = (_command, callback) => {
			callback(undefined, fixture.sshTransport.channel as unknown as ClientChannel);
		};
		await connectFixture(fixture);
		const channel = await fixture.client.openProcessChannel({
			argv: ['/usr/bin/cat'],
			cwd: '',
			onStderr: () => undefined,
			onStdout: () => undefined,
			onTerminal: () => undefined,
		});

		// Act
		const oversizedWrite = channel.write(Buffer.alloc(strictLimits.maxWriteBytes + 1));
		channel.endInput();
		const afterEndWrite = channel.write(Buffer.from('late'));

		// Assert
		await expect(oversizedWrite).rejects.toThrow(/write byte limit/i);
		await expect(afterEndWrite).rejects.toThrow(/input is closed/i);
		expect(fixture.sshTransport.channel.writeCalls).toHaveLength(0);
	});

	it('closes a process channel that arrives after its open was cancelled', async () => {
		// Arrange
		const fixture = createStrictSshFixture();
		const cancellation = new AbortController();
		let dispatchCallback: ClientCallback | undefined;
		fixture.sshTransport.onExec = (_command, callback) => {
			dispatchCallback = callback;
		};
		await connectFixture(fixture);

		// Act
		const opening = fixture.client.openProcessChannel({
			argv: ['/usr/bin/cat'],
			cwd: '',
			onStderr: () => undefined,
			onStdout: () => undefined,
			onTerminal: () => undefined,
			signal: cancellation.signal,
		});
		cancellation.abort();
		await expect(opening).rejects.toThrow(/cancelled/i);
		if (dispatchCallback === undefined) throw new Error('SSH process dispatch was not recorded.');
		dispatchCallback(undefined, fixture.sshTransport.channel as unknown as ClientChannel);
		await Promise.resolve();

		// Assert
		expect(fixture.sshTransport.channel.closeCallCount).toBe(1);
		expect(fixture.sshTransport.channel.writeCalls).toHaveLength(0);
		expect(fixture.sshTransport.channel.endCallCount).toBe(0);
		expect(fixture.deadlineScheduler.pendingDeadlineDelays).toEqual([]);
	});

	it('bounds process-channel opening with the operation deadline and rejects a late channel', async () => {
		// Arrange
		const fixture = createStrictSshFixture();
		const observedFailures: unknown[] = [];
		fixture.client.observeTransportFailure((failure) => observedFailures.push(failure));
		let dispatchCallback: ClientCallback | undefined;
		fixture.sshTransport.onExec = (_command, callback) => {
			dispatchCallback = callback;
		};
		await connectFixture(fixture);

		// Act
		const opening = fixture.client.openProcessChannel({
			argv: ['/usr/bin/cat'],
			cwd: '',
			onStderr: () => undefined,
			onStdout: () => undefined,
			onTerminal: () => undefined,
		});
		expect(fixture.deadlineScheduler.pendingDeadlineDelays).toEqual([
			OPERATION_DEADLINE_MILLISECONDS,
		]);
		fixture.deadlineScheduler.expireOnlyPendingDeadline();
		await expect(opening).rejects.toThrow(/deadline/i);
		if (dispatchCallback === undefined) throw new Error('SSH process dispatch was not recorded.');
		dispatchCallback(undefined, fixture.sshTransport.channel as unknown as ClientChannel);
		await Promise.resolve();

		// Assert
		expect(fixture.sshTransport.channel.closeCallCount).toBe(1);
		expect(fixture.deadlineScheduler.pendingDeadlineDelays).toEqual([]);
		expect(observedFailures).toEqual([{ kind: 'transport-unresponsive' }]);
		await expect(fixture.client.connect()).rejects.toThrow(/no longer usable/i);
	});

	it.each([
		['stdout', 'data', strictLimits.maxStdoutBytes],
		['stderr', 'stderr-data', strictLimits.maxStderrBytes],
	] as const)(
		'closes the process channel before delivering %s beyond its cumulative byte cap',
		async (_label, eventName, byteLimit) => {
			// Arrange
			const fixture = createStrictSshFixture();
			const deliveredChunks: Uint8Array[] = [];
			const terminalEvents: StrictToolVmSshProcessTerminalEvent[] = [];
			fixture.sshTransport.onExec = (_command, callback) => {
				callback(undefined, fixture.sshTransport.channel as unknown as ClientChannel);
			};
			await connectFixture(fixture);
			const channel = await fixture.client.openProcessChannel({
				argv: ['/usr/bin/cat'],
				cwd: '',
				onStderr: (bytes) => deliveredChunks.push(bytes),
				onStdout: (bytes) => deliveredChunks.push(bytes),
				onTerminal: (event) => terminalEvents.push(event),
			});

			// Act
			const acceptedBytes = Buffer.alloc(byteLimit, 0x41);
			if (eventName === 'data') {
				fixture.sshTransport.channel.emit('data', acceptedBytes);
				fixture.sshTransport.channel.emit('data', Buffer.from('overflow'));
			} else {
				fixture.sshTransport.channel.stderr.emit('data', acceptedBytes);
				fixture.sshTransport.channel.stderr.emit('data', Buffer.from('overflow'));
			}
			fixture.sshTransport.channel.emit('close');

			// Assert
			expect(deliveredChunks).toEqual([acceptedBytes]);
			expect(fixture.sshTransport.channel.closeCallCount).toBe(1);
			expect(terminalEvents).toEqual([{ kind: 'ambiguous' }]);
			await expect(channel.write(Buffer.from('after-terminal'))).rejects.toThrow(/terminal/i);
		},
	);

	it.each([
		['stdout', 'data'],
		['stderr', 'stderr-data'],
	] as const)(
		'contains a throwing %s consumer callback and terminates the channel ambiguously once',
		async (_label, eventName) => {
			// Arrange
			const fixture = createStrictSshFixture();
			const terminalEvents: StrictToolVmSshProcessTerminalEvent[] = [];
			fixture.sshTransport.channel.nextWriteResult = false;
			fixture.sshTransport.onExec = (_command, callback) => {
				callback(undefined, fixture.sshTransport.channel as unknown as ClientChannel);
			};
			await connectFixture(fixture);
			const channel = await fixture.client.openProcessChannel({
				argv: ['/usr/bin/cat'],
				cwd: '',
				onStderr: () => {
					throw new Error('stderr consumer failed');
				},
				onStdout: () => {
					throw new Error('stdout consumer failed');
				},
				onTerminal: (event) => terminalEvents.push(event),
			});
			const writing = channel.write(Buffer.from('input'));
			const writingRejection = expect(writing).rejects.toThrow(/terminal/i);

			// Act
			const emitOutput = (): boolean =>
				eventName === 'data'
					? fixture.sshTransport.channel.emit('data', Buffer.from('output'))
					: fixture.sshTransport.channel.stderr.emit('data', Buffer.from('output'));

			// Assert
			expect(emitOutput).not.toThrow();
			await writingRejection;
			expect(fixture.sshTransport.channel.closeCallCount).toBe(1);
			expect(terminalEvents).toEqual([{ kind: 'ambiguous' }]);
			fixture.sshTransport.channel.emit('close');
			expect(terminalEvents).toEqual([{ kind: 'ambiguous' }]);
		},
	);

	it('contains a throwing terminal consumer after irrevocably settling terminal state', async () => {
		// Arrange
		const fixture = createStrictSshFixture();
		let terminalCallbackCount = 0;
		fixture.sshTransport.channel.nextWriteResult = false;
		fixture.sshTransport.onExec = (_command, callback) => {
			callback(undefined, fixture.sshTransport.channel as unknown as ClientChannel);
		};
		await connectFixture(fixture);
		const channel = await fixture.client.openProcessChannel({
			argv: ['/usr/bin/cat'],
			cwd: '',
			onStderr: () => undefined,
			onStdout: () => undefined,
			onTerminal: () => {
				terminalCallbackCount += 1;
				throw new Error('terminal consumer failed');
			},
		});
		const writing = channel.write(Buffer.from('input'));
		const writingRejection = expect(writing).rejects.toThrow(/terminal/i);

		// Act
		const emitChannelError = (): boolean =>
			fixture.sshTransport.channel.emit('error', new Error('transport lost'));

		// Assert
		expect(emitChannelError).not.toThrow();
		await writingRejection;
		expect(fixture.sshTransport.channel.closeCallCount).toBe(1);
		expect(terminalCallbackCount).toBe(1);
		fixture.sshTransport.channel.emit('close');
		expect(terminalCallbackCount).toBe(1);
	});

	it('reports an ambiguous channel loss exactly once and makes cancellation and EOF idempotent', async () => {
		// Arrange
		const fixture = createStrictSshFixture();
		const terminalEvents: StrictToolVmSshProcessTerminalEvent[] = [];
		fixture.sshTransport.onExec = (_command, callback) => {
			callback(undefined, fixture.sshTransport.channel as unknown as ClientChannel);
		};
		await connectFixture(fixture);
		const channel = await fixture.client.openProcessChannel({
			argv: ['/usr/bin/cat'],
			cwd: '',
			onStderr: () => undefined,
			onStdout: () => undefined,
			onTerminal: (event) => terminalEvents.push(event),
		});

		// Act
		channel.endInput();
		channel.endInput();
		channel.requestCancellation();
		channel.requestCancellation();
		fixture.sshTransport.channel.emit('error', new Error('transport lost'));
		fixture.sshTransport.channel.emit('close');
		fixture.sshTransport.channel.emit('exit', 17);

		// Assert
		expect(fixture.sshTransport.channel.endCallCount).toBe(1);
		expect(fixture.sshTransport.channel.closeCallCount).toBe(1);
		expect(terminalEvents).toEqual([{ kind: 'ambiguous' }]);
	});

	it('reports an SSH transport loss as ambiguous exactly once for an open process channel', async () => {
		// Arrange
		const fixture = createStrictSshFixture();
		const terminalEvents: StrictToolVmSshProcessTerminalEvent[] = [];
		fixture.sshTransport.onExec = (_command, callback) => {
			callback(undefined, fixture.sshTransport.channel as unknown as ClientChannel);
		};
		await connectFixture(fixture);
		await fixture.client.openProcessChannel({
			argv: ['/usr/bin/cat'],
			cwd: '',
			onStderr: () => undefined,
			onStdout: () => undefined,
			onTerminal: (event) => terminalEvents.push(event),
		});

		// Act
		fixture.sshTransport.emit('error', new Error('connection lost'));
		fixture.sshTransport.channel.emit('close');

		// Assert
		expect(fixture.sshTransport.channel.closeCallCount).toBe(1);
		expect(terminalEvents).toEqual([{ kind: 'ambiguous' }]);
	});

	it('preserves a proven exit result when close and error signals race afterward', async () => {
		// Arrange
		const fixture = createStrictSshFixture();
		const terminalEvents: StrictToolVmSshProcessTerminalEvent[] = [];
		fixture.sshTransport.onExec = (_command, callback) => {
			callback(undefined, fixture.sshTransport.channel as unknown as ClientChannel);
		};
		await connectFixture(fixture);
		await fixture.client.openProcessChannel({
			argv: ['/bin/false'],
			cwd: '',
			onStderr: () => undefined,
			onStdout: () => undefined,
			onTerminal: (event) => terminalEvents.push(event),
		});

		// Act
		fixture.sshTransport.channel.emit('exit', 17);
		fixture.sshTransport.channel.emit('error', new Error('late transport error'));
		fixture.sshTransport.channel.emit('close');

		// Assert
		expect(terminalEvents).toEqual([{ exitCode: 17, kind: 'exited' }]);
	});

	it('reports a signal-only process exit as ambiguous instead of a numeric exit', async () => {
		// Arrange
		const fixture = createStrictSshFixture();
		const terminalEvents: StrictToolVmSshProcessTerminalEvent[] = [];
		fixture.sshTransport.onExec = (_command, callback) => {
			callback(undefined, fixture.sshTransport.channel as unknown as ClientChannel);
		};
		await connectFixture(fixture);
		await fixture.client.openProcessChannel({
			argv: ['/usr/bin/sleep', '30'],
			cwd: '',
			onStderr: () => undefined,
			onStdout: () => undefined,
			onTerminal: (event) => terminalEvents.push(event),
		});

		// Act
		fixture.sshTransport.channel.emit('exit', null, 'SIGKILL', false, '');
		fixture.sshTransport.channel.emit('close');

		// Assert
		expect(terminalEvents).toEqual([{ kind: 'ambiguous' }]);
	});

	it('rejects a backpressured process write when the channel becomes terminal before drain', async () => {
		// Arrange
		const fixture = createStrictSshFixture();
		fixture.sshTransport.channel.nextWriteResult = false;
		fixture.sshTransport.onExec = (_command, callback) => {
			callback(undefined, fixture.sshTransport.channel as unknown as ClientChannel);
		};
		await connectFixture(fixture);
		const channel = await fixture.client.openProcessChannel({
			argv: ['/usr/bin/cat'],
			cwd: '',
			onStderr: () => undefined,
			onStdout: () => undefined,
			onTerminal: () => undefined,
		});

		// Act
		const writing = channel.write(Buffer.from('input'));
		fixture.sshTransport.channel.emit('close');

		// Assert
		await expect(writing).rejects.toThrow(/terminal/i);
	});

	it('closes the active channel when its deterministic operation deadline expires', async () => {
		// Arrange
		const fixture = createStrictSshFixture();
		fixture.sshTransport.onExec = (_command, callback) => {
			callback(undefined, fixture.sshTransport.channel as unknown as ClientChannel);
		};
		await connectFixture(fixture);

		// Act
		const execution = fixture.client.execute({ argv: ['/bin/sleep', '30'], cwd: '' });
		expect(fixture.deadlineScheduler.pendingDeadlineDelays).toEqual([
			OPERATION_DEADLINE_MILLISECONDS,
		]);
		fixture.deadlineScheduler.expireOnlyPendingDeadline();

		// Assert
		await expect(execution).rejects.toThrow(/deadline/i);
		expect(fixture.sshTransport.channel.closeCallCount).toBe(1);
	});

	it.each([
		['absolute', '/etc/passwd'],
		['NUL', 'src\0secret'],
		['parent traversal', 'src/../secret'],
	] as const)('rejects a %s filesystem path before SFTP', async (_label, requestedPath) => {
		// Arrange
		const fixture = createStrictSshFixture();
		await connectFixture(fixture);

		// Act
		const read = fixture.client.readFile({ path: requestedPath });

		// Assert
		await expect(read).rejects.toThrow(/work-relative path/i);
		expect(fixture.sshTransport.sftpClient.lstatCalls).toHaveLength(0);
	});

	it('normalizes filesystem paths and lstat/realpath-fences every component beneath /work', async () => {
		// Arrange
		const fixture = createStrictSshFixture();
		await connectFixture(fixture);

		// Act
		const contents = await fixture.client.readFile({ path: 'src//component/./index.ts' });

		// Assert
		expect(contents).toEqual(Buffer.from('contents'));
		expect(fixture.sshTransport.sftpClient.lstatCalls).toEqual([
			'/work/src',
			'/work/src/component',
			'/work/src/component/index.ts',
		]);
		expect(fixture.sshTransport.sftpClient.realpathCalls).toEqual([
			'/work/src',
			'/work/src/component',
			'/work/src/component/index.ts',
		]);
		expect(fixture.sshTransport.sftpClient.readFileCalls).toEqual(['/work/src/component/index.ts']);
	});

	it('uses normalized guest-absolute paths for direct Sandbox filesystem operations', async () => {
		// Arrange
		const fixture = createStrictSshFixture();
		fixture.sshTransport.sftpClient.fileBytes = Buffer.from('guest');
		await connectFixture(fixture);

		// Act
		const read = await fixture.client.guestReadFile({
			path: '/workspace//memory/../memory/log.md',
		});
		await fixture.client.guestWriteFile({ bytes: Buffer.from('next'), path: '/workspace/log.md' });
		await fixture.client.guestRename({
			fromPath: '/workspace/log.md',
			toPath: '/workspace/archive/log.md',
		});

		// Assert
		expect(read).toEqual(Buffer.from('guest'));
		expect(fixture.sshTransport.sftpClient.readFileCalls).toEqual(['/workspace/memory/log.md']);
		expect(fixture.sshTransport.sftpClient.writeFileCalls).toEqual([
			{ bytes: Buffer.from('next'), remotePath: '/workspace/log.md' },
		]);
		expect(fixture.sshTransport.sftpClient.opensshRenameCalls).toEqual([
			{ fromPath: '/workspace/log.md', toPath: '/workspace/archive/log.md' },
		]);
		expect(fixture.sshTransport.sftpClient.renameCalls).toHaveLength(0);
		expect(fixture.sshTransport.sftpClient.realpathCalls).toHaveLength(0);
	});

	it('uses POSIX OpenSSH rename for atomic replacement of an existing guest file', async () => {
		// Arrange
		const fixture = createStrictSshFixture();
		await connectFixture(fixture);

		// Act
		await fixture.client.guestRename({
			fromPath: '/workspace/.memory.md.agent-vm-tmp',
			toPath: '/workspace/memory.md',
		});

		// Assert
		expect(fixture.sshTransport.sftpClient.opensshRenameCalls).toEqual([
			{
				fromPath: '/workspace/.memory.md.agent-vm-tmp',
				toPath: '/workspace/memory.md',
			},
		]);
		expect(fixture.sshTransport.sftpClient.renameCalls).toHaveLength(0);
	});

	it('closes each bounded SFTP session after successful and rejected filesystem operations', async () => {
		// Arrange
		const fixture = createStrictSshFixture();
		await connectFixture(fixture);

		// Act
		await fixture.client.guestReadFile({ path: '/workspace/memory.md' });
		fixture.sshTransport.sftpClient.readFileError = new Error('read failed');
		const rejectedRead = fixture.client.guestReadFile({ path: '/workspace/rejected.md' });

		// Assert
		await expect(rejectedRead).rejects.toThrow(/SFTP operation failed/i);
		expect(fixture.sshTransport.sftpClient.endCallCount).toBe(2);
	});

	it('serializes SFTP channels until the remote close acknowledgment releases capacity', async () => {
		// Arrange
		const sshTransport = new FakeSshTransport();
		let activeSftpChannelCount = 0;
		let maximumActiveSftpChannelCount = 0;
		sshTransport.onSftp = (callback) => {
			if (activeSftpChannelCount >= 10) {
				callback(
					new Error('(SSH) Channel open failure: open failed'),
					undefined as unknown as SFTPWrapper,
				);
				return;
			}
			activeSftpChannelCount += 1;
			maximumActiveSftpChannelCount = Math.max(
				maximumActiveSftpChannelCount,
				activeSftpChannelCount,
			);
			callback(
				undefined,
				new DelayedCloseSftpClient(() => {
					activeSftpChannelCount -= 1;
				}) as unknown as SFTPWrapper,
			);
		};
		const fixture = createStrictSshFixture({ sshTransport });
		await connectFixture(fixture);

		// Act
		const operations = Array.from(
			{ length: 12 },
			async (_value, index) =>
				await fixture.client.guestStat({ path: `/workspace/file-${index}.txt` }),
		);
		const queuedDeadlineCount = fixture.deadlineScheduler.pendingDeadlineDelays.length;
		const results = await Promise.allSettled(operations);

		// Assert
		expect(queuedDeadlineCount).toBe(0);
		expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
		expect(maximumActiveSftpChannelCount).toBe(1);
		expect(activeSftpChannelCount).toBe(0);
		expect(sshTransport.destroyCallCount).toBe(0);
	});

	it('closes an SFTP session that arrives after its operation deadline without dispatching work', async () => {
		// Arrange
		const fixture = createStrictSshFixture();
		let sftpCallback: ClientSFTPCallback | undefined;
		fixture.sshTransport.onSftp = (callback) => {
			sftpCallback = callback;
		};
		await connectFixture(fixture);

		// Act
		const read = fixture.client.guestReadFile({ path: '/workspace/late.md' });
		await Promise.resolve();
		fixture.deadlineScheduler.expireOnlyPendingDeadline();
		await expect(read).rejects.toThrow(/deadline/i);
		if (sftpCallback === undefined) throw new Error('SFTP callback was not captured.');
		sftpCallback(undefined, fixture.sshTransport.sftpClient as unknown as SFTPWrapper);
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		// Assert
		expect(fixture.sshTransport.sftpClient.endCallCount).toBe(1);
		expect(fixture.sshTransport.sftpClient.readFileCalls).toHaveLength(0);
	});

	it('executes direct guest directory, stat, and removal operations without the work-relative fence', async () => {
		// Arrange
		const fixture = createStrictSshFixture();
		fixture.sshTransport.sftpClient.directoryEntries = [
			{
				attrs: { atime: 0, gid: 0, mode: 0, mtime: 0, size: 7, uid: 0 },
				filename: 'memory.md',
				longname: '-rw-r--r--',
			},
		];
		await connectFixture(fixture);

		// Act
		const entries = await fixture.client.guestListDirectory({ path: '/workspace//agent' });
		await fixture.client.guestMkdir({ path: '/workspace/new' });
		const statResult = await fixture.client.guestStat({ path: '/workspace/memory.md' });
		await fixture.client.guestRemove({ kind: 'file', path: '/workspace/old.md' });
		await fixture.client.guestRemove({ kind: 'directory', path: '/workspace/old' });

		// Assert
		expect(entries).toHaveLength(1);
		expect(statResult).toEqual({ byteLength: Buffer.from('contents').byteLength, kind: 'file' });
		expect(fixture.sshTransport.sftpClient.readdirCalls).toEqual(['/workspace/agent']);
		expect(fixture.sshTransport.sftpClient.mkdirCalls).toEqual(['/workspace/new']);
		expect(fixture.sshTransport.sftpClient.lstatCalls).toEqual(['/workspace/memory.md']);
		expect(fixture.sshTransport.sftpClient.unlinkCalls).toEqual(['/workspace/old.md']);
		expect(fixture.sshTransport.sftpClient.rmdirCalls).toEqual(['/workspace/old']);
		expect(fixture.sshTransport.sftpClient.realpathCalls).toHaveLength(0);
	});

	it.each(['relative/path', '/workspace/bad\0path'])(
		'rejects invalid direct Sandbox guest path %s before SFTP',
		async (requestedPath) => {
			// Arrange
			const fixture = createStrictSshFixture();
			await connectFixture(fixture);

			// Act
			const read = fixture.client.guestReadFile({ path: requestedPath });

			// Assert
			await expect(read).rejects.toThrow(/guest-absolute|nul/i);
			expect(fixture.sshTransport.sftpClient.readFileCalls).toHaveLength(0);
		},
	);

	it('returns bounded normalized stat metadata after the full path fence', async () => {
		const fixture = createStrictSshFixture();
		fixture.sshTransport.sftpClient.fileBytes = Buffer.alloc(37);
		await connectFixture(fixture);

		const stat = await fixture.client.stat({ path: 'src/index.ts' });

		expect(stat).toEqual({ byteLength: 37, kind: 'file' });
		expect(fixture.sshTransport.sftpClient.lstatCalls).toEqual([
			'/work/src',
			'/work/src/index.ts',
			'/work/src/index.ts',
		]);
		expect(fixture.sshTransport.sftpClient.realpathCalls).toEqual([
			'/work/src',
			'/work/src/index.ts',
		]);
	});

	it('fences and executes bounded write, mkdir, rename, and remove operations', async () => {
		const fixture = createStrictSshFixture();
		fixture.sshTransport.sftpClient.missingPaths.add('/work/new.txt');
		fixture.sshTransport.sftpClient.missingPaths.add('/work/new-dir');
		fixture.sshTransport.sftpClient.missingPaths.add('/work/renamed.txt');
		await connectFixture(fixture);

		await fixture.client.writeFile({ bytes: Buffer.from('new'), path: 'new.txt' });
		await fixture.client.mkdir({ path: 'new-dir' });
		await fixture.client.rename({ fromPath: 'source.txt', toPath: 'renamed.txt' });
		await fixture.client.remove({ kind: 'file', path: 'source.txt' });
		await fixture.client.remove({ kind: 'directory', path: 'old-dir' });

		expect(fixture.sshTransport.sftpClient.writeFileCalls).toEqual([
			{ bytes: Buffer.from('new'), remotePath: '/work/new.txt' },
		]);
		expect(fixture.sshTransport.sftpClient.mkdirCalls).toEqual(['/work/new-dir']);
		expect(fixture.sshTransport.sftpClient.renameCalls).toEqual([
			{ fromPath: '/work/source.txt', toPath: '/work/renamed.txt' },
		]);
		expect(fixture.sshTransport.sftpClient.unlinkCalls).toEqual(['/work/source.txt']);
		expect(fixture.sshTransport.sftpClient.rmdirCalls).toEqual(['/work/old-dir']);
	});

	it('rejects mutation path escapes and oversized writes before SFTP mutation', async () => {
		const fixture = createStrictSshFixture();
		await connectFixture(fixture);

		const escapedWrite = fixture.client.writeFile({
			bytes: Buffer.from('safe'),
			path: '../escape',
		});
		const oversizedWrite = fixture.client.writeFile({
			bytes: Buffer.alloc(strictLimits.maxWriteBytes + 1),
			path: 'large',
		});

		await expect(escapedWrite).rejects.toThrow(/work-relative path/i);
		await expect(oversizedWrite).rejects.toThrow(/write byte limit/i);
		expect(fixture.sshTransport.sftpClient.writeFileCalls).toHaveLength(0);
	});

	it('rejects work-root removal and rename before SFTP mutation', async () => {
		// Arrange
		const fixture = createStrictSshFixture();
		await connectFixture(fixture);

		// Act
		const removeWorkRoot = fixture.client.remove({ kind: 'directory', path: '' });
		const renameWorkRoot = fixture.client.rename({ fromPath: '', toPath: 'renamed-work' });

		// Assert
		await expect(removeWorkRoot).rejects.toThrow(/non-root work-relative path/i);
		await expect(renameWorkRoot).rejects.toThrow(/non-root work-relative path/i);
		expect(fixture.sshTransport.sftpClient.rmdirCalls).toHaveLength(0);
		expect(fixture.sshTransport.sftpClient.renameCalls).toHaveLength(0);
	});

	it('rejects an SFTP symlink whose realpath escapes /work', async () => {
		// Arrange
		const fixture = createStrictSshFixture();
		fixture.sshTransport.sftpClient.symlinkPaths.add('/work/link');
		fixture.sshTransport.sftpClient.realpathResults.set('/work/link', '/etc');
		await connectFixture(fixture);

		// Act
		const read = fixture.client.readFile({ path: 'link/passwd' });

		// Assert
		await expect(read).rejects.toThrow(/symlink.*work/i);
		expect(fixture.sshTransport.sftpClient.readFileCalls).toHaveLength(0);
	});

	it('rejects filesystem depth, symlink, byte, and directory-entry caps', async () => {
		// Arrange
		const depthFixture = createStrictSshFixture();
		const symlinkFixture = createStrictSshFixture();
		const byteFixture = createStrictSshFixture();
		const entryFixture = createStrictSshFixture();
		symlinkFixture.sshTransport.sftpClient.symlinkPaths.add('/work/one');
		symlinkFixture.sshTransport.sftpClient.symlinkPaths.add('/work/one/two');
		byteFixture.sshTransport.sftpClient.fileBytes = Buffer.alloc(strictLimits.maxFileBytes + 1);
		entryFixture.sshTransport.sftpClient.directoryEntries = Array.from(
			{ length: strictLimits.maxDirectoryEntries + 1 },
			(_unused, index) => ({
				attrs: {} as Stats,
				filename: `entry-${index}`,
				longname: `entry-${index}`,
			}),
		);
		await Promise.all([
			connectFixture(depthFixture),
			connectFixture(symlinkFixture),
			connectFixture(byteFixture),
			connectFixture(entryFixture),
		]);

		// Act
		const depthRead = depthFixture.client.readFile({ path: 'one/two/three/four' });
		const symlinkRead = symlinkFixture.client.readFile({ path: 'one/two/file' });
		const byteRead = byteFixture.client.readFile({ path: 'large' });
		const directoryRead = entryFixture.client.listDirectory({ path: '' });

		// Assert
		await expect(depthRead).rejects.toThrow(/depth limit/i);
		await expect(symlinkRead).rejects.toThrow(/symlink limit/i);
		await expect(byteRead).rejects.toThrow(/byte limit/i);
		await expect(directoryRead).rejects.toThrow(/entry limit/i);
	});
});
