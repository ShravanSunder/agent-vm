import type { ManagedVmCreateRequest } from '@agent-vm/managed-vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

const createNativeManagedVmMock = vi.hoisted(() => vi.fn());
const buildImageMock = vi.hoisted(() => vi.fn());

vi.mock('./build-pipeline.js', async (importOriginal) => {
	const originalModule = await importOriginal<typeof import('./build-pipeline.js')>();
	return {
		...originalModule,
		buildImage: buildImageMock,
	};
});

vi.mock('./vm-adapter.js', async (importOriginal) => {
	const originalModule = await importOriginal<typeof import('./vm-adapter.js')>();
	return {
		...originalModule,
		createManagedVm: createNativeManagedVmMock,
	};
});

import { createGondolinManagedVmProvider } from './managed-vm-provider.js';

interface FakeNativeExecProcess extends PromiseLike<unknown>, AsyncIterable<string> {
	readonly end: ReturnType<typeof vi.fn>;
	lines(): AsyncIterable<string>;
	output(): AsyncIterable<{
		readonly data: Buffer;
		readonly stream: 'stdout';
		readonly text: string;
	}>;
	readonly resize: ReturnType<typeof vi.fn>;
	readonly result: Promise<unknown>;
	readonly write: ReturnType<typeof vi.fn>;
}

function createFakeNativeExecProcess(): FakeNativeExecProcess {
	const execResult = {
		exitCode: 0,
		lines: (): string[] => ['ok'],
		ok: true,
		signal: undefined,
		stderr: '',
		stderrBuffer: Buffer.alloc(0),
		stdout: 'ok',
		stdoutBuffer: Buffer.from('ok'),
		toString: (): string => 'ok',
	};
	const awaitableResult = Promise.resolve(execResult);
	const result = Promise.resolve(execResult);
	return Object.assign(awaitableResult, {
		[Symbol.asyncIterator]: async function* (): AsyncIterableIterator<string> {
			yield 'ok';
		},
		end: vi.fn(),
		lines: async function* (): AsyncIterableIterator<string> {
			yield 'ok';
		},
		output: async function* () {
			yield { data: Buffer.from('ok'), stream: 'stdout' as const, text: 'ok' };
		},
		resize: vi.fn(),
		result,
		write: vi.fn(),
	});
}

async function collectAsync<TValue>(iterable: AsyncIterable<TValue>): Promise<readonly TValue[]> {
	const values: TValue[] = [];
	for await (const value of iterable) {
		values.push(value);
	}
	return values;
}

interface Deferred<TValue> {
	readonly promise: Promise<TValue>;
	reject(error: unknown): void;
	resolve(value: TValue): void;
}

function rejectUninitializedDeferred(_value: unknown): never {
	throw new Error('Deferred callback was used before Promise initialization.');
}

function createDeferred<TValue>(): Deferred<TValue> {
	let resolvePromise: (value: TValue) => void = rejectUninitializedDeferred;
	let rejectPromise: (error: unknown) => void = rejectUninitializedDeferred;
	const promise = new Promise<TValue>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	return { promise, reject: rejectPromise, resolve: resolvePromise };
}

interface LifecycleNativeVm {
	readonly close: ReturnType<typeof vi.fn>;
	readonly enableIngress: ReturnType<typeof vi.fn>;
	readonly enableSsh: ReturnType<typeof vi.fn>;
	readonly exec: ReturnType<typeof vi.fn>;
	readonly getHostPid: ReturnType<typeof vi.fn>;
	readonly id: string;
	readonly setIngressRoutes: ReturnType<typeof vi.fn>;
	readonly start: ReturnType<typeof vi.fn>;
}

function createLifecycleNativeVm(start: () => Promise<void>): LifecycleNativeVm {
	return {
		close: vi.fn(async () => {}),
		enableIngress: vi.fn(),
		enableSsh: vi.fn(),
		exec: vi.fn(() => createFakeNativeExecProcess()),
		getHostPid: vi.fn(() => 4321),
		id: 'lifecycle-vm',
		setIngressRoutes: vi.fn(),
		start: vi.fn(start),
	};
}

