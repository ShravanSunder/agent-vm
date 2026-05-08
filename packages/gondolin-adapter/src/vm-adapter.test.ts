import {
	MemoryProvider,
	type HttpHooks,
	type VMOptions,
	type VirtualProvider,
} from '@earendil-works/gondolin';
import { describe, expect, it, vi } from 'vitest';

import type { PinnedRealFsRoot } from './pinned-realfs.js';
import {
	createManagedVm,
	type ManagedVmDependencies,
	type ManagedVmInstance,
} from './vm-adapter.js';

function createTestProvider(): VirtualProvider {
	return new MemoryProvider();
}

function createFakeVmInstance(): ManagedVmInstance {
	return {
		id: 'vm-123',
		exec: vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' })),
		enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
		enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 2222 })),
		setIngressRoutes: vi.fn(),
		close: vi.fn(async () => {}),
	};
}

function createBaseDependencies(options?: {
	readonly createVm?: (vmOptions: VMOptions) => Promise<ManagedVmInstance>;
	readonly closePinnedRealFsRoot?: (root: PinnedRealFsRoot) => void;
	readonly createPinnedRealFsProvider?: (root: PinnedRealFsRoot) => VirtualProvider;
}): ManagedVmDependencies {
	return {
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
	it('uses OpenClaw-compatible synthetic DNS ranges when TCP host mapping is enabled', async () => {
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
			syntheticIPv4: '198.18.0.1',
			syntheticIPv6: 'fc00::1',
			syntheticHostMapping: 'per-host',
		});
	});

	it('translates controller options into gondolin vm options and delegates runtime methods', async () => {
		let capturedVmOptions: VMOptions | undefined;
		const execMock = vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }));
		const enableSshMock = vi.fn(async () => ({ host: '127.0.0.1', port: 2222 }));
		const enableIngressMock = vi.fn(async () => ({ host: '127.0.0.1', port: 18791 }));
		const setIngressRoutesMock = vi.fn();
		const closeMock = vi.fn(async () => {});
		const fakeVmInstance: ManagedVmInstance = {
			id: 'vm-123',
			exec: execMock,
			enableSsh: enableSshMock,
			enableIngress: enableIngressMock,
			setIngressRoutes: setIngressRoutesMock,
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
				syntheticIPv4: '198.18.0.1',
				syntheticIPv6: 'fc00::1',
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

		expect(await managedVm.exec('echo hi')).toEqual({
			exitCode: 0,
			stderr: '',
			stdout: 'ok',
		});
		await managedVm.enableSsh();
		await managedVm.enableIngress();
		expect(managedVm.getVmInstance()).toBe(fakeVmInstance);
		managedVm.setIngressRoutes([{ port: 18789, prefix: '/', stripPrefix: true }]);
		await managedVm.close();

		expect(enableSshMock).toHaveBeenCalled();
		expect(enableIngressMock).toHaveBeenCalled();
		expect(setIngressRoutesMock).toHaveBeenCalledWith([
			{ port: 18789, prefix: '/', stripPrefix: true },
		]);
		expect(closeMock).toHaveBeenCalled();
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
