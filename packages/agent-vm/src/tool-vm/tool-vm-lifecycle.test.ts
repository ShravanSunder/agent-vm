import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rename,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CreateVmOptions, ManagedVm, PinnedRealFsRoot } from '@agent-vm/gondolin-adapter';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLoadedSystemConfig, type LoadedSystemConfig } from '../config/system-config.js';
import { createToolVm } from './tool-vm-lifecycle.js';

const createdDirectories: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(
		createdDirectories
			.splice(0)
			.map((directoryPath) => rm(directoryPath, { recursive: true, force: true })),
	);
});

async function createTemporaryDirectory(): Promise<string> {
	const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-tool-vm-lifecycle-'));
	createdDirectories.push(temporaryDirectory);
	return temporaryDirectory;
}

async function createToolVmSystemConfig(): Promise<LoadedSystemConfig> {
	const temporaryDirectory = await createTemporaryDirectory();
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
			toolVmProfiles: {
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
					defaultToolVmProfile: 'standard',
					agentToolVmProfiles: {},
					websocketBypass: [],
				},
			],
		},
		{ systemConfigPath },
	);
}

async function createWorkspaceDirectory(
	systemConfig: LoadedSystemConfig,
	name: string,
): Promise<string> {
	const zone = systemConfig.zones.find((configuredZone) => configuredZone.id === 'shravan');
	if (zone?.gateway.type !== 'openclaw') {
		throw new Error('Expected shravan OpenClaw zone');
	}
	const workspaceDir = path.join(zone.gateway.zoneFilesDir, name);
	await mkdir(workspaceDir, { recursive: true });
	return workspaceDir;
}

function createPinnedRealFsRoot(hostPath: string): PinnedRealFsRoot {
	return {
		device: 1,
		fd: -1,
		hostPath,
		inode: 1,
		realPath: hostPath,
	};
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
			return managedVm;
		});
		const systemConfig = await createToolVmSystemConfig();
		const standardProfile = systemConfig.toolVmProfiles.standard;
		if (!standardProfile) {
			throw new Error('Expected standard tool VM profile');
		}
		const requestedWorkspaceDir = await createWorkspaceDirectory(
			systemConfig,
			'openclaw-session-workspace',
		);
		const realWorkspaceDir = await realpath(requestedWorkspaceDir);

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
				closePinnedRealFsRoot: () => {},
				pinRealFsRoot: createPinnedRealFsRoot,
			},
		);

		expect(createManagedVm).toHaveBeenCalledWith(
			expect.objectContaining({
				vfsMounts: {
					'/work': {
						hostPath: realWorkspaceDir,
						kind: 'realfs',
						pinnedHostRoot: expect.objectContaining({
							realPath: realWorkspaceDir,
						}),
					},
				},
			}),
		);
		expect(capturedCreateVmOptions?.vfsMounts['/work']?.pinnedHostRoot).toEqual(
			expect.objectContaining({
				realPath: realWorkspaceDir,
			}),
		);
	});

	it('persists tool writes through the RealFS /work backing directory', async () => {
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
		const systemConfig = await createToolVmSystemConfig();
		const standardProfile = systemConfig.toolVmProfiles.standard;
		if (!standardProfile) {
			throw new Error('Expected standard tool VM profile');
		}
		const requestedWorkspaceDir = await createWorkspaceDirectory(
			systemConfig,
			'persisted-workspace',
		);
		const persistedFilePath = path.join(requestedWorkspaceDir, 'notes.md');

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
				createManagedVm: async (createVmOptions) => {
					const workMount = createVmOptions.vfsMounts['/work'];
					if (!workMount || workMount.kind !== 'realfs') {
						throw new Error('Expected Tool VM /work to be a RealFS mount.');
					}
					if (typeof workMount.hostPath !== 'string') {
						throw new Error('Expected Tool VM /work RealFS mount to include hostPath.');
					}
					await writeFile(path.join(workMount.hostPath, 'notes.md'), 'persisted through /work');
					return managedVm;
				},
				closePinnedRealFsRoot: () => {},
				pinRealFsRoot: createPinnedRealFsRoot,
			},
		);

		await expect(readFile(persistedFilePath, 'utf8')).resolves.toBe('persisted through /work');
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

		const systemConfig = await createToolVmSystemConfig();
		const standardProfile = systemConfig.toolVmProfiles.standard;
		if (!standardProfile) {
			throw new Error('Expected standard tool VM profile');
		}
		const requestedWorkspaceDir = await createWorkspaceDirectory(
			systemConfig,
			'openclaw-workspace',
		);
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
				createManagedVm: async () => managedVm,
				closePinnedRealFsRoot: () => {},
				pinRealFsRoot: createPinnedRealFsRoot,
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

	it('rejects direct lifecycle calls with workspace directories outside OpenClaw roots', async () => {
		const systemConfig = await createToolVmSystemConfig();
		const standardProfile = systemConfig.toolVmProfiles.standard;
		if (!standardProfile) {
			throw new Error('Expected standard tool VM profile');
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
		const systemConfig = await createToolVmSystemConfig();
		const standardProfile = systemConfig.toolVmProfiles.standard;
		if (!standardProfile) {
			throw new Error('Expected standard tool VM profile');
		}
		const requestedWorkspaceDir = await createWorkspaceDirectory(
			systemConfig,
			'openclaw-workspace',
		);
		const movedWorkspaceDir = path.join(path.dirname(requestedWorkspaceDir), 'moved-workspace');
		const outsideDirectory = await createTemporaryDirectory();
		const buildGondolinImage = vi.fn(async () => {
			await rename(requestedWorkspaceDir, movedWorkspaceDir);
			await symlink(outsideDirectory, requestedWorkspaceDir);
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
		const systemConfig = await createToolVmSystemConfig();
		const standardProfile = systemConfig.toolVmProfiles.standard;
		if (!standardProfile) {
			throw new Error('Expected standard tool VM profile');
		}
		const requestedWorkspaceDir = await createWorkspaceDirectory(
			systemConfig,
			'openclaw-workspace',
		);
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
