import net from 'node:net';
import { Readable } from 'node:stream';

import {
	MemoryProvider,
	createHttpHooks,
	type ExecProcess as GondolinExecProcess,
	type ExecResult as GondolinExecResult,
	type HttpHooks,
	type VMOptions,
	type VmFs as GondolinVmFs,
	type VirtualFileHandle,
	type VirtualProvider,
} from '@earendil-works/gondolin';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import { configureHostNetworkDefaults } from './host-network-defaults.js';
import type { PinnedRealFsRoot } from './pinned-realfs.js';
import {
	SYNTHETIC_DNS_IPV4_BENCHMARK,
	SYNTHETIC_DNS_IPV6_IPV4_MAPPED_BENCHMARK,
	createGitReadOnlySshEgressOptions,
	createHardenedReadonlyProvider,
	createManagedVm,
	parseSshServerHostKey,
	type ManagedVmDependencies,
	type ManagedVmInstance,
	type SshAccess,
} from './vm-adapter.js';

function createTestProvider(): VirtualProvider {
	return new MemoryProvider();
}

function setNonRootOwnership<TStats extends { gid: number; uid: number }>(stats: TStats): TStats {
	stats.gid = 4567;
	stats.uid = 1234;
	return stats;
}

function createNonRootMemoryProvider(): VirtualProvider {
	const provider: VirtualProvider = new MemoryProvider();
	const originalOpen = provider.open.bind(provider);
	const originalOpenSync = provider.openSync.bind(provider);
	const originalStat = provider.stat.bind(provider);
	const originalStatSync = provider.statSync.bind(provider);
	const originalLstat = provider.lstat.bind(provider);
	const originalLstatSync = provider.lstatSync.bind(provider);
	const wrapHandle = (handle: VirtualFileHandle): VirtualFileHandle => {
		const originalHandleStat = handle.stat.bind(handle);
		const originalHandleStatSync = handle.statSync.bind(handle);
		handle.stat = async (options?: object) =>
			setNonRootOwnership(await originalHandleStat(options));
		handle.statSync = (options?: object) => setNonRootOwnership(originalHandleStatSync(options));
		return handle;
	};
	provider.open = async (entryPath, flags, mode) =>
		wrapHandle(await originalOpen(entryPath, flags, mode));
	provider.openSync = (entryPath, flags, mode) =>
		wrapHandle(originalOpenSync(entryPath, flags, mode));
	provider.stat = async (entryPath, options) =>
		setNonRootOwnership(await originalStat(entryPath, options));
	provider.statSync = (entryPath, options) =>
		setNonRootOwnership(originalStatSync(entryPath, options));
	provider.lstat = async (entryPath, options) =>
		setNonRootOwnership(await originalLstat(entryPath, options));
	provider.lstatSync = (entryPath, options) =>
		setNonRootOwnership(originalLstatSync(entryPath, options));
	return provider;
}

/* oxlint-disable typescript-eslint/no-unsafe-type-assertion, unicorn/no-thenable -- This
   test double intentionally models Gondolin's awaitable ExecProcess shape. */
function createFakeExecProcess(result: {
	readonly exitCode: number;
	readonly stderr: string;
	readonly stdout: string;
}): GondolinExecProcess {
	const execResult = {
		exitCode: result.exitCode,
		stderr: result.stderr,
		stdout: result.stdout,
	} as GondolinExecResult;
	const resultPromise = Promise.resolve(execResult);
	return {
		[Symbol.asyncIterator]: async function* (): AsyncIterator<string> {
			yield result.stdout;
		},
		catch: resultPromise.catch.bind(resultPromise),
		finally: resultPromise.finally.bind(resultPromise),
		stderr: Readable.from([result.stderr]),
		stdout: Readable.from([result.stdout]),
		then: resultPromise.then.bind(resultPromise),
	} as GondolinExecProcess;
}
/* oxlint-enable typescript-eslint/no-unsafe-type-assertion, unicorn/no-thenable */

const readFakeVmFile = vi.fn(
	async (
		_filePath: string,
		options?: { readonly encoding?: BufferEncoding | null },
	): Promise<Buffer | string> => (options?.encoding ? 'file-data' : Buffer.from('file-data')),
);

function createFakeVmFs(): GondolinVmFs {
	return {
		access: vi.fn(async () => {}),
		deleteFile: vi.fn(async () => {}),
		listDir: vi.fn(async () => ['entry.txt']),
		mkdir: vi.fn(async () => {}),
		readFile: readFakeVmFile as unknown as GondolinVmFs['readFile'],
		readFileStream: vi.fn(async () => Readable.from([Buffer.from('file-data')])),
		rename: vi.fn(async () => {}),
		stat: vi.fn(async () => {
			throw new Error('stat not implemented in fake');
		}),
		writeFile: vi.fn(async () => {}),
	};
}

type TestManagedVmInstance = ManagedVmInstance & {
	getHostPid(): number | null;
};

const TEST_SSH_SERVER_HOST_KEY = {
	algorithm: 'ssh-ed25519',
	publicKeyBase64: 'AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
} as const;

function createFakeVmInstance(
	options: {
		readonly hostPid?: number | null;
		readonly start?: ManagedVmInstance['start'];
	} = {},
): TestManagedVmInstance {
	const exec = vi.fn((command: string | string[]) =>
		createFakeExecProcess({
			exitCode: 0,
			stderr: '',
			stdout:
				Array.isArray(command) && command[1] === '/etc/ssh/ssh_host_ed25519_key.pub'
					? `${TEST_SSH_SERVER_HOST_KEY.algorithm} ${TEST_SSH_SERVER_HOST_KEY.publicKeyBase64}\n`
					: 'ok',
		}),
	);
	return {
		fs: createFakeVmFs(),
		id: 'vm-123',
		exec,
		enableIngress: vi.fn(async () => ({
			close: async () => {},
			host: '127.0.0.1',
			port: 18791,
		})),
		enableSsh: vi.fn(async () => ({
			close: async () => {},
			command: 'ssh root@127.0.0.1',
			host: '127.0.0.1',
			identityFile: '/tmp/id_ed25519',
			port: 2222,
			user: 'root',
		})),
		getHostPid: vi.fn(() => options.hostPid ?? null),
		setIngressRoutes: vi.fn(),
		start: options.start ?? vi.fn(async () => {}),
		close: vi.fn(async () => {}),
	};
}

