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

import type {
	CreateVmOptions,
	ManagedVm,
	PinnedRealFsRoot,
	SecretResolver,
} from '@agent-vm/gondolin-adapter';
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
					egressHosts: [{ host: 'api.anthropic.com', audience: 'gateway' }],
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
					secrets: {
						OPENCLAW_GATEWAY_TOKEN: {
							source: 'environment',
							envVar: 'OPENCLAW_GATEWAY_TOKEN',
							injection: 'env',
							audience: 'gateway',
						},
					},
					defaultToolVmProfile: 'standard',
					agentToolVmProfiles: {},
					websocketBypass: [],
				},
			],
		},
		{ systemConfigPath },
	);
}

async function createWorkMountDirectory(
	systemConfig: LoadedSystemConfig,
	name: string,
): Promise<string> {
	const zone = systemConfig.zones.find((configuredZone) => configuredZone.id === 'shravan');
	if (zone?.gateway.type !== 'openclaw') {
		throw new Error('Expected shravan OpenClaw zone');
	}
	const hostWorkMountDir = path.join(zone.gateway.zoneFilesDir, name);
	await mkdir(hostWorkMountDir, { recursive: true });
	return hostWorkMountDir;
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

function createSecretResolver(values: Record<string, string>): SecretResolver {
	return {
		resolve: vi.fn(async (ref) => {
			const value = values[ref.ref];
			if (value === undefined) {
				throw new Error(`Missing test secret for ${ref.ref}`);
			}
			return value;
		}),
		resolveAll: vi.fn(async () => values),
	};
}

describe('createToolVm', () => {
	it('mounts the lease host work mount directory at /work', async () => {
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
		const requestedWorkMountDir = await createWorkMountDirectory(
			systemConfig,
			'openclaw-session-work-mount',
		);
		const realWorkMountDir = await realpath(requestedWorkMountDir);

		await createToolVm(
			{
				cacheDir: systemConfig.cacheDir,
				profile: standardProfile,
				systemConfig,
				tcpSlot: 0,
				hostWorkMountDir: requestedWorkMountDir,
				zoneId: 'shravan',
				secretResolver: createSecretResolver({}),
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
						hostPath: realWorkMountDir,
						kind: 'realfs',
						pinnedHostRoot: expect.objectContaining({
							realPath: realWorkMountDir,
						}),
					},
				},
			}),
		);
		expect(capturedCreateVmOptions?.vfsMounts['/work']?.pinnedHostRoot).toEqual(
			expect.objectContaining({
				realPath: realWorkMountDir,
			}),
		);
		expect(capturedCreateVmOptions?.vfsMounts).not.toHaveProperty('/workspace');
	});

	it('passes only Tool VM egress hosts and mediated secrets into the Tool VM', async () => {
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
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected test zone');
		}
		zone.egressHosts = [
			{ host: 'gateway.example.com', audience: 'gateway' },
			{ host: 'api.github.com', audience: 'both' },
			{ host: 'api.linear.app', audience: 'tool-vm' },
			{ host: 'mcp2.readwise.io', audience: 'tool-vm' },
		];
		zone.secrets = {
			DISCORD_BOT_TOKEN: {
				source: 'environment',
				envVar: 'DISCORD_BOT_TOKEN',
				injection: 'env',
				audience: 'gateway',
			},
			GATEWAY_ONLY_TOKEN: {
				source: 'environment',
				envVar: 'GATEWAY_ONLY_TOKEN',
				injection: 'http-mediation',
				audience: 'gateway',
				hosts: ['gateway.example.com'],
			},
			GITHUB_TOKEN: {
				source: 'environment',
				envVar: 'GITHUB_TOKEN',
				injection: 'http-mediation',
				audience: 'both',
				hosts: ['api.github.com'],
			},
			LINEAR_API_KEY: {
				source: 'environment',
				envVar: 'LINEAR_API_KEY',
				injection: 'http-mediation',
				audience: 'tool-vm',
				hosts: ['api.linear.app'],
			},
			READWISE_ACCESS_TOKEN: {
				source: 'environment',
				envVar: 'READWISE_ACCESS_TOKEN',
				injection: 'http-mediation',
				audience: 'tool-vm',
				hosts: ['mcp2.readwise.io'],
			},
		};
		const secretValues = {
			GITHUB_TOKEN: 'github-real-secret',
			LINEAR_API_KEY: 'linear-real-secret',
			READWISE_ACCESS_TOKEN: 'readwise-real-secret',
		};
		const resolveSecret = vi.fn(async (ref: { readonly ref: string }): Promise<string> => {
			const value = secretValues[ref.ref as keyof typeof secretValues];
			if (value === undefined) {
				throw new Error(`Missing test secret for ${ref.ref}`);
			}
			return value;
		});
		const secretResolver: SecretResolver = {
			resolve: resolveSecret,
			resolveAll: vi.fn(async () => secretValues),
		};
		const standardProfile = systemConfig.toolVmProfiles.standard;
		if (!standardProfile) {
			throw new Error('Expected standard tool VM profile');
		}
		const requestedWorkMountDir = await createWorkMountDirectory(
			systemConfig,
			'cli-auth-work-mount',
		);

		await createToolVm(
			{
				cacheDir: systemConfig.cacheDir,
				profile: standardProfile,
				systemConfig,
				tcpSlot: 0,
				hostWorkMountDir: requestedWorkMountDir,
				zoneId: 'shravan',
				secretResolver,
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

		expect(capturedCreateVmOptions).toMatchObject({
			allowedHosts: ['api.github.com', 'api.linear.app', 'mcp2.readwise.io'],
			secrets: {
				GITHUB_TOKEN: {
					hosts: ['api.github.com'],
					value: 'github-real-secret',
				},
				LINEAR_API_KEY: {
					hosts: ['api.linear.app'],
					value: 'linear-real-secret',
				},
				READWISE_ACCESS_TOKEN: {
					hosts: ['mcp2.readwise.io'],
					value: 'readwise-real-secret',
				},
			},
		});
		expect(capturedCreateVmOptions?.secrets).not.toHaveProperty('DISCORD_BOT_TOKEN');
		expect(capturedCreateVmOptions?.secrets).not.toHaveProperty('GATEWAY_ONLY_TOKEN');
		expect(resolveSecret).not.toHaveBeenCalledWith(
			expect.objectContaining({ ref: 'DISCORD_BOT_TOKEN' }),
		);
		expect(resolveSecret).not.toHaveBeenCalledWith(
			expect.objectContaining({ ref: 'GATEWAY_ONLY_TOKEN' }),
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
		const requestedWorkMountDir = await createWorkMountDirectory(
			systemConfig,
			'persisted-work-mount',
		);
		const persistedFilePath = path.join(requestedWorkMountDir, 'notes.md');

		await createToolVm(
			{
				cacheDir: systemConfig.cacheDir,
				profile: standardProfile,
				systemConfig,
				tcpSlot: 0,
				hostWorkMountDir: requestedWorkMountDir,
				zoneId: 'shravan',
				secretResolver: createSecretResolver({}),
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
		const requestedWorkMountDir = await createWorkMountDirectory(
			systemConfig,
			'openclaw-work-mount',
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
				hostWorkMountDir: requestedWorkMountDir,
				zoneId: 'shravan',
				secretResolver: createSecretResolver({}),
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
			cacheDir: path.join(systemConfig.cacheDir, 'tool-vm-images', 'default'),
		});
		expect(exec).not.toHaveBeenCalled();
	});

	it('rejects direct lifecycle calls with host work mount paths outside OpenClaw roots', async () => {
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
					secretResolver: createSecretResolver({}),
					systemConfig,
					tcpSlot: 0,
					hostWorkMountDir: '/etc',
					zoneId: 'shravan',
				},
				{
					buildGondolinImage,
					createManagedVm,
				},
			),
		).rejects.toThrow(/outside allowed OpenClaw tool work mount roots/u);
		expect(buildGondolinImage).not.toHaveBeenCalled();
		expect(createManagedVm).not.toHaveBeenCalled();
	});

	it('revalidates the host work mount directory after image build and before pinning', async () => {
		const systemConfig = await createToolVmSystemConfig();
		const standardProfile = systemConfig.toolVmProfiles.standard;
		if (!standardProfile) {
			throw new Error('Expected standard tool VM profile');
		}
		const requestedWorkMountDir = await createWorkMountDirectory(
			systemConfig,
			'openclaw-work-mount',
		);
		const movedWorkMountDir = path.join(path.dirname(requestedWorkMountDir), 'moved-work-mount');
		const outsideDirectory = await createTemporaryDirectory();
		const buildGondolinImage = vi.fn(async () => {
			await rename(requestedWorkMountDir, movedWorkMountDir);
			await symlink(outsideDirectory, requestedWorkMountDir);
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
					secretResolver: createSecretResolver({}),
					systemConfig,
					tcpSlot: 0,
					hostWorkMountDir: requestedWorkMountDir,
					zoneId: 'shravan',
				},
				{
					buildGondolinImage,
					createManagedVm,
				},
			),
		).rejects.toThrow(/outside allowed OpenClaw tool work mount roots/u);

		expect(buildGondolinImage).toHaveBeenCalledOnce();
		expect(createManagedVm).not.toHaveBeenCalled();
	});

	it('closes the pinned work mount root when post-pin revalidation fails', async () => {
		const systemConfig = await createToolVmSystemConfig();
		const standardProfile = systemConfig.toolVmProfiles.standard;
		if (!standardProfile) {
			throw new Error('Expected standard tool VM profile');
		}
		const requestedWorkMountDir = await createWorkMountDirectory(
			systemConfig,
			'openclaw-work-mount',
		);
		const pinnedWorkMountRoot = {
			device: 1,
			fd: 123,
			hostPath: requestedWorkMountDir,
			inode: 456,
			realPath: requestedWorkMountDir,
		} satisfies PinnedRealFsRoot;
		const validateResolvedToolWorkMountDir = vi
			.fn()
			.mockResolvedValueOnce(requestedWorkMountDir)
			.mockResolvedValueOnce(requestedWorkMountDir)
			.mockRejectedValueOnce(new Error('post-pin validation failed'));
		const closePinnedRealFsRoot = vi.fn();
		const createManagedVm = vi.fn();

		await expect(
			createToolVm(
				{
					cacheDir: systemConfig.cacheDir,
					profile: standardProfile,
					secretResolver: createSecretResolver({}),
					systemConfig,
					tcpSlot: 0,
					hostWorkMountDir: requestedWorkMountDir,
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
					pinRealFsRoot: () => pinnedWorkMountRoot,
					validateResolvedToolWorkMountDir,
				},
			),
		).rejects.toThrow('post-pin validation failed');

		expect(validateResolvedToolWorkMountDir).toHaveBeenCalledTimes(3);
		expect(closePinnedRealFsRoot).toHaveBeenCalledWith(pinnedWorkMountRoot);
		expect(createManagedVm).not.toHaveBeenCalled();
	});
});