function createBasicManagedVmRequest(): ManagedVmCreateRequest {
	return {
		allowedHosts: [],
		environment: {},
		imageReference: '/images/test',
		mediatedSecrets: [],
		mounts: {},
		resources: { cpuCount: 1, memory: '1G' },
		rootfsMode: 'memory',
		sessionLabel: 'lifecycle-test',
		tcpHosts: [],
	};
}

describe('createGondolinManagedVmProvider', () => {
	afterEach(() => {
		buildImageMock.mockReset();
		createNativeManagedVmMock.mockReset();
	});

	it('exposes only the four neutral provider capabilities', () => {
		const provider = createGondolinManagedVmProvider();

		expect(Object.keys(provider).toSorted()).toEqual([
			'diagnostics',
			'factory',
			'images',
			'ownedDirectories',
		]);
	});

	it('rejects unsupported closed variants before constructing Gondolin state', async () => {
		const provider = createGondolinManagedVmProvider();
		const baseRequest = {
			allowedHosts: [],
			environment: {},
			imageReference: '/images/test',
			mediatedSecrets: [],
			mounts: {},
			resources: { cpuCount: 1, memory: '1G' },
			rootfsMode: 'memory' as const,
			sessionLabel: 'test',
			tcpHosts: [],
		};

		await expect(
			provider.factory.createManagedVm({ ...baseRequest, rootfsMode: 'overlay' } as never),
		).rejects.toThrow('Unsupported managed VM rootfs mode');
		await expect(
			provider.factory.createManagedVm({
				...baseRequest,
				sshEgress: { allowedHosts: [], kind: 'shell' },
			} as never),
		).rejects.toThrow('Unsupported managed VM SSH egress kind');
		await expect(
			provider.factory.createManagedVm({
				...baseRequest,
				mounts: { '/work': { kind: 'native-provider' } },
			} as never),
		).rejects.toThrow('Unsupported managed VM mount kind');
		await expect(
			provider.factory.createManagedVm({
				...baseRequest,
				resources: { cpuCount: 0, memory: '1G' },
			}),
		).rejects.toThrow('CPU count must be a positive safe integer');
		expect(createNativeManagedVmMock).not.toHaveBeenCalled();
	});

	it('rejects duplicate mediated-secret and TCP keys before native construction', async () => {
		const provider = createGondolinManagedVmProvider();
		const request = createBasicManagedVmRequest();

		await expect(
			provider.factory.createManagedVm({
				...request,
				mediatedSecrets: [
					{ allowedHosts: ['one.example'], environmentVariable: 'TOKEN', value: 'one' },
					{ allowedHosts: ['two.example'], environmentVariable: 'TOKEN', value: 'two' },
				],
			}),
		).rejects.toThrow('Duplicate managed VM mediated-secret environment variable: TOKEN');
		await expect(
			provider.factory.createManagedVm({
				...request,
				tcpHosts: [
					{ guestHost: 'service.vm.host:443', target: '127.0.0.1:443' },
					{ guestHost: 'service.vm.host:443', target: '127.0.0.1:8443' },
				],
			}),
		).rejects.toThrow('Duplicate managed VM TCP guest host: service.vm.host:443');
		expect(createNativeManagedVmMock).not.toHaveBeenCalled();
	});

	it('translates neutral request fields without putting raw mediated values in guest env', async () => {
		const nativeExecProcess = createFakeNativeExecProcess();
		let nativeHostProcessId: number | null = 4321;
		const closeSshAccess = vi.fn(async () => {});
		const serverHostKey = {
			algorithm: 'ssh-ed25519' as const,
			publicKeyBase64: 'AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
		};
		const nativeVm = {
			close: vi.fn(async () => {}),
			enableIngress: vi.fn(async () => ({ close: async () => {}, host: '127.0.0.1', port: 1 })),
			enableSsh: vi.fn(async () => ({
				close: closeSshAccess,
				command: 'ssh root@127.0.0.1',
				host: '127.0.0.1',
				identityFile: '/tmp/id_ed25519',
				port: 2222,
				serverHostKey,
				user: 'root',
			})),
			exec: vi.fn(() => nativeExecProcess),
			getHostPid: vi.fn((): number | null => nativeHostProcessId),
			id: 'gondolin-1',
			setIngressRoutes: vi.fn(),
			start: vi.fn(async () => {}),
		};
		createNativeManagedVmMock.mockResolvedValue(nativeVm);
		const provider = createGondolinManagedVmProvider();

		const vm = await provider.factory.createManagedVm({
			allowedHosts: ['example.com'],
			environment: { SAFE: 'guest-visible' },
			imageReference: '/images/test',
			mediatedSecrets: [
				{
					allowedHosts: ['api.example.com'],
					environmentVariable: 'API_TOKEN',
					value: 'host-only-secret',
				},
			],
			mounts: { '/tmp': { kind: 'memory' } },
			resources: { cpuCount: 2, memory: '2G' },
			rootfsMode: 'cow',
			runtimeRootfsSize: '4G',
			sessionLabel: 'session-1',
			sshEgress: {
				allowedHosts: ['github.com'],
				allowedRepositories: ['owner/repo'],
				kind: 'git-read-only',
			},
			tcpHosts: [{ guestHost: 'controller.vm.host:18800', target: '127.0.0.1:18800' }],
		});

		expect(createNativeManagedVmMock).toHaveBeenCalledWith(
			expect.objectContaining({
				allowedHosts: ['example.com'],
				cpus: 2,
				env: { SAFE: 'guest-visible' },
				imagePath: '/images/test',
				memory: '2G',
				rootfsMode: 'cow',
				runtimeRootfsSize: '4G',
				secrets: {
					API_TOKEN: { hosts: ['api.example.com'], value: 'host-only-secret' },
				},
				sessionLabel: 'session-1',
				tcpHosts: { 'controller.vm.host:18800': '127.0.0.1:18800' },
				vfsMounts: { '/tmp': { kind: 'memory' } },
			}),
		);
		expect(vm.getHostProcessId()).toBeNull();
		await vm.start();
		nativeHostProcessId = 9876;
		expect(() => vm.getHostProcessId()).toThrow('runner identity changed');
		nativeHostProcessId = null;
		expect(vm.getHostProcessId()).toBeNull();

		const abortController = new AbortController();
		const manualStdin = Uint8Array.from([1, 2, 3]);
		const process = vm.exec(['node', 'script.js'], {
			argv: ['first', 'second'],
			cwd: '/work',
			env: { A: '1' },
			pty: true,
			signal: abortController.signal,
			stdin: manualStdin,
		});
		expect(nativeVm.exec).toHaveBeenLastCalledWith(['node', 'script.js'], {
			argv: ['first', 'second'],
			cwd: '/work',
			env: { A: '1' },
			pty: true,
			signal: abortController.signal,
			stdin: Buffer.from(manualStdin),
		});
		expect(await process).toMatchObject({ exitCode: 0, stdout: 'ok' });
		expect(process.result).toBe(nativeExecProcess.result);
		process.write(Uint8Array.from([4, 5]));
		process.resize(30, 120);
		process.end();
		expect(nativeExecProcess.write).toHaveBeenCalledWith(Buffer.from([4, 5]));
		expect(nativeExecProcess.resize).toHaveBeenCalledWith(30, 120);
		expect(nativeExecProcess.end).toHaveBeenCalledOnce();
		expect(await collectAsync(process.lines())).toEqual(['ok']);
		expect(await collectAsync(process.output())).toEqual([
			{ data: Buffer.from('ok'), stream: 'stdout', text: 'ok' },
		]);
		expect(await collectAsync(process)).toEqual(['ok']);

		vm.exec('echo "$A"', { env: ['A=2'], stdin: 'input' });
		expect(nativeVm.exec).toHaveBeenLastCalledWith('echo "$A"', {
			env: ['A=2'],
			stdin: 'input',
		});

		vm.configureIngressRoutes([{ port: 18_791, prefix: '/api', stripPrefix: true }]);
		expect(nativeVm.setIngressRoutes).toHaveBeenCalledWith([
			{ port: 18_791, prefix: '/api', stripPrefix: true },
		]);
		await vm.enableIngress({
			allowWebSockets: false,
			bufferResponseBody: true,
			listenHost: '127.0.0.1',
			listenPort: 18_792,
			maxBufferedResponseBodyBytes: 1024,
			upstreamHeaderTimeoutMs: 2000,
			upstreamResponseTimeoutMs: 3000,
		});
		expect(nativeVm.enableIngress).toHaveBeenCalledWith({
			allowWebSockets: false,
			bufferResponseBody: true,
			listenHost: '127.0.0.1',
			listenPort: 18_792,
			maxBufferedResponseBodyBytes: 1024,
			upstreamHeaderTimeoutMs: 2000,
			upstreamResponseTimeoutMs: 3000,
		});
		await expect(vm.enableSsh({ listenHost: '127.0.0.1', listenPort: 2222 })).resolves.toEqual(
			expect.objectContaining({ serverHostKey }),
		);
		expect(nativeVm.enableSsh).toHaveBeenCalledWith({ listenHost: '127.0.0.1', listenPort: 2222 });
	});

	it('transfers an owned directory exactly once and settles it closed with VM cleanup', async () => {
		const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gondolin-owned-directory-'));
		const nativeVm = {
			close: vi.fn(async () => {}),
			enableIngress: vi.fn(),
			enableSsh: vi.fn(),
			exec: vi.fn(),
			getHostPid: vi.fn(() => 19),
			id: 'gondolin-owned',
			setIngressRoutes: vi.fn(),
			start: vi.fn(async () => {}),
		};
		createNativeManagedVmMock.mockResolvedValue(nativeVm);
		const provider = createGondolinManagedVmProvider();
		const directory = provider.ownedDirectories.openHostDirectory(temporaryRoot);

		try {
			const vm = await provider.factory.createManagedVm({
				allowedHosts: [],
				environment: {},
				imageReference: '/images/test',
				mediatedSecrets: [],
				mounts: {
					'/work': { access: 'read-write', directory, kind: 'owned-host-directory' },
				},
				resources: { cpuCount: 1, memory: '1G' },
				rootfsMode: 'memory',
				sessionLabel: 'owned-test',
				tcpHosts: [],
			});

			expect(directory.state).toBe('adapter-owned');
			expect(() => directory.consume()).toThrow('cannot be consumed');
			await vm.close();
			expect(directory.state).toBe('closed');
			await vm.close();
			expect(nativeVm.close).toHaveBeenCalledOnce();
			expect(directory.state).toBe('closed');
		} finally {
			if (directory.state === 'acquired') {
				directory.close();
			}
			await fs.rm(temporaryRoot, { recursive: true });
		}
	});

	it('closes SSH access when the native identity omits required connection fields', async () => {
		const closeSshAccess = vi.fn(async () => {});
		const nativeVm = createLifecycleNativeVm(async () => {});
		nativeVm.enableSsh.mockResolvedValue({
			close: closeSshAccess,
			host: '127.0.0.1',
			port: 2222,
			serverHostKey: {
				algorithm: 'ssh-ed25519',
				publicKeyBase64: 'AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
			},
		});
		createNativeManagedVmMock.mockResolvedValue(nativeVm);
		const vm = await createGondolinManagedVmProvider().factory.createManagedVm(
			createBasicManagedVmRequest(),
		);

		await expect(vm.enableSsh()).rejects.toThrow('omitted required neutral connection fields');
		expect(closeSshAccess).toHaveBeenCalledOnce();
	});

	it('closes transferred ownership when Gondolin construction fails', async () => {
		const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gondolin-build-failure-'));
		createNativeManagedVmMock.mockRejectedValue(new Error('native construction failed'));
		const provider = createGondolinManagedVmProvider();
		const directory = provider.ownedDirectories.openHostDirectory(temporaryRoot);

		try {
			await expect(
				provider.factory.createManagedVm({
					allowedHosts: [],
					environment: {},
					imageReference: '/images/test',
					mediatedSecrets: [],
					mounts: {
						'/work': { access: 'read-only', directory, kind: 'owned-host-directory' },
					},
					resources: { cpuCount: 1, memory: '1G' },
					rootfsMode: 'memory',
					sessionLabel: 'failure-test',
					tcpHosts: [],
				}),
			).rejects.toThrow('native construction failed');
			expect(directory.state).toBe('closed');
		} finally {
			if (directory.state === 'acquired') {
				directory.close();
			}
			await fs.rm(temporaryRoot, { recursive: true });
		}
	});

	it('rejects cross-provider directory consumption without consuming caller ownership', async () => {
		const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gondolin-provenance-'));
		const acquiringProvider = createGondolinManagedVmProvider();
		const foreignProvider = createGondolinManagedVmProvider();
		const directory = acquiringProvider.ownedDirectories.openHostDirectory(temporaryRoot);

		try {
			await expect(
				foreignProvider.factory.createManagedVm({
					allowedHosts: [],
					environment: {},
					imageReference: '/images/test',
					mediatedSecrets: [],
					mounts: {
						'/work': { access: 'read-write', directory, kind: 'owned-host-directory' },
					},
					resources: { cpuCount: 1, memory: '1G' },
					rootfsMode: 'memory',
					sessionLabel: 'foreign-provider-test',
					tcpHosts: [],
				}),
			).rejects.toThrow('not acquired by this Gondolin provider');
			expect(createNativeManagedVmMock).not.toHaveBeenCalled();
			expect(directory.state).toBe('acquired');
			directory.close();
			expect(directory.state).toBe('closed');
		} finally {
			if (directory.state === 'acquired') {
				directory.close();
			}
			await fs.rm(temporaryRoot, { recursive: true });
		}
	});

	it('cleans earlier transfers when a later foreign mount fails without consuming the foreign capability', async () => {
		const firstRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gondolin-first-mount-'));
		const foreignRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gondolin-foreign-mount-'));
		const provider = createGondolinManagedVmProvider();
		const foreignProvider = createGondolinManagedVmProvider();
		const firstDirectory = provider.ownedDirectories.openHostDirectory(firstRoot);
		const foreignDirectory = foreignProvider.ownedDirectories.openHostDirectory(foreignRoot);

		try {
			await expect(
				provider.factory.createManagedVm({
					...createBasicManagedVmRequest(),
					mounts: {
						'/first': {
							access: 'read-write',
							directory: firstDirectory,
							kind: 'owned-host-directory',
						},
						'/foreign': {
							access: 'read-write',
							directory: foreignDirectory,
							kind: 'owned-host-directory',
						},
					},
				}),
			).rejects.toThrow('not acquired by this Gondolin provider');
			expect(createNativeManagedVmMock).not.toHaveBeenCalled();
			expect(firstDirectory.state).toBe('closed');
			expect(foreignDirectory.state).toBe('acquired');
			foreignDirectory.close();
		} finally {
			if (firstDirectory.state === 'acquired') {
				firstDirectory.close();
			}
			if (foreignDirectory.state === 'acquired') {
				foreignDirectory.close();
			}
			await fs.rm(firstRoot, { recursive: true });
			await fs.rm(foreignRoot, { recursive: true });
		}
	});

	it('fails start when Gondolin does not expose a positive host PID', async () => {
		createNativeManagedVmMock.mockResolvedValue({
			close: vi.fn(async () => {}),
			enableIngress: vi.fn(),
			enableSsh: vi.fn(),
			exec: vi.fn(),
			getHostPid: vi.fn(() => null),
			id: 'missing-pid',
			setIngressRoutes: vi.fn(),
			start: vi.fn(async () => {}),
		});
		const provider = createGondolinManagedVmProvider();
		const vm = await provider.factory.createManagedVm({
			allowedHosts: [],
			environment: {},
			imageReference: '/images/test',
			mediatedSecrets: [],
			mounts: {},
			resources: { cpuCount: 1, memory: '1G' },
			rootfsMode: 'memory',
			sessionLabel: 'pid-test',
			tcpHosts: [],
		});

		await expect(vm.start()).rejects.toThrow('positive stable host process ID');
		expect(vm.getHostProcessId()).toBeNull();
	});

	it('terminally prevents start after close-before-start', async () => {
		const nativeVm = createLifecycleNativeVm(async () => {});
		createNativeManagedVmMock.mockResolvedValue(nativeVm);
		const vm = await createGondolinManagedVmProvider().factory.createManagedVm(
			createBasicManagedVmRequest(),
		);

		await vm.close();
		await expect(vm.start()).rejects.toThrow('cannot start after close');
		expect(nativeVm.start).not.toHaveBeenCalled();
		expect(nativeVm.close).toHaveBeenCalledOnce();
		expect(vm.getHostProcessId()).toBeNull();
	});

	it('serializes close during successful start without publishing a terminal PID', async () => {
		const startSettlement = createDeferred<void>();
		const nativeVm = createLifecycleNativeVm(async () => await startSettlement.promise);
		createNativeManagedVmMock.mockResolvedValue(nativeVm);
		const vm = await createGondolinManagedVmProvider().factory.createManagedVm(
			createBasicManagedVmRequest(),
		);

		const startResult = vm.start();
		const closeResult = vm.close();
		expect(nativeVm.close).not.toHaveBeenCalled();
		startSettlement.resolve();
		await expect(startResult).rejects.toThrow('closed while startup was settling');
		await expect(closeResult).resolves.toBeUndefined();
		expect(nativeVm.close).toHaveBeenCalledOnce();
		expect(vm.getHostProcessId()).toBeNull();
	});

	it('serializes close through start failure and still releases resources', async () => {
		const startSettlement = createDeferred<void>();
		const nativeVm = createLifecycleNativeVm(async () => await startSettlement.promise);
		createNativeManagedVmMock.mockResolvedValue(nativeVm);
		const vm = await createGondolinManagedVmProvider().factory.createManagedVm(
			createBasicManagedVmRequest(),
		);

		const startResult = vm.start();
		const closeResult = vm.close();
		startSettlement.reject(new Error('native start failed'));
		await expect(startResult).rejects.toThrow('native start failed');
		await expect(closeResult).resolves.toBeUndefined();
		expect(nativeVm.close).toHaveBeenCalledOnce();
		expect(vm.getHostProcessId()).toBeNull();
		await expect(vm.start()).rejects.toThrow('cannot start after close');
	});

	it('loads JSONC recipes and returns a neutral image result', async () => {
		const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gondolin-image-recipe-'));
		const recipePath = path.join(temporaryRoot, 'build-config.jsonc');
		await fs.writeFile(
			recipePath,
			'{\n  // runtime recipe\n  "arch": "x86_64",\n  "distro": "alpine",\n}\n',
			'utf8',
		);
		buildImageMock.mockResolvedValue({
			built: true,
			fingerprint: 'fingerprint-1',
			imagePath: '/cache/fingerprint-1',
		});
		const provider = createGondolinManagedVmProvider();

		try {
			await expect(
				provider.images.prepareImage({
					cacheDirectory: '/cache',
					forceRebuild: true,
					recipePath,
				}),
			).resolves.toEqual({
				built: true,
				fingerprint: 'fingerprint-1',
				imageReference: '/cache/fingerprint-1',
			});
			expect(buildImageMock).toHaveBeenCalledWith({
				buildConfig: { arch: 'x86_64', distro: 'alpine' },
				cacheDir: '/cache',
				configDir: temporaryRoot,
				fullReset: true,
			});
		} finally {
			await fs.rm(temporaryRoot, { recursive: true });
		}
	});

	it('rejects an invalid JSONC build shape before invoking the image builder', async () => {
		const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gondolin-invalid-recipe-'));
		const recipePath = path.join(temporaryRoot, 'build-config.jsonc');
		await fs.writeFile(recipePath, '{ "arch": "invalid", "distro": "alpine" }', 'utf8');
		const provider = createGondolinManagedVmProvider();

		try {
			await expect(
				provider.images.prepareImage({ cacheDirectory: '/cache', recipePath }),
			).rejects.toThrow('invalid build shape');
			expect(buildImageMock).not.toHaveBeenCalled();
		} finally {
			await fs.rm(temporaryRoot, { recursive: true });
		}
	});

	it('reports malformed JSONC syntax separately from schema-invalid recipes', async () => {
		const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gondolin-malformed-recipe-'));
		const recipePath = path.join(temporaryRoot, 'build-config.jsonc');
		await fs.writeFile(recipePath, '{ "arch": ', 'utf8');
		const provider = createGondolinManagedVmProvider();

		try {
			await expect(
				provider.images.prepareImage({ cacheDirectory: '/cache', recipePath }),
			).rejects.toThrow('Invalid managed VM image recipe');
			expect(buildImageMock).not.toHaveBeenCalled();
		} finally {
			await fs.rm(temporaryRoot, { recursive: true });
		}
	});
});
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