function createBaseDependencies(options?: {
	readonly configureHostNetworkDefaults?: () => ReturnType<typeof configureHostNetworkDefaults>;
	readonly createVm?: (vmOptions: VMOptions) => Promise<ManagedVmInstance>;
	readonly closePinnedRealFsRoot?: (root: PinnedRealFsRoot) => void;
	readonly createMemoryProvider?: () => VirtualProvider;
	readonly createPinnedRealFsProvider?: (root: PinnedRealFsRoot) => VirtualProvider;
	readonly createReadonlyProvider?: (provider: VirtualProvider) => VirtualProvider;
	readonly createRealFsProvider?: (hostPath: string) => VirtualProvider;
}): ManagedVmDependencies {
	return {
		configureHostNetworkDefaults: vi.fn(
			options?.configureHostNetworkDefaults ??
				(() =>
					({
						autoSelectFamily: false,
						dnsResultOrder: 'ipv4first',
					}) as const),
		),
		createHttpHooks: vi.fn(() => ({
			env: { HTTPS_PROXY: 'http://proxy.vm.host:8080' },
			httpHooks: {} satisfies HttpHooks,
		})),
		closePinnedRealFsRoot: vi.fn(options?.closePinnedRealFsRoot ?? (() => {})),
		createMemoryProvider: vi.fn(options?.createMemoryProvider ?? (() => createTestProvider())),
		createPinnedRealFsProvider: vi.fn(
			options?.createPinnedRealFsProvider ?? (() => createTestProvider()),
		),
		createReadonlyProvider: vi.fn(options?.createReadonlyProvider ?? (() => createTestProvider())),
		createRealFsProvider: vi.fn(options?.createRealFsProvider ?? (() => createTestProvider())),
		createShadowPathPredicate: vi.fn(() => () => true),
		createShadowProvider: vi.fn(() => createTestProvider()),
		createVm: vi.fn(options?.createVm ?? (async () => createFakeVmInstance())),
	} satisfies ManagedVmDependencies;
}

function createPinnedRoot(fd: number): PinnedRealFsRoot {
	return {
		device: 1,
		fd,
		hostPath: `/tmp/pinned-${fd}`,
		inode: fd,
		realPath: `/tmp/pinned-${fd}`,
	};
}

