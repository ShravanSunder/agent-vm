import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { CreateVmOptions, ManagedVm, PinnedRealFsRoot } from '@agent-vm/gondolin-adapter';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLoadedSystemConfig, type LoadedSystemConfig } from '../config/system-config.js';
import { createToolVm } from './tool-vm-lifecycle.js';

const createdDirectories: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const directoryPath of createdDirectories.splice(0)) {
		fs.rmSync(directoryPath, { recursive: true, force: true });
	}
});

function createTemporaryDirectory(): string {
	const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-vm-tool-vm-lifecycle-'));
	createdDirectories.push(temporaryDirectory);
	return temporaryDirectory;
}

function createToolVmSystemConfig(): LoadedSystemConfig {
	const temporaryDirectory = createTemporaryDirectory();
	const systemConfigPath = path.join(temporaryDirectory, 'config', 'system.json');
	const stateDir = path.join(temporaryDirectory, 'state', 'shravan');
	const zoneFilesDir = path.join(temporaryDirectory, 'zone-files', 'shravan');

	return createLoadedSystemConfig(
		{
			cacheDir: path.join(temporaryDirectory, 'cache'),
			host: {
				controllerPort: 18800,
				projectNamespace: 'claw-tests-a1b2c3d4',
				secretsProvider: {
					type: '1password',
					tokenSource: { type: 'env' },
				},
			},
			imageProfiles: {
				gateways: {
					openclaw: {
						type: 'openclaw',
						buildConfig: '/project/vm-images/gateways/openclaw/build-config.json',
					},
					worker: {
						type: 'worker',
						buildConfig: '/project/vm-images/gateways/worker/build-config.json',
					},
				},
				toolVms: {
					default: {
						type: 'toolVm',
						buildConfig: '/project/vm-images/tool-vms/default/build-config.json',
					},
				},
			},
			tcpPool: {
				basePort: 19000,
				size: 5,
			},
			toolProfiles: {
				standard: {
					cpus: 1,
					imageProfile: 'default',
					memory: '1G',
				},
			},
			zones: [
				{
					allowedHosts: ['api.anthropic.com'],
					gateway: {
						type: 'openclaw',
						imageProfile: 'openclaw',
						cpus: 2,
						memory: '2G',
						config: './config/shravan/openclaw.json',
						port: 18791,
						stateDir,
						zoneFilesDir,
					},
					id: 'shravan',
					secrets: {},
					toolProfile: 'standard',
					websocketBypass: [],
				},
			],
		},
		{ systemConfigPath },
	);
}

function createWorkspaceDirectory(systemConfig: LoadedSystemConfig, name: string): string {
	const zone = systemConfig.zones.find((configuredZone) => configuredZone.id === 'shravan');
	if (zone?.gateway.type !== 'openclaw') {
		throw new Error('Expected shravan OpenClaw zone');
	}
	const workspaceDir = path.join(zone.gateway.zoneFilesDir, name);
	fs.mkdirSync(workspaceDir, { recursive: true });
	return workspaceDir;
}

function closePinnedWorkspaceRoot(createVmOptions: CreateVmOptions): void {
	const pinnedWorkspaceRoot = createVmOptions.vfsMounts['/work']?.pinnedHostRoot;
	if (pinnedWorkspaceRoot) {
		fs.closeSync(pinnedWorkspaceRoot.fd);
	}
}

