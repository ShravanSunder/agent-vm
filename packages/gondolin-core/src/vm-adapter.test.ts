import { describe, expect, it, vi } from 'vitest';

import {
	createManagedVm,
	type ManagedVmDependencies,
	type ManagedVmInstance,
} from './vm-adapter.js';

describe('createManagedVm', () => {
	it('translates controller options into gondolin vm options and delegates runtime methods', async () => {
		let capturedVmOptions: unknown;
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

		const dependencies: ManagedVmDependencies = {
			createHttpHooks: vi.fn(() => ({
				env: { HTTPS_PROXY: 'http://proxy.vm.host:8080' },
				httpHooks: { kind: 'http-hooks' },
			})),
			createMemoryProvider: vi.fn(() => ({ kind: 'memory-provider' })),
			createReadonlyProvider: vi.fn((provider: unknown) => ({
				kind: 'readonly-provider',
				provider,
			})),
			createRealFsProvider: vi.fn((hostPath: string) => ({
				hostPath,
				kind: 'realfs-provider',
			})),
			createShadowPathPredicate: vi.fn((paths: readonly string[]) => ({ paths })),
			createShadowProvider: vi.fn((provider: unknown, options: unknown) => ({
				kind: 'shadow-provider',
				options,
				provider,
			})),
			createVm: vi.fn(async (vmOptions: unknown): Promise<ManagedVmInstance> => {
				capturedVmOptions = vmOptions;
				return fakeVmInstance;
			}),
		};

		const managedVm = await createManagedVm(
			{
				allowedHosts: ['api.openai.com'],
				cpus: 2,
				env: { OPENCLAW_LOG_LEVEL: 'debug' },
				imagePath: '/images/gateway',
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
					'/workspace': {
						hostPath: '/tmp/workspace',
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
				syntheticHostMapping: 'per-host',
			},
			env: {
				HTTPS_PROXY: 'http://proxy.vm.host:8080',
				OPENCLAW_LOG_LEVEL: 'debug',
			},
			httpHooks: {
				kind: 'http-hooks',
			},
			memory: '2G',
			rootfs: {
				mode: 'memory',
			},
			sandbox: {
				imagePath: '/images/gateway',
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
});