describe('createManagedVm', () => {
	it('finalizes writable and guest-read-only memory mounts before start', async () => {
		const rawProviders: VirtualProvider[] = [];
		let capturedVmOptions: VMOptions | undefined;
		const nativeVmStart = vi.fn(async () => {});
		const nativeVm = createFakeVmInstance({ hostPid: 4321, start: nativeVmStart });
		const dependencies = createBaseDependencies({
			createMemoryProvider: () => {
				const provider = createNonRootMemoryProvider();
				rawProviders.push(provider);
				return provider;
			},
			createReadonlyProvider: createHardenedReadonlyProvider,
			createVm: async (vmOptions) => {
				capturedVmOptions = vmOptions;
				return nativeVm;
			},
		});
		const managedVm = await createManagedVm(
			{
				allowedHosts: [],
				cpus: 1,
				imagePath: '/images/test',
				memory: '1G',
				rootfsMode: 'memory',
				secrets: {},
				vfsMounts: {
					'/run/environment': {
						access: 'read-write',
						kind: 'finalizable-memory',
					},
					'/run/structured': {
						access: 'read-only',
						kind: 'finalizable-memory',
					},
				},
			},
			dependencies,
		);

		const environmentContents = Uint8Array.from([1, 2, 3]);
		await managedVm.finalizeMemoryMount({
			files: [
				{
					contents: environmentContents,
					mode: 0o700,
					relativePath: 'nested/environment.sh',
				},
			],
			guestPath: '/run/environment',
		});
		environmentContents[0] = 9;
		await managedVm.finalizeMemoryMount({
			files: [
				{
					contents: Uint8Array.from([4, 5, 6]),
					mode: 0o600,
					relativePath: 'service.json',
				},
			],
			guestPath: '/run/structured',
		});
		await managedVm.start();

		expect(rawProviders).toHaveLength(2);
		await expect(rawProviders[0]?.readFile?.('/nested/environment.sh')).resolves.toEqual(
			Buffer.from([1, 2, 3]),
		);
		await expect(rawProviders[1]?.readFile?.('/service.json')).resolves.toEqual(
			Buffer.from([4, 5, 6]),
		);
		const guestMounts = capturedVmOptions?.vfs?.mounts;
		const guestEnvironmentProvider = guestMounts?.['/run/environment'];
		const guestStructuredProvider = guestMounts?.['/run/structured'];
		if (!guestEnvironmentProvider || !guestStructuredProvider) {
			throw new Error('Expected both finalizable memory providers in Gondolin VM options.');
		}
		expect(guestEnvironmentProvider).not.toBe(rawProviders[0]);
		expect(guestMounts?.['/run/structured']).not.toBe(rawProviders[1]);
		const environmentPathStats = await guestEnvironmentProvider.stat('/nested/environment.sh');
		const environmentLinkStats = await guestEnvironmentProvider.lstat('/nested/environment.sh');
		const structuredPathStats = guestStructuredProvider.statSync('/service.json');
		const structuredHandle = await guestStructuredProvider.open('/service.json', 'r');
		const structuredHandleStats = await structuredHandle.stat();
		const environmentHandle = guestEnvironmentProvider.openSync('/nested/environment.sh', 'r');
		const environmentHandleStats = environmentHandle.statSync();
		expect(environmentPathStats).toMatchObject({ gid: 0, uid: 0 });
		expect(environmentLinkStats).toMatchObject({ gid: 0, uid: 0 });
		expect(structuredPathStats).toMatchObject({ gid: 0, mode: expect.any(Number), uid: 0 });
		expect(structuredHandleStats).toMatchObject({ gid: 0, size: 3, uid: 0 });
		expect(environmentHandleStats).toMatchObject({ gid: 0, size: 3, uid: 0 });
		await structuredHandle.close();
		environmentHandle.closeSync();
		await expect(guestEnvironmentProvider.unlink('/nested/environment.sh')).resolves.toBe(
			undefined,
		);
		await expect(guestStructuredProvider.unlink('/service.json')).rejects.toMatchObject({
			code: 'EROFS',
		});
		expect(nativeVmStart).toHaveBeenCalledOnce();
	});

	it('poisons the VM when finalization fails and rejects duplicate or late finalization', async () => {
		const failingProvider = new MemoryProvider();
		failingProvider.writeFile = vi.fn(async () => {
			throw new Error('injected memory write failure');
		});
		const nativeVmStart = vi.fn(async () => {});
		const nativeVm = createFakeVmInstance({ hostPid: 4321, start: nativeVmStart });
		const managedVm = await createManagedVm(
			{
				allowedHosts: [],
				cpus: 1,
				imagePath: '/images/test',
				memory: '1G',
				rootfsMode: 'memory',
				secrets: {},
				vfsMounts: {
					'/run/inputs': {
						access: 'read-only',
						kind: 'finalizable-memory',
					},
				},
			},
			createBaseDependencies({
				createMemoryProvider: () => failingProvider,
				createVm: async () => nativeVm,
			}),
		);

		await expect(
			managedVm.finalizeMemoryMount({
				files: [
					{
						contents: Uint8Array.from([1]),
						mode: 0o600,
						relativePath: 'service.json',
					},
				],
				guestPath: '/run/inputs',
			}),
		).rejects.toThrow('injected memory write failure');
		await expect(managedVm.start()).rejects.toThrow('poisoned');
		await expect(
			managedVm.finalizeMemoryMount({
				files: [],
				guestPath: '/run/inputs',
			}),
		).rejects.toThrow('poisoned');
		expect(nativeVmStart).not.toHaveBeenCalled();

		const successfulVm = await createManagedVm(
			{
				allowedHosts: [],
				cpus: 1,
				imagePath: '/images/test',
				memory: '1G',
				rootfsMode: 'memory',
				secrets: {},
				vfsMounts: {
					'/run/inputs': {
						access: 'read-only',
						kind: 'finalizable-memory',
					},
				},
			},
			createBaseDependencies({
				createMemoryProvider: () => new MemoryProvider(),
				createVm: async () => createFakeVmInstance({ hostPid: 4322 }),
			}),
		);
		await successfulVm.finalizeMemoryMount({ files: [], guestPath: '/run/inputs' });
		await expect(
			successfulVm.finalizeMemoryMount({ files: [], guestPath: '/run/inputs' }),
		).rejects.toThrow('exactly once');
		await expect(successfulVm.start()).rejects.toThrow('poisoned');

		const incompleteVmNativeStart = vi.fn(async () => {});
		const incompleteVmNative = createFakeVmInstance({
			hostPid: 4323,
			start: incompleteVmNativeStart,
		});
		const incompleteVm = await createManagedVm(
			{
				allowedHosts: [],
				cpus: 1,
				imagePath: '/images/test',
				memory: '1G',
				rootfsMode: 'memory',
				secrets: {},
				vfsMounts: {
					'/run/inputs': {
						access: 'read-only',
						kind: 'finalizable-memory',
					},
				},
			},
			createBaseDependencies({
				createMemoryProvider: () => new MemoryProvider(),
				createVm: async () => incompleteVmNative,
			}),
		);
		await expect(incompleteVm.start()).rejects.toThrow('must be finalized before start');
		await expect(
			incompleteVm.finalizeMemoryMount({ files: [], guestPath: '/run/inputs' }),
		).rejects.toThrow('poisoned');
		expect(incompleteVmNativeStart).not.toHaveBeenCalled();
	});

	it('closes pinned roots when finalizable memory provider construction fails', async () => {
		const pinnedRoot = createPinnedRoot(91);
		const closePinnedRealFsRoot = vi.fn();
		const createVm = vi.fn(async () => createFakeVmInstance());

		await expect(
			createManagedVm(
				{
					allowedHosts: [],
					cpus: 1,
					imagePath: '/images/test',
					memory: '1G',
					rootfsMode: 'memory',
					secrets: {},
					vfsMounts: {
						'/state': {
							kind: 'realfs',
							pinnedHostRoot: pinnedRoot,
						},
						'/run/inputs': {
							access: 'read-only',
							kind: 'finalizable-memory',
						},
					},
				},
				createBaseDependencies({
					closePinnedRealFsRoot,
					createMemoryProvider: () => {
						throw new Error('injected provider construction failure');
					},
					createVm,
				}),
			),
		).rejects.toThrow('injected provider construction failure');
		expect(closePinnedRealFsRoot).toHaveBeenCalledWith(pinnedRoot);
		expect(createVm).not.toHaveBeenCalled();
	});

	it('requires a structured ssh-ed25519 server host key in ManagedVm SSH access', () => {
		expectTypeOf<SshAccess>().toHaveProperty('serverHostKey').toEqualTypeOf<{
			readonly algorithm: 'ssh-ed25519';
			readonly publicKeyBase64: string;
		}>();
	});

	it('parses one exact ssh-ed25519 public host key with an optional comment', () => {
		expect(
			parseSshServerHostKey(
				`${TEST_SSH_SERVER_HOST_KEY.algorithm} ${TEST_SSH_SERVER_HOST_KEY.publicKeyBase64} root@tool-vm\n`,
			),
		).toEqual(TEST_SSH_SERVER_HOST_KEY);
	});

	it('rejects ambiguous or malformed SSH server host-key output', () => {
		expect(() => parseSshServerHostKey('ssh-rsa invalid\n')).toThrow(
			'Tool VM did not expose a valid ssh-ed25519 server host key',
		);
		expect(() =>
			parseSshServerHostKey(
				`${TEST_SSH_SERVER_HOST_KEY.algorithm} ${TEST_SSH_SERVER_HOST_KEY.publicKeyBase64}\n${TEST_SSH_SERVER_HOST_KEY.algorithm} ${TEST_SSH_SERVER_HOST_KEY.publicKeyBase64}\n`,
			),
		).toThrow('Tool VM did not expose exactly one ssh-ed25519 server host key');
	});

	it('forces host Node DNS and family-autoselection defaults for Gondolin tcpHosts', () => {
		const setDefaultResultOrder = vi.fn();
		const setDefaultAutoSelectFamily = vi.fn();

		const result = configureHostNetworkDefaults({
			setDefaultAutoSelectFamily,
			setDefaultResultOrder,
		});

		expect(setDefaultResultOrder).toHaveBeenCalledWith('ipv4first');
		expect(setDefaultAutoSelectFamily).toHaveBeenCalledWith(false);
		expect(result).toEqual({
			autoSelectFamily: false,
			dnsResultOrder: 'ipv4first',
		});
	});

	it('reports unavailable host network default APIs without failing startup', () => {
		const result = configureHostNetworkDefaults({
			setDefaultAutoSelectFamily: undefined,
			setDefaultResultOrder: undefined,
		});

		expect(result).toEqual({
			autoSelectFamily: 'unavailable',
			dnsResultOrder: 'unavailable',
		});
	});

	it('configures host network defaults before creating Gondolin VM state', async () => {
		const startupEvents: string[] = [];
		const dependencies = createBaseDependencies({
			configureHostNetworkDefaults: () => {
				startupEvents.push('host-network-defaults');
				return {
					autoSelectFamily: false,
					dnsResultOrder: 'ipv4first',
				};
			},
			createVm: vi.fn(async (): Promise<ManagedVmInstance> => {
				startupEvents.push('create-vm');
				return createFakeVmInstance();
			}),
		});

		await createManagedVm(
			{
				allowedHosts: [],
				cpus: 1,
				imagePath: '/vm-images/gateways/hermes',
				memory: '1G',
				rootfsMode: 'memory',
				secrets: {},
				vfsMounts: {},
			},
			dependencies,
		);

		expect(dependencies.configureHostNetworkDefaults).toHaveBeenCalledOnce();
		expect(startupEvents.slice(0, 2)).toEqual(['host-network-defaults', 'create-vm']);
	});

	it('uses an IPv4-mapped RFC2544 synthetic AAAA address for Hermes SSRF compatibility', () => {
		expect(SYNTHETIC_DNS_IPV4_BENCHMARK).toBe('198.18.0.1');
		expect(SYNTHETIC_DNS_IPV6_IPV4_MAPPED_BENCHMARK).toBe('::ffff:198.18.0.1');
		expect(net.isIP(SYNTHETIC_DNS_IPV6_IPV4_MAPPED_BENCHMARK)).toBe(6);
		expect(SYNTHETIC_DNS_IPV6_IPV4_MAPPED_BENCHMARK).toContain(SYNTHETIC_DNS_IPV4_BENCHMARK);
	});

	it('keeps the synthetic AAAA value outside Gondolin default internal-range blocking', async () => {
		const { httpHooks } = createHttpHooks({
			allowedHosts: ['cdn.discordapp.com'],
		});
		const isIpAllowed = httpHooks.isIpAllowed;
		if (!isIpAllowed) {
			throw new Error('expected Gondolin createHttpHooks to provide isIpAllowed');
		}

		await expect(
			isIpAllowed({
				family: 6,
				hostname: 'cdn.discordapp.com',
				ip: SYNTHETIC_DNS_IPV6_IPV4_MAPPED_BENCHMARK,
				port: 443,
				protocol: 'https',
			}),
		).resolves.toBe(true);
	});

	it('uses Hermes-compatible synthetic DNS ranges when TCP host mapping is enabled', async () => {
		let capturedVmOptions: VMOptions | undefined;
		let capturedIsIpAllowed: HttpHooks['isIpAllowed'] | undefined;
		const createHttpHooksMock = vi.fn(
			(_hookOptions: Parameters<ManagedVmDependencies['createHttpHooks']>[0]) => ({
				env: { HTTPS_PROXY: 'http://proxy.vm.host:8080' },
				httpHooks: {} satisfies HttpHooks,
			}),
		);
		const dependencies = {
			...createBaseDependencies({
				createVm: vi.fn(async (vmOptions: VMOptions): Promise<ManagedVmInstance> => {
					capturedVmOptions = vmOptions;
					return createFakeVmInstance();
				}),
			}),
			createHttpHooks: createHttpHooksMock,
		} satisfies ManagedVmDependencies;
		createHttpHooksMock.mockImplementation((hookOptions) => {
			capturedIsIpAllowed = hookOptions.isIpAllowed;
			return {
				env: { HTTPS_PROXY: 'http://proxy.vm.host:8080' },
				httpHooks: {} satisfies HttpHooks,
			};
		});

		await createManagedVm(
			{
				allowedHosts: [],
				cpus: 1,
				env: {},
				imagePath: '',
				memory: '1G',
				rootfsMode: 'memory',
				secrets: {},
				tcpHosts: {
					'controller.vm.host:18800': '127.0.0.1:18800',
				},
				vfsMounts: {},
			},
			dependencies,
		);

		expect(capturedVmOptions?.dns).toEqual({
			mode: 'synthetic',
			syntheticIPv4: SYNTHETIC_DNS_IPV4_BENCHMARK,
			syntheticIPv6: SYNTHETIC_DNS_IPV6_IPV4_MAPPED_BENCHMARK,
			syntheticHostMapping: 'per-host',
		});
		expect(createHttpHooksMock).toHaveBeenCalledWith({
			allowedHosts: [],
			allowedInternalHosts: ['controller.vm.host'],
			isIpAllowed: expect.any(Function),
			secrets: {},
		});
		if (!capturedIsIpAllowed) {
			throw new Error('Expected port-aware internal host policy.');
		}
		await expect(
			Promise.resolve(
				capturedIsIpAllowed({
					family: 4,
					hostname: 'controller.vm.host',
					ip: '127.0.0.1',
					port: 18_800,
					protocol: 'http',
				}),
			),
		).resolves.toBe(true);
		await expect(
			Promise.resolve(
				capturedIsIpAllowed({
					family: 4,
					hostname: 'controller.vm.host',
					ip: '127.0.0.1',
					port: 18_801,
					protocol: 'http',
				}),
			),
		).resolves.toBe(false);
		await expect(
			Promise.resolve(
				capturedIsIpAllowed({
					family: 4,
					hostname: 'unmapped.vm.host',
					ip: '127.0.0.1',
					port: 18_800,
					protocol: 'http',
				}),
			),
		).resolves.toBe(false);
	});

	it('passes SSH egress config into Gondolin VM options and enables synthetic DNS', async () => {
		let capturedVmOptions: VMOptions | undefined;
		const sshEgress = createGitReadOnlySshEgressOptions({
			allowedHosts: ['github.com'],
			allowedRepos: ['acme/widgets.git'],
		});
		const dependencies = createBaseDependencies({
			createVm: vi.fn(async (vmOptions: VMOptions): Promise<ManagedVmInstance> => {
				capturedVmOptions = vmOptions;
				return createFakeVmInstance();
			}),
		});

		await createManagedVm(
			{
				allowedHosts: [],
				cpus: 1,
				env: {},
				imagePath: '',
				memory: '1G',
				rootfsMode: 'memory',
				secrets: {},
				sshEgress,
				vfsMounts: {},
			},
			dependencies,
		);

		expect(capturedVmOptions?.dns).toEqual({
			mode: 'synthetic',
			syntheticIPv4: SYNTHETIC_DNS_IPV4_BENCHMARK,
			syntheticIPv6: SYNTHETIC_DNS_IPV6_IPV4_MAPPED_BENCHMARK,
			syntheticHostMapping: 'per-host',
		});
		expect(capturedVmOptions?.ssh).toBe(sshEgress);
		expect(capturedVmOptions?.tcp).toBeUndefined();
	});

	it('allows git-upload-pack while denying receive-pack and non-git SSH exec', async () => {
		const sshEgress = createGitReadOnlySshEgressOptions({
			allowedHosts: ['github.com'],
			allowedRepos: ['acme/widgets.git'],
		});
		if (!sshEgress.execPolicy) {
			throw new Error('Expected git read-only SSH exec policy');
		}

		await expect(
			Promise.resolve(
				sshEgress.execPolicy({
					command: "git-upload-pack 'acme/widgets.git'",
					guestUsername: 'git',
					hostname: 'github.com',
					port: 22,
					src: { ip: '198.18.0.2', port: 48_000 },
				}),
			),
		).resolves.toEqual({ allow: true });
		await expect(
			Promise.resolve(
				sshEgress.execPolicy({
					command: "git-receive-pack 'acme/widgets.git'",
					guestUsername: 'git',
					hostname: 'github.com',
					port: 22,
					src: { ip: '198.18.0.2', port: 48_001 },
				}),
			),
		).resolves.toMatchObject({ allow: false });
		await expect(
			Promise.resolve(
				sshEgress.execPolicy({
					command: "git-upload-pack 'acme/other.git'",
					guestUsername: 'git',
					hostname: 'github.com',
					port: 22,
					src: { ip: '198.18.0.2', port: 48_002 },
				}),
			),
		).resolves.toMatchObject({ allow: false });
		await expect(
			Promise.resolve(
				sshEgress.execPolicy({
					command: 'bash',
					guestUsername: 'git',
					hostname: 'github.com',
					port: 22,
					src: { ip: '198.18.0.2', port: 48_003 },
				}),
			),
		).resolves.toMatchObject({ allow: false });
	});

	it('keeps generic SSH repo allowlists case-sensitive', async () => {
		const sshEgress = createGitReadOnlySshEgressOptions({
			allowedHosts: ['git.example.com'],
			allowedRepos: ['Team/Repo.git'],
		});
		if (!sshEgress.execPolicy) {
			throw new Error('Expected git read-only SSH exec policy');
		}

		await expect(
			Promise.resolve(
				sshEgress.execPolicy({
					command: "git-upload-pack 'Team/Repo.git'",
					guestUsername: 'git',
					hostname: 'git.example.com',
					port: 22,
					src: { ip: '198.18.0.2', port: 48_000 },
				}),
			),
		).resolves.toEqual({ allow: true });
		await expect(
			Promise.resolve(
				sshEgress.execPolicy({
					command: "git-upload-pack 'team/repo.git'",
					guestUsername: 'git',
					hostname: 'git.example.com',
					port: 22,
					src: { ip: '198.18.0.2', port: 48_001 },
				}),
			),
		).resolves.toMatchObject({ allow: false });
	});

	it('does not turn public raw TCP hosts into HTTP allowed hosts', async () => {
		const createHttpHooksMock = vi.fn(() => ({
			env: { HTTPS_PROXY: 'http://proxy.vm.host:8080' },
			httpHooks: {} satisfies HttpHooks,
		}));
		const dependencies = {
			...createBaseDependencies(),
			createHttpHooks: createHttpHooksMock,
		} satisfies ManagedVmDependencies;

		await createManagedVm(
			{
				allowedHosts: ['api.openai.com'],
				cpus: 1,
				env: {},
				imagePath: '',
				memory: '1G',
				rootfsMode: 'memory',
				secrets: {},
				tcpHosts: {
					'raw-tcp.example.test:443': 'public.example.test:9443',
				},
				vfsMounts: {},
			},
			dependencies,
		);

		expect(createHttpHooksMock).toHaveBeenCalledWith({
			allowedHosts: ['api.openai.com'],
			secrets: {},
		});
	});

	it('translates controller options into gondolin vm options and delegates runtime methods', async () => {
		let capturedVmOptions: VMOptions | undefined;
		let capturedExecCommand: string | string[] | undefined;
		const fakeFs = createFakeVmFs();
		const execMock = vi.fn((command: string | string[]) => {
			capturedExecCommand = command;
			return createFakeExecProcess({
				exitCode: 0,
				stderr: '',
				stdout:
					Array.isArray(command) && command[1] === '/etc/ssh/ssh_host_ed25519_key.pub'
						? `${TEST_SSH_SERVER_HOST_KEY.algorithm} ${TEST_SSH_SERVER_HOST_KEY.publicKeyBase64}\n`
						: 'ok',
			});
		});
		const closeSshAccessMock = vi.fn(async () => {});
		const enableSshMock = vi.fn(async () => ({
			close: closeSshAccessMock,
			command: 'ssh root@127.0.0.1',
			host: '127.0.0.1',
			identityFile: '/tmp/id_ed25519',
			port: 2222,
			user: 'root',
		}));
		const enableIngressMock = vi.fn(async () => ({
			close: async () => {},
			host: '127.0.0.1',
			port: 18791,
		}));
		const setIngressRoutesMock = vi.fn();
		const startMock = vi.fn(async () => {});
		const closeMock = vi.fn(async () => {});
		const fakeVmInstance: ManagedVmInstance = {
			fs: fakeFs,
			id: 'vm-123',
			exec: execMock,
			enableSsh: enableSshMock,
			enableIngress: enableIngressMock,
			setIngressRoutes: setIngressRoutesMock,
			start: startMock,
			close: closeMock,
		};

		const dependencies = createBaseDependencies({
			createVm: vi.fn(async (vmOptions: VMOptions): Promise<ManagedVmInstance> => {
				capturedVmOptions = vmOptions;
				return fakeVmInstance;
			}),
		});

		const managedVm = await createManagedVm(
			{
				allowedHosts: ['api.openai.com'],
				cpus: 2,
				env: { HERMES_LOG_LEVEL: 'debug' },
				imagePath: '/vm-images/gateways/hermes',
				memory: '2G',
				rootfsMode: 'memory',
				secrets: {
					OPENAI_API_KEY: {
						hosts: ['api.openai.com'],
						value: 'secret-token',
					},
				},
				sessionLabel: 'shravan-gateway',
				tcpHosts: {
					'controller.vm.host:18800': '127.0.0.1:18800',
				},
				vfsMounts: {
					'/project': {
						hostPath: '/tmp/project',
						kind: 'realfs',
					},
					'/state': {
						hostPath: '/tmp/state',
						kind: 'realfs-readonly',
					},
				},
			},
			dependencies,
		);

		expect(capturedVmOptions).toMatchObject({
			cpus: 2,
			dns: {
				mode: 'synthetic',
				syntheticIPv4: SYNTHETIC_DNS_IPV4_BENCHMARK,
				syntheticIPv6: SYNTHETIC_DNS_IPV6_IPV4_MAPPED_BENCHMARK,
				syntheticHostMapping: 'per-host',
			},
			env: {
				HTTPS_PROXY: 'http://proxy.vm.host:8080',
				HERMES_LOG_LEVEL: 'debug',
			},
			httpHooks: {},
			memory: '2G',
			rootfs: {
				mode: 'memory',
			},
			sandbox: {
				imagePath: '/vm-images/gateways/hermes',
			},
			sessionLabel: 'shravan-gateway',
			tcp: {
				hosts: {
					'controller.vm.host:18800': '127.0.0.1:18800',
				},
			},
			vfs: {
				fuseMount: '/data',
			},
		});
		expect(capturedVmOptions).not.toHaveProperty('ownershipReservation');

		const bufferedResult = await managedVm.exec('echo hi');
		expect(bufferedResult.stdout).toBe('ok');

		const readonlyCommand = ['/bin/echo', 'hi'] as const;
		const streamedProcess = managedVm.exec(readonlyCommand, {
			buffer: false,
			stdout: 'pipe',
			windowBytes: 32 * 1024,
		});

		expect(streamedProcess.stdout).not.toBeNull();
		expect(managedVm.fs).toBe(fakeFs);
		expect(execMock).toHaveBeenCalledWith(['/bin/echo', 'hi'], {
			buffer: false,
			stdout: 'pipe',
			windowBytes: 32 * 1024,
		});
		expect(capturedExecCommand).not.toBe(readonlyCommand);
		const managedSshAccess = await managedVm.enableSsh();
		expect(managedSshAccess).toMatchObject({
			serverHostKey: TEST_SSH_SERVER_HOST_KEY,
		});
		await managedSshAccess.close();
		await managedVm.enableIngress();
		expect(managedVm.getVmInstance()).toBe(fakeVmInstance);
		expect(managedVm).not.toHaveProperty('getDestroyTarget');
		await managedVm.start();
		managedVm.setIngressRoutes([{ port: 18789, prefix: '/', stripPrefix: true }]);
		await expect(managedVm.close()).resolves.toBeUndefined();

		expect(enableSshMock).toHaveBeenCalled();
		expect(closeSshAccessMock).toHaveBeenCalledOnce();
		expect(enableIngressMock).toHaveBeenCalled();
		expect(setIngressRoutesMock).toHaveBeenCalledWith([
			{ port: 18789, prefix: '/', stripPrefix: true },
		]);
		expect(startMock).toHaveBeenCalledOnce();
		expect(closeMock).toHaveBeenCalled();
	});

	it('fails closed and closes SSH access when the live VM exposes an invalid server key', async () => {
		const closeSshAccess = vi.fn(async () => {});
		const vmInstance = createFakeVmInstance();
		vmInstance.enableSsh = vi.fn(async () => ({
			close: closeSshAccess,
			command: 'ssh root@127.0.0.1',
			host: '127.0.0.1',
			identityFile: '/tmp/id_ed25519',
			port: 2222,
			user: 'root',
		}));
		vmInstance.exec = vi.fn(() =>
			createFakeExecProcess({ exitCode: 0, stderr: '', stdout: 'ssh-rsa invalid\n' }),
		);
		const dependencies = createBaseDependencies({
			createVm: vi.fn(async (): Promise<ManagedVmInstance> => vmInstance),
		});
		const managedVm = await createManagedVm(
			{
				allowedHosts: [],
				cpus: 1,
				imagePath: '/vm-images/tool-vm',
				memory: '1G',
				rootfsMode: 'memory',
				secrets: {},
				vfsMounts: {},
			},
			dependencies,
		);

		await expect(managedVm.enableSsh()).rejects.toThrow(
			'Tool VM did not expose a valid ssh-ed25519 server host key',
		);
		expect(closeSshAccess).toHaveBeenCalledOnce();
	});

	it('passes Gondolin mediated secret placeholders into VM environment', async () => {
		let capturedVmOptions: VMOptions | undefined;
		const dependencies = {
			...createBaseDependencies({
				createVm: vi.fn(async (vmOptions: VMOptions): Promise<ManagedVmInstance> => {
					capturedVmOptions = vmOptions;
					return createFakeVmInstance();
				}),
			}),
			createHttpHooks: vi.fn(() => ({
				env: {
					AGENT_VM_MCP_PERPLEXITY_PERPLEXITY_API_KEY: 'GONDOLIN_SECRET_test_placeholder',
				},
				httpHooks: {} satisfies HttpHooks,
			})),
		} satisfies ManagedVmDependencies;

		await createManagedVm(
			{
				allowedHosts: ['api.perplexity.ai'],
				cpus: 1,
				env: { HERMES_LOG_LEVEL: 'debug' },
				imagePath: '/vm-images/gateways/hermes',
				memory: '1G',
				rootfsMode: 'memory',
				secrets: {
					AGENT_VM_MCP_PERPLEXITY_PERPLEXITY_API_KEY: {
						hosts: ['api.perplexity.ai'],
						value: 'resolved-pplx-key',
					},
				},
				vfsMounts: {},
			},
			dependencies,
		);

		expect(dependencies.createHttpHooks).toHaveBeenCalledWith({
			allowedHosts: ['api.perplexity.ai'],
			secrets: {
				AGENT_VM_MCP_PERPLEXITY_PERPLEXITY_API_KEY: {
					hosts: ['api.perplexity.ai'],
					value: 'resolved-pplx-key',
				},
			},
		});
		expect(capturedVmOptions?.env).toMatchObject({
			AGENT_VM_MCP_PERPLEXITY_PERPLEXITY_API_KEY: 'GONDOLIN_SECRET_test_placeholder',
			HERMES_LOG_LEVEL: 'debug',
		});
		expect(capturedVmOptions?.httpHooks).toEqual({});
	});

	it('preserves explicit mediated secret placeholders for Gondolin', async () => {
		let capturedVmOptions: VMOptions | undefined;
		const guestPlaceholder = 'agent-vm-explicit-placeholder';
		const rawSecretValue = 'host-only-secret';
		const dependencies = {
			...createBaseDependencies({
				createVm: vi.fn(async (vmOptions: VMOptions): Promise<ManagedVmInstance> => {
					capturedVmOptions = vmOptions;
					return createFakeVmInstance();
				}),
			}),
			createHttpHooks: vi.fn(() => ({
				env: { API_TOKEN: guestPlaceholder },
				httpHooks: {} satisfies HttpHooks,
			})),
		} satisfies ManagedVmDependencies;

		await createManagedVm(
			{
				allowedHosts: ['api.example.com'],
				cpus: 1,
				env: { SAFE: 'guest-visible' },
				imagePath: '/vm-images/tool-vm',
				memory: '1G',
				rootfsMode: 'memory',
				secrets: {
					API_TOKEN: {
						hosts: ['api.example.com'],
						placeholder: guestPlaceholder,
						value: rawSecretValue,
					},
				},
				vfsMounts: {},
			},
			dependencies,
		);

		expect(dependencies.createHttpHooks).toHaveBeenCalledWith({
			allowedHosts: ['api.example.com'],
			secrets: {
				API_TOKEN: {
					hosts: ['api.example.com'],
					placeholder: guestPlaceholder,
					value: rawSecretValue,
				},
			},
		});
		expect(capturedVmOptions?.env).toEqual({
			API_TOKEN: guestPlaceholder,
			SAFE: 'guest-visible',
		});
		expect(Object.values(capturedVmOptions?.env ?? {})).not.toContain(rawSecretValue);
	});

	it('applies managed ingress defaults when enabling ingress without explicit options', async () => {
		const closeIngressMock = vi.fn(async () => {});
		const enableIngressMock = vi.fn(async () => ({
			close: closeIngressMock,
			host: '127.0.0.1',
			port: 18791,
		}));
		const fakeVmInstance: ManagedVmInstance = {
			...createFakeVmInstance(),
			enableIngress: enableIngressMock,
		};
		const dependencies = createBaseDependencies({
			createVm: vi.fn(async (): Promise<ManagedVmInstance> => fakeVmInstance),
		});

		const managedVm = await createManagedVm(
			{
				allowedHosts: [],
				cpus: 1,
				imagePath: '/vm-images/gateways/hermes',
				memory: '1G',
				rootfsMode: 'memory',
				secrets: {},
				vfsMounts: {},
			},
			dependencies,
		);

		const ingressAccess = await managedVm.enableIngress();
		await ingressAccess.close();

		expect(enableIngressMock).toHaveBeenCalledWith({
			allowWebSockets: true,
			bufferResponseBody: false,
			maxBufferedResponseBodyBytes: 512 * 1024 * 1024,
			upstreamHeaderTimeoutMs: 120_000,
			upstreamResponseTimeoutMs: 120_000,
		});
		expect(closeIngressMock).toHaveBeenCalledOnce();
	});

	it('lets explicit ingress options override managed defaults', async () => {
		const enableIngressMock = vi.fn(async () => ({
			close: async () => {},
			host: '127.0.0.1',
			port: 18891,
		}));
		const fakeVmInstance: ManagedVmInstance = {
			...createFakeVmInstance(),
			enableIngress: enableIngressMock,
		};
		const dependencies = createBaseDependencies({
			createVm: vi.fn(async (): Promise<ManagedVmInstance> => fakeVmInstance),
		});

		const managedVm = await createManagedVm(
			{
				allowedHosts: [],
				cpus: 1,
				imagePath: '/vm-images/gateways/hermes',
				memory: '1G',
				rootfsMode: 'memory',
				secrets: {},
				vfsMounts: {},
			},
			dependencies,
		);

		await managedVm.enableIngress({
			allowWebSockets: false,
			bufferResponseBody: true,
			listenPort: 18891,
			maxBufferedResponseBodyBytes: 64 * 1024 * 1024,
			upstreamHeaderTimeoutMs: 5_000,
			upstreamResponseTimeoutMs: 10_000,
		});

		expect(enableIngressMock).toHaveBeenCalledWith({
			allowWebSockets: false,
			bufferResponseBody: true,
			listenPort: 18891,
			maxBufferedResponseBodyBytes: 64 * 1024 * 1024,
			upstreamHeaderTimeoutMs: 5_000,
			upstreamResponseTimeoutMs: 10_000,
		});
	});

	it('passes runtime rootfs size to Gondolin when configured', async () => {
		let capturedVmOptions: VMOptions | undefined;
		const dependencies = createBaseDependencies({
			createVm: vi.fn(async (vmOptions: VMOptions): Promise<ManagedVmInstance> => {
				capturedVmOptions = vmOptions;
				return createFakeVmInstance();
			}),
		});

		await createManagedVm(
			{
				allowedHosts: [],
				cpus: 2,
				imagePath: '/vm-images/gateways/hermes',
				memory: '4G',
				rootfsMode: 'cow',
				runtimeRootfsSize: '12G',
				secrets: {},
				vfsMounts: {},
			},
			dependencies,
		);

		expect(capturedVmOptions?.rootfs).toEqual({
			mode: 'cow',
			size: '12G',
		});
	});

	it('exposes the active Gondolin host PID through ManagedVm', async () => {
		const dependencies = createBaseDependencies({
			createVm: vi.fn(
				async (): Promise<ManagedVmInstance> => createFakeVmInstance({ hostPid: 42420 }),
			),
		});

		const managedVm = await createManagedVm(
			{
				allowedHosts: [],
				cpus: 2,
				imagePath: '/vm-images/gateways/hermes',
				memory: '4G',
				rootfsMode: 'cow',
				secrets: {},
				vfsMounts: {},
			},
			dependencies,
		);

		expect(managedVm.getHostPid()).toBe(42420);
	});

	it('returns null when the underlying Gondolin VM does not expose a host PID', async () => {
		const dependencies = createBaseDependencies({
			createVm: vi.fn(async (): Promise<ManagedVmInstance> => {
				const vmInstanceWithoutHostPid: Partial<ManagedVmInstance> = createFakeVmInstance();
				delete vmInstanceWithoutHostPid.getHostPid;
				return vmInstanceWithoutHostPid as ManagedVmInstance;
			}),
		});

		const managedVm = await createManagedVm(
			{
				allowedHosts: [],
				cpus: 2,
				imagePath: '/vm-images/gateways/hermes',
				memory: '4G',
				rootfsMode: 'cow',
				secrets: {},
				vfsMounts: {},
			},
			dependencies,
		);

		expect(managedVm.getHostPid()).toBeNull();
	});

	it('caller env overrides hookBundle env on NODE_OPTIONS collision', async () => {
		// Regression test for the merge-order invariant the lifecycles
		// rely on: when hookBundle.env and options.env both define
		// NODE_OPTIONS, options.env (the caller's value) must win.
		// If a future change reverses the spread order in vm-adapter.ts,
		// the IPv6-race bug fix would silently regress for every
		// downstream lifecycle.
		let capturedVmOptions: VMOptions | undefined;
		const dependencies = createBaseDependencies({
			createVm: vi.fn(async (vmOptions: VMOptions): Promise<ManagedVmInstance> => {
				capturedVmOptions = vmOptions;
				return createFakeVmInstance();
			}),
		});
		// Override the default createHttpHooks to inject a competing
		// NODE_OPTIONS value into hookBundle.env.
		dependencies.createHttpHooks = vi.fn(() => ({
			env: {
				HTTPS_PROXY: 'http://proxy.vm.host:8080',
				NODE_OPTIONS: '--this-must-lose',
			},
			httpHooks: {} satisfies HttpHooks,
		}));

		await createManagedVm(
			{
				allowedHosts: [],
				cpus: 1,
				env: {
					NODE_OPTIONS: '--dns-result-order=ipv4first --no-network-family-autoselection',
				},
				imagePath: '',
				memory: '1G',
				rootfsMode: 'memory',
				secrets: {},
				vfsMounts: {},
			},
			dependencies,
		);

		expect(capturedVmOptions?.env).toEqual(
			expect.objectContaining({
				NODE_OPTIONS: '--dns-result-order=ipv4first --no-network-family-autoselection',
			}),
		);
	});

	it('uses pinned RealFS providers for pinned mounts and closes the root with the VM', async () => {
		let capturedVmOptions: VMOptions | undefined;
		const pinnedRoot = createPinnedRoot(101);
		const pinnedProvider = createTestProvider();
		const closePinnedRealFsRoot = vi.fn();
		const createPinnedRealFsProvider = vi.fn(() => pinnedProvider);
		const dependencies = createBaseDependencies({
			closePinnedRealFsRoot,
			createPinnedRealFsProvider,
			createVm: async (vmOptions) => {
				capturedVmOptions = vmOptions;
				return createFakeVmInstance();
			},
		});

		const managedVm = await createManagedVm(
			{
				allowedHosts: [],
				cpus: 1,
				imagePath: '/vm-images/tool',
				memory: '1G',
				rootfsMode: 'memory',
				secrets: {},
				vfsMounts: {
					'/work': {
						kind: 'realfs',
						pinnedHostRoot: pinnedRoot,
					},
				},
			},
			dependencies,
		);

		expect(createPinnedRealFsProvider).toHaveBeenCalledWith(pinnedRoot);
		expect(capturedVmOptions?.vfs?.mounts?.['/work']).toBe(pinnedProvider);

		await managedVm.close();

		expect(closePinnedRealFsRoot).toHaveBeenCalledOnce();
		expect(closePinnedRealFsRoot).toHaveBeenCalledWith(pinnedRoot);
	});

	it('returns the stock void close result after pinned-root cleanup', async () => {
		const pinnedRoot = createPinnedRoot(151);
		const vmInstance = createFakeVmInstance();
		vmInstance.close = vi.fn(async () => {});
		const closePinnedRealFsRoot = vi.fn();
		const dependencies = createBaseDependencies({
			closePinnedRealFsRoot,
			createVm: async () => vmInstance,
		});
		const managedVm = await createManagedVm(
			{
				allowedHosts: [],
				cpus: 1,
				imagePath: '/vm-images/tool',
				memory: '1G',
				rootfsMode: 'memory',
				secrets: {},
				vfsMounts: {
					'/work': {
						kind: 'realfs',
						pinnedHostRoot: pinnedRoot,
					},
				},
			},
			dependencies,
		);

		await expect(managedVm.close()).resolves.toBeUndefined();
		expect(closePinnedRealFsRoot).toHaveBeenCalledOnce();
	});

	it('closes pinned roots when VM creation fails', async () => {
		const pinnedRoot = createPinnedRoot(202);
		const closePinnedRealFsRoot = vi.fn();
		const dependencies = createBaseDependencies({
			closePinnedRealFsRoot,
			createVm: async () => {
				throw new Error('vm create failed');
			},
		});

		await expect(
			createManagedVm(
				{
					allowedHosts: [],
					cpus: 1,
					imagePath: '/vm-images/tool',
					memory: '1G',
					rootfsMode: 'memory',
					secrets: {},
					vfsMounts: {
						'/work': {
							kind: 'realfs',
							pinnedHostRoot: pinnedRoot,
						},
					},
				},
				dependencies,
			),
		).rejects.toThrow('vm create failed');

		expect(closePinnedRealFsRoot).toHaveBeenCalledOnce();
		expect(closePinnedRealFsRoot).toHaveBeenCalledWith(pinnedRoot);
	});

	it('closes pinned roots when hook creation fails before VM creation starts', async () => {
		const pinnedRoot = createPinnedRoot(303);
		const closePinnedRealFsRoot = vi.fn();
		const createVm = vi.fn(async () => createFakeVmInstance());
		const dependencies = {
			...createBaseDependencies({ closePinnedRealFsRoot }),
			createHttpHooks: vi.fn(() => {
				throw new Error('hook setup failed');
			}),
			createVm,
		} satisfies ManagedVmDependencies;

		await expect(
			createManagedVm(
				{
					allowedHosts: [],
					cpus: 1,
					imagePath: '/vm-images/tool',
					memory: '1G',
					rootfsMode: 'memory',
					secrets: {},
					vfsMounts: {
						'/work': {
							kind: 'realfs',
							pinnedHostRoot: pinnedRoot,
						},
					},
				},
				dependencies,
			),
		).rejects.toThrow('hook setup failed');

		expect(closePinnedRealFsRoot).toHaveBeenCalledOnce();
		expect(closePinnedRealFsRoot).toHaveBeenCalledWith(pinnedRoot);
		expect(createVm).not.toHaveBeenCalled();
	});

	it('aggregates VM and every pinned-root cleanup failure', async () => {
		const firstPinnedRoot = createPinnedRoot(401);
		const secondPinnedRoot = createPinnedRoot(402);
		const nativeCloseError = new Error('native close failed');
		const firstRootCloseError = new Error('first root close failed');
		const secondRootCloseError = new Error('second root close failed');
		const closePinnedRealFsRoot = vi.fn((root: PinnedRealFsRoot) => {
			throw root.fd === firstPinnedRoot.fd ? firstRootCloseError : secondRootCloseError;
		});
		const vmInstance = createFakeVmInstance();
		vmInstance.close = vi.fn(async () => {
			throw nativeCloseError;
		});
		const dependencies = createBaseDependencies({
			closePinnedRealFsRoot,
			createVm: async () => vmInstance,
		});
		const managedVm = await createManagedVm(
			{
				allowedHosts: [],
				cpus: 1,
				imagePath: '/vm-images/tool',
				memory: '1G',
				rootfsMode: 'memory',
				secrets: {},
				vfsMounts: {
					'/first': {
						kind: 'realfs',
						pinnedHostRoot: firstPinnedRoot,
					},
					'/second': {
						kind: 'realfs',
						pinnedHostRoot: secondPinnedRoot,
					},
				},
			},
			dependencies,
		);

		const closeResult = managedVm.close();
		await expect(closeResult).rejects.toBeInstanceOf(AggregateError);
		await expect(closeResult).rejects.toMatchObject({
			errors: [nativeCloseError, firstRootCloseError, secondRootCloseError],
		});
		expect(closePinnedRealFsRoot).toHaveBeenCalledTimes(2);
	});

	it('uses the raw RealFS provider for writable host directories', async () => {
		const rawProvider = createTestProvider();
		let capturedVmOptions: VMOptions | undefined;
		const dependencies = createBaseDependencies({
			createRealFsProvider: vi.fn(() => rawProvider),
			createVm: async (vmOptions) => {
				capturedVmOptions = vmOptions;
				return createFakeVmInstance();
			},
		});

		await createManagedVm(
			{
				allowedHosts: [],
				cpus: 1,
				imagePath: '/vm-images/tool',
				memory: '1G',
				rootfsMode: 'memory',
				secrets: {},
				vfsMounts: {
					'/work': {
						hostPath: '/tmp/work',
						kind: 'realfs',
					},
				},
			},
			dependencies,
		);

		expect(capturedVmOptions?.vfs?.mounts?.['/work']).toBe(rawProvider);
	});

	it('applies readonly policy directly to the raw RealFS provider', async () => {
		const rawProvider = createTestProvider();
		const readonlyProvider = createTestProvider();
		let capturedVmOptions: VMOptions | undefined;
		const createReadonlyProvider = vi.fn(() => readonlyProvider);
		const dependencies = createBaseDependencies({
			createReadonlyProvider,
			createRealFsProvider: vi.fn(() => rawProvider),
			createVm: async (vmOptions) => {
				capturedVmOptions = vmOptions;
				return createFakeVmInstance();
			},
		});

		await createManagedVm(
			{
				allowedHosts: [],
				cpus: 1,
				imagePath: '/vm-images/tool',
				memory: '1G',
				rootfsMode: 'memory',
				secrets: {},
				vfsMounts: {
					'/work': {
						hostPath: '/tmp/work',
						kind: 'realfs-readonly',
					},
				},
			},
			dependencies,
		);

		expect(createReadonlyProvider).toHaveBeenCalledWith(rawProvider);
		expect(capturedVmOptions?.vfs?.mounts?.['/work']).toBe(readonlyProvider);
	});

	it('preserves backend stats while rejecting provider and file-handle mutations', async () => {
		const backendProvider = new MemoryProvider();
		const writableHandle = backendProvider.openSync('/receipt.txt', 'w', 0o600);
		writableHandle.writeFileSync('immutable');
		writableHandle.closeSync();
		const readonlyProvider = createHardenedReadonlyProvider(backendProvider);
		const asynchronousHandle = await readonlyProvider.open('/receipt.txt', 'r');
		const synchronousHandle = readonlyProvider.openSync('/receipt.txt', 'r');
		const backendStats = await backendProvider.stat('/receipt.txt');
		const backendStat = vi.spyOn(backendProvider, 'stat').mockResolvedValue(backendStats);
		const stableBackendStats = {
			birthtimeMs: backendStats.birthtimeMs,
			blksize: backendStats.blksize,
			blocks: backendStats.blocks,
			ctimeMs: backendStats.ctimeMs,
			dev: backendStats.dev,
			gid: backendStats.gid,
			ino: backendStats.ino,
			mode: backendStats.mode,
			mtimeMs: backendStats.mtimeMs,
			nlink: backendStats.nlink,
			rdev: backendStats.rdev,
			size: backendStats.size,
			uid: backendStats.uid,
		};

		expect(await readonlyProvider.stat('/receipt.txt')).toBe(backendStats);
		expect(backendStat).toHaveBeenCalledWith('/receipt.txt', undefined);
		expect(await asynchronousHandle.stat()).toMatchObject(stableBackendStats);
		await expect(readonlyProvider.open('/receipt.txt', 'a')).rejects.toMatchObject({
			code: 'EROFS',
		});
		await expect(readonlyProvider.mkdir('/new-directory')).rejects.toMatchObject({ code: 'EROFS' });
		await expect(readonlyProvider.rename('/receipt.txt', '/renamed.txt')).rejects.toMatchObject({
			code: 'EROFS',
		});
		await expect(readonlyProvider.unlink('/receipt.txt')).rejects.toMatchObject({ code: 'EROFS' });
		if (!readonlyProvider.appendFile) {
			throw new Error('Readonly provider did not expose the standard appendFile operation.');
		}
		await expect(readonlyProvider.appendFile('/receipt.txt', '!')).rejects.toMatchObject({
			code: 'EROFS',
		});
		await expect(asynchronousHandle.write(Buffer.from('x'), 0, 1, 0)).rejects.toMatchObject({
			code: 'EROFS',
		});
		await expect(asynchronousHandle.writeFile('x')).rejects.toMatchObject({ code: 'EROFS' });
		await expect(asynchronousHandle.truncate(0)).rejects.toMatchObject({ code: 'EROFS' });
		expect(() => synchronousHandle.writeSync(Buffer.from('x'), 0, 1, 0)).toThrow(
			expect.objectContaining({ code: 'EROFS' }),
		);
		expect(() => synchronousHandle.writeFileSync('x')).toThrow(
			expect.objectContaining({ code: 'EROFS' }),
		);
		expect(() => synchronousHandle.truncateSync(0)).toThrow(
			expect.objectContaining({ code: 'EROFS' }),
		);
		await asynchronousHandle.close();
		synchronousHandle.closeSync();
		expect(backendProvider.readFileSync?.('/receipt.txt', 'utf8')).toBe('immutable');
	});
});
