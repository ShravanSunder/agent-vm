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
	type VirtualProvider,
} from '@earendil-works/gondolin';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import { configureHostNetworkDefaults } from './host-network-defaults.js';
import type { PinnedRealFsRoot } from './pinned-realfs.js';
import {
	SYNTHETIC_DNS_IPV4_BENCHMARK,
	SYNTHETIC_DNS_IPV6_IPV4_MAPPED_BENCHMARK,
	createGitReadOnlySshEgressOptions,
	createManagedVm,
	parseSshServerHostKey,
	type ManagedVmDependencies,
	type ManagedVmInstance,
	type SshAccess,
} from './vm-adapter.js';

function createTestProvider(): VirtualProvider {
	return new MemoryProvider();
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
		start: vi.fn(async () => {}),
		close: vi.fn(async () => {}),
	};
}

function createBaseDependencies(options?: {
	readonly configureHostNetworkDefaults?: () => ReturnType<typeof configureHostNetworkDefaults>;
	readonly createVm?: (vmOptions: VMOptions) => Promise<ManagedVmInstance>;
	readonly closePinnedRealFsRoot?: (root: PinnedRealFsRoot) => void;
	readonly createPinnedRealFsProvider?: (root: PinnedRealFsRoot) => VirtualProvider;
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
		createMemoryProvider: vi.fn(() => createTestProvider()),
		createPinnedRealFsProvider: vi.fn(
			options?.createPinnedRealFsProvider ?? (() => createTestProvider()),
		),
		createReadonlyProvider: vi.fn(() => createTestProvider()),
		createRealFsProvider: vi.fn(() => createTestProvider()),
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
				imagePath: '/vm-images/gateways/openclaw',
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

	it('uses an IPv4-mapped RFC2544 synthetic AAAA address for OpenClaw SSRF compatibility', () => {
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

	it('uses OpenClaw-compatible synthetic DNS ranges when TCP host mapping is enabled', async () => {
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
			allowedHosts: ['controller.vm.host'],
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
				env: { OPENCLAW_LOG_LEVEL: 'debug' },
				imagePath: '/vm-images/gateways/openclaw',
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
				OPENCLAW_LOG_LEVEL: 'debug',
			},
			httpHooks: {},
			memory: '2G',
			rootfs: {
				mode: 'memory',
			},
			sandbox: {
				imagePath: '/vm-images/gateways/openclaw',
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
				env: { OPENCLAW_LOG_LEVEL: 'debug' },
				imagePath: '/vm-images/gateways/openclaw',
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
			OPENCLAW_LOG_LEVEL: 'debug',
		});
		expect(capturedVmOptions?.httpHooks).toEqual({});
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
				imagePath: '/vm-images/gateways/openclaw',
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
				imagePath: '/vm-images/gateways/openclaw',
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
				imagePath: '/vm-images/gateways/openclaw',
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
				imagePath: '/vm-images/gateways/openclaw',
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
				imagePath: '/vm-images/gateways/openclaw',
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
});