describe('createToolVm', () => {
	it('mounts the lease workspace directory at /work', async () => {
		const managedVm = {
			close: async () => {},
			enableIngress: async () => ({ host: '127.0.0.1', port: 18791 }),
			enableSsh: async () => ({ host: '127.0.0.1', port: 19000 }),
			exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
			getVmInstance: () => ({
				close: async () => {},
				enableIngress: async () => ({ host: '127.0.0.1', port: 18791 }),
				enableSsh: async () => ({ host: '127.0.0.1', port: 19000 }),
				exec: async () => ({ exitCode: 0 }),
				id: 'vm-instance',
				setIngressRoutes: () => {},
			}),
			id: 'managed-vm',
			setIngressRoutes: () => {},
		} satisfies ManagedVm;
		let capturedCreateVmOptions: CreateVmOptions | undefined;
		const createManagedVm = vi.fn(async (createVmOptions: CreateVmOptions) => {
			capturedCreateVmOptions = createVmOptions;
			closePinnedWorkspaceRoot(createVmOptions);
			return managedVm;
		});
		const systemConfig = createToolVmSystemConfig();
		const standardProfile = systemConfig.toolProfiles.standard;
		if (!standardProfile) {
			throw new Error('Expected standard tool profile');
		}
		const requestedWorkspaceDir = createWorkspaceDirectory(
			systemConfig,
			'openclaw-session-workspace',
		);

		await createToolVm(
			{
				cacheDir: systemConfig.cacheDir,
				profile: standardProfile,
				systemConfig,
				tcpSlot: 0,
				workspaceDir: requestedWorkspaceDir,
				zoneId: 'shravan',
			},
			{
				buildGondolinImage: async () => ({
					built: true,
					fingerprint: 'tool-fingerprint',
					imagePath: '/cache/tool-fingerprint',
				}),
				createManagedVm,
			},
		);

		expect(createManagedVm).toHaveBeenCalledWith(
			expect.objectContaining({
				vfsMounts: {
					'/work': {
						hostPath: fs.realpathSync(requestedWorkspaceDir),
						kind: 'realfs',
						pinnedHostRoot: expect.objectContaining({
							realPath: fs.realpathSync(requestedWorkspaceDir),
						}),
					},
				},
			}),
		);
		expect(capturedCreateVmOptions?.vfsMounts['/work']?.pinnedHostRoot).toEqual(
			expect.objectContaining({
				realPath: fs.realpathSync(requestedWorkspaceDir),
			}),
		);
	});

	it('creates the tool VM without running redundant runtime setup commands', async () => {
		const exec = vi.fn(async () => ({
			exitCode: 0,
			stderr: '',
			stdout: '',
		}));
		const managedVm = {
			close: async () => {},
			enableIngress: async () => ({ host: '127.0.0.1', port: 18791 }),
			enableSsh: async () => ({ host: '127.0.0.1', port: 19000 }),
			exec,
			getVmInstance: () => ({
				close: async () => {},
				enableIngress: async () => ({ host: '127.0.0.1', port: 18791 }),
				enableSsh: async () => ({ host: '127.0.0.1', port: 19000 }),
				exec: async () => ({ exitCode: 0 }),
				id: 'vm-instance',
				setIngressRoutes: () => {},
			}),
			id: 'managed-vm',
			setIngressRoutes: () => {},
		} satisfies ManagedVm;

		const systemConfig = createToolVmSystemConfig();
		const standardProfile = systemConfig.toolProfiles.standard;
		if (!standardProfile) {
			throw new Error('Expected standard tool profile');
		}
		const requestedWorkspaceDir = createWorkspaceDirectory(systemConfig, 'openclaw-workspace');
		const buildGondolinImage = vi.fn(async () => ({
			built: true,
			fingerprint: 'tool-fingerprint',
			imagePath: '/cache/tool-fingerprint',
		}));

		const result = await createToolVm(
			{
				cacheDir: systemConfig.cacheDir,
				profile: standardProfile,
				systemConfig,
				tcpSlot: 0,
				workspaceDir: requestedWorkspaceDir,
				zoneId: 'shravan',
			},
			{
				buildGondolinImage,
				createManagedVm: async (createVmOptions) => {
					closePinnedWorkspaceRoot(createVmOptions);
					return managedVm;
				},
			},
		);

		expect(result).toBe(managedVm);
		expect(buildGondolinImage).toHaveBeenCalledWith({
			buildConfigPath: '/project/vm-images/tool-vms/default/build-config.json',
			systemCacheIdentifierPath: systemConfig.systemCacheIdentifierPath,
			cacheDir: path.join(systemConfig.cacheDir, 'tool-vm-images', 'default'),
		});
		expect(exec).not.toHaveBeenCalled();
	});

	it('does not use mkdirSync inside the async createToolVm path', async () => {
		const managedVm = {
			close: async () => {},
			enableIngress: async () => ({ host: '127.0.0.1', port: 18791 }),
			enableSsh: async () => ({ host: '127.0.0.1', port: 19000 }),
			exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
			getVmInstance: () => ({
				close: async () => {},
				enableIngress: async () => ({ host: '127.0.0.1', port: 18791 }),
				enableSsh: async () => ({ host: '127.0.0.1', port: 19000 }),
				exec: async () => ({ exitCode: 0 }),
				id: 'vm-instance',
				setIngressRoutes: () => {},
			}),
			id: 'managed-vm',
			setIngressRoutes: () => {},
		} satisfies ManagedVm;

		const systemConfig = createToolVmSystemConfig();
		const standardProfile = systemConfig.toolProfiles.standard;
		if (!standardProfile) {
			throw new Error('Expected standard tool profile');
		}
		const requestedWorkspaceDir = createWorkspaceDirectory(systemConfig, 'openclaw-workspace');
		const mkdirSyncSpy = vi.spyOn(fs, 'mkdirSync');

		await createToolVm(
			{
				cacheDir: systemConfig.cacheDir,
				profile: standardProfile,
				systemConfig,
				tcpSlot: 1,
				workspaceDir: requestedWorkspaceDir,
				zoneId: 'shravan',
			},
			{
				buildGondolinImage: async () => ({
					built: true,
					fingerprint: 'tool-fingerprint',
					imagePath: '/cache/tool-fingerprint',
				}),
				createManagedVm: async (createVmOptions) => {
					closePinnedWorkspaceRoot(createVmOptions);
					return managedVm;
				},
			},
		);

		expect(mkdirSyncSpy).not.toHaveBeenCalled();
	});

	it('rejects direct lifecycle calls with workspace directories outside OpenClaw roots', async () => {
		const systemConfig = createToolVmSystemConfig();
		const standardProfile = systemConfig.toolProfiles.standard;
		if (!standardProfile) {
			throw new Error('Expected standard tool profile');
		}
		const buildGondolinImage = vi.fn(async () => ({
			built: true,
			fingerprint: 'tool-fingerprint',
			imagePath: '/cache/tool-fingerprint',
		}));
		const createManagedVm = vi.fn();

		await expect(
			createToolVm(
				{
					cacheDir: systemConfig.cacheDir,
					profile: standardProfile,
					systemConfig,
					tcpSlot: 0,
					workspaceDir: '/etc',
					zoneId: 'shravan',
				},
				{
					buildGondolinImage,
					createManagedVm,
				},
			),
		).rejects.toThrow(/outside allowed OpenClaw tool workspace roots/u);
		expect(buildGondolinImage).not.toHaveBeenCalled();
		expect(createManagedVm).not.toHaveBeenCalled();
	});

	it('revalidates the workspace directory after image build and before pinning', async () => {
		const systemConfig = createToolVmSystemConfig();
		const standardProfile = systemConfig.toolProfiles.standard;
		if (!standardProfile) {
			throw new Error('Expected standard tool profile');
		}
		const requestedWorkspaceDir = createWorkspaceDirectory(systemConfig, 'openclaw-workspace');
		const movedWorkspaceDir = path.join(path.dirname(requestedWorkspaceDir), 'moved-workspace');
		const outsideDirectory = createTemporaryDirectory();
		const buildGondolinImage = vi.fn(async () => {
			fs.renameSync(requestedWorkspaceDir, movedWorkspaceDir);
			fs.symlinkSync(outsideDirectory, requestedWorkspaceDir);
			return {
				built: true,
				fingerprint: 'tool-fingerprint',
				imagePath: '/cache/tool-fingerprint',
			};
		});
		const createManagedVm = vi.fn();

		await expect(
			createToolVm(
				{
					cacheDir: systemConfig.cacheDir,
					profile: standardProfile,
					systemConfig,
					tcpSlot: 0,
					workspaceDir: requestedWorkspaceDir,
					zoneId: 'shravan',
				},
				{
					buildGondolinImage,
					createManagedVm,
				},
			),
		).rejects.toThrow(/outside allowed OpenClaw tool workspace roots/u);

		expect(buildGondolinImage).toHaveBeenCalledOnce();
		expect(createManagedVm).not.toHaveBeenCalled();
	});

	it('closes the pinned workspace root when post-pin revalidation fails', async () => {
		const systemConfig = createToolVmSystemConfig();
		const standardProfile = systemConfig.toolProfiles.standard;
		if (!standardProfile) {
			throw new Error('Expected standard tool profile');
		}
		const requestedWorkspaceDir = createWorkspaceDirectory(systemConfig, 'openclaw-workspace');
		const pinnedWorkspaceRoot = {
			device: 1,
			fd: 123,
			hostPath: requestedWorkspaceDir,
			inode: 456,
			realPath: requestedWorkspaceDir,
		} satisfies PinnedRealFsRoot;
		const validateResolvedToolWorkspaceDir = vi
			.fn()
			.mockResolvedValueOnce(requestedWorkspaceDir)
			.mockResolvedValueOnce(requestedWorkspaceDir)
			.mockRejectedValueOnce(new Error('post-pin validation failed'));
		const closePinnedRealFsRoot = vi.fn();
		const createManagedVm = vi.fn();

		await expect(
			createToolVm(
				{
					cacheDir: systemConfig.cacheDir,
					profile: standardProfile,
					systemConfig,
					tcpSlot: 0,
					workspaceDir: requestedWorkspaceDir,
					zoneId: 'shravan',
				},
				{
					buildGondolinImage: async () => ({
						built: true,
						fingerprint: 'tool-fingerprint',
						imagePath: '/cache/tool-fingerprint',
					}),
					closePinnedRealFsRoot,
					createManagedVm,
					pinRealFsRoot: () => pinnedWorkspaceRoot,
					validateResolvedToolWorkspaceDir,
				},
			),
		).rejects.toThrow('post-pin validation failed');

		expect(validateResolvedToolWorkspaceDir).toHaveBeenCalledTimes(3);
		expect(closePinnedRealFsRoot).toHaveBeenCalledWith(pinnedWorkspaceRoot);
		expect(createManagedVm).not.toHaveBeenCalled();
	});
});
