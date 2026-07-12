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

import {
	buildImageAssetFileNames,
	type CreateVmOptions,
	type ManagedVm,
	type ManagedVmInstance,
	type ManagedVmSshAccess,
	type PinnedRealFsRoot,
} from '@agent-vm/gondolin-adapter';
import type { SecretRef, SecretResolver } from '@agent-vm/secret-management';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { writePreparedGondolinImage } from '../build/prepared-gondolin-image-cache.js';
import { createLoadedSystemConfig, type LoadedSystemConfig } from '../config/system-config.js';
import type { ManagedVmKillDependencies } from '../shared/managed-vm-process.js';
import {
	TEST_SSH_SERVER_HOST_KEY,
	createManagedExecProcessStub,
	createManagedVmFsStub,
} from '../testing/managed-vm-test-helpers.js';
import { createToolVm } from './tool-vm-lifecycle.js';

const createdDirectories: string[] = [];
const testToolVmProcessIdentity = {
	command: 'qemu-system-aarch64 -name tool-vm-test',
	lstart: 'Sat Jul 11 18:00:00 2026',
} as const;

function createManagedVmKillDependencies(
	overrides: Partial<ManagedVmKillDependencies> = {},
): ManagedVmKillDependencies {
	return {
		isProcessAlive: () => false,
		killProcess: vi.fn(),
		readProcessCommand: async () => testToolVmProcessIdentity.command,
		readProcessIdentity: async () => testToolVmProcessIdentity,
		sleep: async () => {},
		...overrides,
	};
}

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
			runtimeDir: path.join(temporaryDirectory, 'runtime'),
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
					runtimeRootfsSize: '16G',
				},
			},
			zones: [
				{
					egressHosts: [{ host: 'api.anthropic.com', audience: 'gateway' }],
					agents: [{ id: 'sun' }],
					gateway: {
						type: 'openclaw',
						controlAuth: {
							mode: 'token',
							secret: 'OPENCLAW_GATEWAY_TOKEN',
						},
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

async function writeFakeImageAssets(imagePath: string): Promise<void> {
	await mkdir(imagePath, { recursive: true });
	await Promise.all(
		buildImageAssetFileNames.map(
			async (fileName) => await writeFile(path.join(imagePath, fileName), '', 'utf8'),
		),
	);
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

function createSshAccessStub(): Awaited<ReturnType<ManagedVm['enableSsh']>> {
	return {
		close: vi.fn(async () => {}),
		command: 'ssh -i /tmp/tool-vm-key root@127.0.0.1 -p 19000',
		host: '127.0.0.1',
		identityFile: '/tmp/tool-vm-key',
		port: 19000,
		serverHostKey: TEST_SSH_SERVER_HOST_KEY,
		user: 'root',
	};
}

function createManagedVmSshAccessStub(): ManagedVmSshAccess {
	return {
		close: vi.fn(async () => {}),
		command: 'ssh -i /tmp/tool-vm-key root@127.0.0.1 -p 19000',
		host: '127.0.0.1',
		identityFile: '/tmp/tool-vm-key',
		port: 19000,
		user: 'root',
	};
}

function createManagedVmStub(
	options: {
		readonly close?: ManagedVm['close'];
		readonly enableSsh?: ManagedVm['enableSsh'];
		readonly exec?: ManagedVm['exec'];
		readonly getHostPid?: ManagedVm['getHostPid'];
		readonly id?: string;
		readonly start?: ManagedVm['start'];
	} = {},
): ManagedVm {
	const close = options.close ?? vi.fn(async () => {});
	const exec = options.exec ?? vi.fn(() => createManagedExecProcessStub());
	const start = options.start ?? vi.fn(async () => {});
	const fs = createManagedVmFsStub();
	const id = options.id ?? 'managed-vm';
	const vmInstance = {
		close,
		enableIngress: async () => ({ close: async () => {}, host: '127.0.0.1', port: 18791 }),
		enableSsh: async () => createManagedVmSshAccessStub(),
		exec,
		fs,
		getHostPid: options.getHostPid ?? (() => 28_282),
		id,
		setIngressRoutes: () => {},
		start,
	} satisfies ManagedVmInstance;
	return {
		close,
		enableIngress: async () => ({ close: async () => {}, host: '127.0.0.1', port: 18791 }),
		enableSsh: options.enableSsh ?? (async () => createSshAccessStub()),
		exec,
		fs,
		getHostPid: options.getHostPid ?? (() => 28_282),
		getVmInstance: () => vmInstance,
		id,
		setIngressRoutes: () => {},
		start,
	};
}

describe('createToolVm', () => {
	it('mounts the lease host work mount directory at /workspace and leaves /work ephemeral', async () => {
		const exec = vi.fn(() => createManagedExecProcessStub());
		const managedVm = createManagedVmStub({ exec });
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
				agentId: 'sun',
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
				managedVmKillDependencies: createManagedVmKillDependencies(),
				pinRealFsRoot: createPinnedRealFsRoot,
			},
		);

		expect(createManagedVm).toHaveBeenCalledWith(
			expect.objectContaining({
				vfsMounts: {
					'/workspace': {
						hostPath: realWorkMountDir,
						kind: 'realfs',
						pinnedHostRoot: expect.objectContaining({
							realPath: realWorkMountDir,
						}),
					},
				},
			}),
		);
		expect(capturedCreateVmOptions?.vfsMounts['/workspace']?.pinnedHostRoot).toEqual(
			expect.objectContaining({
				realPath: realWorkMountDir,
			}),
		);
		expect(capturedCreateVmOptions?.vfsMounts).not.toHaveProperty('/work');
		// IPv4-preference egress for Node consumers inside the Tool VM
		// to defeat Happy Eyeballs racing on gondolin's synthetic AAAA.
		// See FORCE_IPV4_EGRESS_NODE_OPTIONS in @agent-vm/gateway-interface.
		expect(capturedCreateVmOptions?.env?.NODE_OPTIONS).toBe(
			'--dns-result-order=ipv4first --no-network-family-autoselection',
		);
		expect(capturedCreateVmOptions?.runtimeRootfsSize).toBe('16G');
	});

	it('starts the constructed Tool VM before bootstrap exec and SSH work', async () => {
		// Arrange
		const orderedEvents: string[] = [];
		const systemConfig = await createToolVmSystemConfig();
		const zone = systemConfig.zones[0];
		const standardProfile = systemConfig.toolVmProfiles.standard;
		if (zone === undefined || standardProfile === undefined) {
			throw new Error('Expected Tool VM lifecycle test zone and profile.');
		}
		zone.egressHosts = [{ host: 'api.github.com', audience: 'tool-vm' }];
		zone.secrets = {
			TOOL_TOKEN: {
				agentAccess: 'all',
				audience: 'tool-vm',
				envVar: 'TOOL_TOKEN',
				hosts: ['api.github.com'],
				injection: 'http-mediation',
				source: 'environment',
			},
		};
		const requestedWorkMountDir = await createWorkMountDirectory(systemConfig, 'start-ordering');
		const managedVm = createManagedVmStub({
			enableSsh: async () => {
				orderedEvents.push('enable-ssh');
				return createSshAccessStub();
			},
			exec: () => {
				orderedEvents.push('exec');
				return createManagedExecProcessStub();
			},
			start: async () => {
				orderedEvents.push('start');
			},
		});

		// Act
		const createdVm = await createToolVm(
			{
				agentId: 'sun',
				cacheDir: systemConfig.cacheDir,
				hostWorkMountDir: requestedWorkMountDir,
				profile: standardProfile,
				secretResolver: createSecretResolver({ TOOL_TOKEN: 'real-secret' }),
				systemConfig,
				tcpSlot: 0,
				zoneId: 'shravan',
			},
			{
				buildGondolinImage: async () => ({
					built: true,
					fingerprint: 'tool-fingerprint',
					imagePath: '/cache/tool-fingerprint',
				}),
				closePinnedRealFsRoot: () => {},
				createManagedVm: async () => managedVm,
				managedVmKillDependencies: createManagedVmKillDependencies({
					readProcessIdentity: async () => {
						orderedEvents.push('capture-process-identity');
						return testToolVmProcessIdentity;
					},
				}),
				pinRealFsRoot: createPinnedRealFsRoot,
			},
		);
		await createdVm.enableSsh();

		// Assert
		expect(orderedEvents).toEqual([
			'start',
			'capture-process-identity',
			'exec',
			'exec',
			'enable-ssh',
		]);
	});

	it('closes the constructed Tool VM when stock start fails before bootstrap work', async () => {
		// Arrange
		const systemConfig = await createToolVmSystemConfig();
		const standardProfile = systemConfig.toolVmProfiles.standard;
		if (standardProfile === undefined) {
			throw new Error('Expected standard Tool VM profile.');
		}
		const requestedWorkMountDir = await createWorkMountDirectory(systemConfig, 'start-failure');
		const startError = new Error('stock Tool VM start failed');
		const close = vi.fn(async () => {});
		const exec = vi.fn<ManagedVm['exec']>(() => createManagedExecProcessStub());
		const managedVm = createManagedVmStub({
			close,
			exec,
			getHostPid: () => null,
			start: async () => {
				throw startError;
			},
		});

		// Act
		const creation = createToolVm(
			{
				agentId: 'sun',
				cacheDir: systemConfig.cacheDir,
				hostWorkMountDir: requestedWorkMountDir,
				profile: standardProfile,
				secretResolver: createSecretResolver({}),
				systemConfig,
				tcpSlot: 0,
				zoneId: 'shravan',
			},
			{
				buildGondolinImage: async () => ({
					built: true,
					fingerprint: 'tool-fingerprint',
					imagePath: '/cache/tool-fingerprint',
				}),
				closePinnedRealFsRoot: () => {},
				createManagedVm: async () => managedVm,
				pinRealFsRoot: createPinnedRealFsRoot,
			},
		);

		// Assert
		await expect(creation).rejects.toBe(startError);
		expect(close).toHaveBeenCalledOnce();
		expect(exec).not.toHaveBeenCalled();
	});

	it('fails closed when stock start rejects but the runner identity is unknown', async () => {
		// Arrange
		const systemConfig = await createToolVmSystemConfig();
		const standardProfile = systemConfig.toolVmProfiles.standard;
		if (standardProfile === undefined) {
			throw new Error('Expected standard Tool VM profile.');
		}
		const requestedWorkMountDir = await createWorkMountDirectory(
			systemConfig,
			'unknown-runner-start-failure',
		);
		const startError = new Error('stock Tool VM start failed after runner spawn');
		const close = vi.fn(async () => {});
		const managedVm = createManagedVmStub({
			close,
			getHostPid: () => 28_282,
			start: async () => {
				throw startError;
			},
		});

		// Act
		const creation = createToolVm(
			{
				agentId: 'sun',
				cacheDir: systemConfig.cacheDir,
				hostWorkMountDir: requestedWorkMountDir,
				profile: standardProfile,
				secretResolver: createSecretResolver({}),
				systemConfig,
				tcpSlot: 0,
				zoneId: 'shravan',
			},
			{
				buildGondolinImage: async () => ({
					built: true,
					fingerprint: 'tool-fingerprint',
					imagePath: '/cache/tool-fingerprint',
				}),
				closePinnedRealFsRoot: () => {},
				createManagedVm: async () => managedVm,
				pinRealFsRoot: createPinnedRealFsRoot,
			},
		);

		// Assert
		await expect(creation).rejects.toMatchObject({
			errors: [
				startError,
				expect.objectContaining({
					message: expect.stringMatching(/live runner without captured process identity/u),
				}),
			],
		});
		expect(close).not.toHaveBeenCalled();
	});

	it('does not double-close adapter-owned pinned roots when construction fails', async () => {
		// Arrange
		const systemConfig = await createToolVmSystemConfig();
		const standardProfile = systemConfig.toolVmProfiles.standard;
		if (standardProfile === undefined) {
			throw new Error('Expected standard Tool VM profile.');
		}
		const requestedWorkMountDir = await createWorkMountDirectory(
			systemConfig,
			'construction-failure',
		);
		const createError = new Error('stock Tool VM construction failed');
		const closePinnedRealFsRoot = vi.fn();

		// Act
		const creation = createToolVm(
			{
				agentId: 'sun',
				cacheDir: systemConfig.cacheDir,
				hostWorkMountDir: requestedWorkMountDir,
				profile: standardProfile,
				secretResolver: createSecretResolver({}),
				systemConfig,
				tcpSlot: 0,
				zoneId: 'shravan',
			},
			{
				buildGondolinImage: async () => ({
					built: true,
					fingerprint: 'tool-fingerprint',
					imagePath: '/cache/tool-fingerprint',
				}),
				closePinnedRealFsRoot,
				createManagedVm: async (createVmOptions) => {
					const pinnedRoot = createVmOptions.vfsMounts['/workspace']?.pinnedHostRoot;
					if (pinnedRoot === undefined) {
						throw new Error('Expected adapter-owned pinned root.');
					}
					closePinnedRealFsRoot(pinnedRoot);
					throw createError;
				},
				pinRealFsRoot: createPinnedRealFsRoot,
			},
		);

		// Assert
		await expect(creation).rejects.toBe(createError);
		expect(closePinnedRealFsRoot).toHaveBeenCalledOnce();
	});

	it('passes only Tool VM egress hosts and mediated secrets into the Tool VM', async () => {
		const exec = vi.fn<ManagedVm['exec']>(() => createManagedExecProcessStub());
		const managedVm = createManagedVmStub({ exec, getHostPid: () => null });
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
				agentAccess: ['sun'],
			},
			LINEAR_API_KEY: {
				source: 'environment',
				envVar: 'LINEAR_API_KEY',
				injection: 'http-mediation',
				audience: 'tool-vm',
				hosts: ['api.linear.app'],
				agentAccess: 'all',
			},
			READWISE_ACCESS_TOKEN: {
				source: 'environment',
				envVar: 'READWISE_ACCESS_TOKEN',
				injection: 'http-mediation',
				audience: 'tool-vm',
				hosts: ['mcp2.readwise.io'],
				agentAccess: ['mak'],
			},
		};
		const secretValues = {
			GITHUB_TOKEN: 'github-real-secret',
			LINEAR_API_KEY: 'linear-real-secret',
			READWISE_ACCESS_TOKEN: 'readwise-real-secret',
		};
		const resolveAll = vi.fn(async (refs: Record<string, SecretRef>) =>
			Object.fromEntries(
				Object.keys(refs).map((secretName) => [
					secretName,
					secretValues[secretName as keyof typeof secretValues],
				]),
			),
		);
		const resolveSecret = vi.fn(async (ref: SecretRef): Promise<string> => {
			if (!ref.ref) {
				throw new Error('Expected test secret ref to use a resolvable reference.');
			}
			const value = secretValues[ref.ref as keyof typeof secretValues];
			if (value === undefined) {
				throw new Error(`Missing test secret for ${ref.ref}`);
			}
			return value;
		});
		const secretResolver: SecretResolver = {
			resolve: resolveSecret,
			resolveAll,
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
				agentId: 'sun',
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
			},
		});
		expect(capturedCreateVmOptions?.secrets).not.toHaveProperty('DISCORD_BOT_TOKEN');
		expect(capturedCreateVmOptions?.secrets).not.toHaveProperty('GATEWAY_ONLY_TOKEN');
		expect(capturedCreateVmOptions?.secrets).not.toHaveProperty('READWISE_ACCESS_TOKEN');
		expect(resolveAll).toHaveBeenCalledWith({
			GITHUB_TOKEN: { source: 'environment', ref: 'GITHUB_TOKEN' },
			LINEAR_API_KEY: { source: 'environment', ref: 'LINEAR_API_KEY' },
		});
		expect(resolveSecret).not.toHaveBeenCalledWith(
			expect.objectContaining({ ref: 'DISCORD_BOT_TOKEN' }),
		);
		expect(resolveSecret).not.toHaveBeenCalledWith(
			expect.objectContaining({ ref: 'GATEWAY_ONLY_TOKEN' }),
		);
		expect(exec).toHaveBeenCalledTimes(2);
		expect(exec.mock.calls[0]?.[0]).toBe('rm -f /etc/ssh/ssh_host_*');
		const bootstrapCommand = exec.mock.calls[1]?.[0];
		if (typeof bootstrapCommand !== 'string') {
			throw new Error('Expected mediated placeholder bootstrap to use a shell command string.');
		}
		expect(bootstrapCommand).toContain('/etc/profile.d/agent-vm-mediated-env.sh');
		expect(bootstrapCommand).toContain('/etc/environment');
		expect(bootstrapCommand).toContain('/etc/ssh/sshd_config');
		expect(bootstrapCommand).toContain("for name in 'GITHUB_TOKEN' 'LINEAR_API_KEY'");
		expect(bootstrapCommand).toContain('printf \'SetEnv BASH_ENV=%s\' "$profile_path"');
		expect(bootstrapCommand).toContain('printf \' %s=%s\' "$name" "$value"');
		expect(bootstrapCommand).toContain(
			'trap \'rm -f "$profile_tmp" "$environment_tmp" "$sshd_config_tmp" "$sshd_config_body_tmp"\' EXIT',
		);
		expect(bootstrapCommand).toContain('cat "$sshd_config_tmp" > "$sshd_config_path"');
		expect(bootstrapCommand).not.toContain('DISCORD_BOT_TOKEN');
		expect(bootstrapCommand).not.toContain('GATEWAY_ONLY_TOKEN');
		expect(bootstrapCommand).not.toContain('READWISE_ACCESS_TOKEN');
		expect(bootstrapCommand).not.toContain('github-real-secret');
		expect(bootstrapCommand).not.toContain('linear-real-secret');
		expect(bootstrapCommand).not.toContain('readwise-real-secret');
	});

	it('uses Tool VM websocket upgrade policy for websocket request guarding', async () => {
		const managedVm = createManagedVmStub({ getHostPid: () => null });
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
			{ host: 'gateway-websocket.example.com', audience: 'gateway' },
			{ host: 'tool-websocket.example.com', audience: 'tool-vm' },
		];
		zone.websocketUpgrades = [
			{
				audience: 'gateway',
				host: 'gateway-websocket.example.com',
				path: '/socket',
				scheme: 'wss',
			},
			{
				audience: 'tool-vm',
				host: 'tool-websocket.example.com',
				path: '/socket',
				scheme: 'wss',
			},
		];
		const standardProfile = systemConfig.toolVmProfiles.standard;
		if (!standardProfile) {
			throw new Error('Expected standard tool VM profile');
		}
		const requestedWorkMountDir = await createWorkMountDirectory(
			systemConfig,
			'tool-vm-websocket-work-mount',
		);

		await createToolVm(
			{
				cacheDir: systemConfig.cacheDir,
				agentId: 'sun',
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

		const onRequest = capturedCreateVmOptions?.onRequest;
		expect(onRequest).toBeDefined();
		if (!onRequest) {
			throw new Error('Expected Tool VM websocket guard');
		}
		const allowedResult = await onRequest(
			new Request('https://tool-websocket.example.com/socket', {
				headers: { Connection: 'Upgrade', Upgrade: 'websocket' },
			}),
		);
		const gatewayOnlyResult = await onRequest(
			new Request('https://gateway-websocket.example.com/socket', {
				headers: { Connection: 'Upgrade', Upgrade: 'websocket' },
			}),
		);

		expect(allowedResult).toBeUndefined();
		expect(gatewayOnlyResult).toBeInstanceOf(Response);
		expect((gatewayOnlyResult as Response).status).toBe(403);
	});

	it.each(['BASH_ENV', 'HOME', 'LOGNAME', 'NODE_OPTIONS', 'PATH', 'SHELL', 'USER'])(
		'rejects mediated Tool VM secret name %s because it collides with runtime bootstrap env',
		async (reservedSecretName) => {
			const exec = vi.fn<ManagedVm['exec']>(() => createManagedExecProcessStub());
			const managedVm = createManagedVmStub({ exec, getHostPid: () => null });
			const createManagedVm = vi.fn(async () => managedVm);
			const systemConfig = await createToolVmSystemConfig();
			const zone = systemConfig.zones[0];
			if (!zone) {
				throw new Error('Expected test zone');
			}
			zone.egressHosts = [{ host: 'api.github.com', audience: 'tool-vm' }];
			zone.secrets = {
				[reservedSecretName]: {
					source: 'environment',
					envVar: reservedSecretName,
					injection: 'http-mediation',
					audience: 'tool-vm',
					hosts: ['api.github.com'],
					agentAccess: 'all',
				},
			};
			const standardProfile = systemConfig.toolVmProfiles.standard;
			if (!standardProfile) {
				throw new Error('Expected standard tool VM profile');
			}
			const requestedWorkMountDir = await createWorkMountDirectory(
				systemConfig,
				'reserved-mediated-secret-name',
			);

			await expect(
				createToolVm(
					{
						cacheDir: systemConfig.cacheDir,
						agentId: 'sun',
						profile: standardProfile,
						systemConfig,
						tcpSlot: 0,
						hostWorkMountDir: requestedWorkMountDir,
						zoneId: 'shravan',
						secretResolver: createSecretResolver({ [reservedSecretName]: 'real-secret' }),
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
				),
			).rejects.toThrow('reserved by agent-vm runtime bootstrap');
			expect(exec).not.toHaveBeenCalled();
		},
	);

	it('preserves the primary bootstrap failure when live-handle cleanup also fails', async () => {
		const systemConfig = await createToolVmSystemConfig();
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected test zone');
		}
		zone.egressHosts = [{ host: 'api.github.com', audience: 'tool-vm' }];
		zone.secrets = {
			TOOL_TOKEN: {
				source: 'environment',
				envVar: 'TOOL_TOKEN',
				injection: 'http-mediation',
				audience: 'tool-vm',
				hosts: ['api.github.com'],
				agentAccess: 'all',
			},
		};
		const standardProfile = systemConfig.toolVmProfiles.standard;
		if (!standardProfile) {
			throw new Error('Expected standard tool VM profile');
		}
		const requestedWorkMountDir = await createWorkMountDirectory(
			systemConfig,
			'failed-create-rollback',
		);
		const closePinnedRealFsRoot = vi.fn();
		let adapterOwnedPinnedRoot: PinnedRealFsRoot | undefined;
		let runnerAttached = true;
		const closeError = new Error('stock VM close failed');
		const closeMock = vi.fn(async () => {
			if (adapterOwnedPinnedRoot) {
				closePinnedRealFsRoot(adapterOwnedPinnedRoot);
			}
			throw closeError;
		});
		let execCount = 0;
		const managedVm = createManagedVmStub({
			close: closeMock,
			exec: () => {
				execCount += 1;
				return createManagedExecProcessStub(
					execCount === 1
						? {}
						: {
								exitCode: 1,
								stderr: 'mediated env bootstrap failed',
							},
				);
			},
			id: 'managed-vm-failed-create-rollback',
			getHostPid: () => (runnerAttached ? 28_282 : null),
		});

		let thrownError: unknown;
		try {
			await createToolVm(
				{
					cacheDir: systemConfig.cacheDir,
					agentId: 'sun',
					profile: standardProfile,
					systemConfig,
					tcpSlot: 0,
					hostWorkMountDir: requestedWorkMountDir,
					zoneId: 'shravan',
					secretResolver: createSecretResolver({ TOOL_TOKEN: 'real-secret' }),
				},
				{
					buildGondolinImage: async () => ({
						built: true,
						fingerprint: 'tool-fingerprint',
						imagePath: '/cache/tool-fingerprint',
					}),
					createManagedVm: async (createVmOptions) => {
						adapterOwnedPinnedRoot = createVmOptions.vfsMounts['/workspace']?.pinnedHostRoot;
						return managedVm;
					},
					closePinnedRealFsRoot,
					managedVmKillDependencies: createManagedVmKillDependencies({
						isProcessAlive: () => runnerAttached,
						killProcess: (_pid, _signal) => {
							runnerAttached = false;
						},
					}),
					pinRealFsRoot: createPinnedRealFsRoot,
				},
			);
		} catch (error) {
			thrownError = error;
		}

		expect(thrownError).toBeInstanceOf(AggregateError);
		const aggregateError = thrownError as AggregateError;
		expect(aggregateError.errors).toEqual([
			expect.objectContaining({
				message: expect.stringMatching(/Failed to install Tool VM mediated secret placeholders/u),
			}),
			expect.objectContaining({
				cause: closeError,
				message: expect.stringMatching(/controller-managed termination.*not proven complete/iu),
			}),
		]);
		expect(aggregateError.cause).toBe(aggregateError.errors[0]);
		expect(closeMock).toHaveBeenCalledOnce();
		expect(closePinnedRealFsRoot).toHaveBeenCalledOnce();
	});

	it('mounts zone Git leases at /zone and /agent-vm/zone-git', async () => {
		const exec = vi.fn(() => createManagedExecProcessStub());
		const managedVm = createManagedVmStub({ exec, getHostPid: () => null });
		let capturedCreateVmOptions: CreateVmOptions | undefined;
		const createManagedVm = vi.fn(async (createVmOptions: CreateVmOptions) => {
			capturedCreateVmOptions = createVmOptions;
			return managedVm;
		});
		const systemConfig = await createToolVmSystemConfig();
		const zone = systemConfig.zones.find((configuredZone) => configuredZone.id === 'shravan');
		if (zone?.gateway.type !== 'openclaw') {
			throw new Error('Expected shravan OpenClaw zone');
		}
		const standardProfile = systemConfig.toolVmProfiles.standard;
		if (!standardProfile) {
			throw new Error('Expected standard tool VM profile');
		}
		const requestedWorkMountDir = await createWorkMountDirectory(systemConfig, 'agents/shravan');
		const hostZoneGitRoot = path.join(systemConfig.runtimeDir, 'zones', 'shravan', 'zone-git');
		await mkdir(hostZoneGitRoot, { recursive: true });
		const realWorkMountDir = await realpath(requestedWorkMountDir);
		const realZoneFilesDir = await realpath(zone.gateway.zoneFilesDir);
		const realZoneGitRoot = await realpath(hostZoneGitRoot);

		await createToolVm(
			{
				cacheDir: systemConfig.cacheDir,
				agentId: 'sun',
				profile: standardProfile,
				systemConfig,
				tcpSlot: 0,
				hostWorkMountDir: requestedWorkMountDir,
				zoneGitMount: {
					hostZoneFilesDir: zone.gateway.zoneFilesDir,
					hostZoneGitRoot,
				},
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

		expect(capturedCreateVmOptions?.vfsMounts).not.toHaveProperty('/work');
		expect(createManagedVm).toHaveBeenCalledWith(
			expect.objectContaining({
				vfsMounts: {
					'/agent-vm/zone-git': {
						hostPath: realZoneGitRoot,
						kind: 'realfs',
						pinnedHostRoot: expect.objectContaining({
							realPath: realZoneGitRoot,
						}),
					},
					'/zone': {
						hostPath: realZoneFilesDir,
						kind: 'realfs',
						pinnedHostRoot: expect.objectContaining({
							realPath: realZoneFilesDir,
						}),
					},
				},
			}),
		);
		expect(realWorkMountDir).toBe(path.join(realZoneFilesDir, 'agents', 'shravan'));
		expect(exec).toHaveBeenCalledWith('git config --global --add safe.directory /zone');
	});

	it('rejects zone git mounts outside the configured runtime zone git root', async () => {
		const createManagedVm = vi.fn(async () => {
			throw new Error('createManagedVm should not be called for an invalid zone git root.');
		});
		const systemConfig = await createToolVmSystemConfig();
		const zone = systemConfig.zones.find((configuredZone) => configuredZone.id === 'shravan');
		if (zone?.gateway.type !== 'openclaw') {
			throw new Error('Expected shravan OpenClaw zone');
		}
		const standardProfile = systemConfig.toolVmProfiles.standard;
		if (!standardProfile) {
			throw new Error('Expected standard tool VM profile');
		}
		const requestedWorkMountDir = await createWorkMountDirectory(systemConfig, 'agents/shravan');
		const expectedHostZoneGitRoot = path.join(
			systemConfig.runtimeDir,
			'zones',
			'shravan',
			'zone-git',
		);
		const wrongHostZoneGitRoot = path.join(systemConfig.runtimeDir, 'zones', 'other', 'zone-git');
		await mkdir(expectedHostZoneGitRoot, { recursive: true });
		await mkdir(wrongHostZoneGitRoot, { recursive: true });

		await expect(
			createToolVm(
				{
					cacheDir: systemConfig.cacheDir,
					agentId: 'sun',
					profile: standardProfile,
					systemConfig,
					tcpSlot: 0,
					hostWorkMountDir: requestedWorkMountDir,
					zoneGitMount: {
						hostZoneFilesDir: zone.gateway.zoneFilesDir,
						hostZoneGitRoot: wrongHostZoneGitRoot,
					},
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
				},
			),
		).rejects.toThrow(/does not match expected runtime path/u);
		expect(createManagedVm).not.toHaveBeenCalled();
	});

	it('persists tool writes through the RealFS /workspace backing directory', async () => {
		const managedVm = createManagedVmStub({ getHostPid: () => null });
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
				agentId: 'sun',
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
					const workspaceMount = createVmOptions.vfsMounts['/workspace'];
					if (!workspaceMount || workspaceMount.kind !== 'realfs') {
						throw new Error('Expected Tool VM /workspace to be a RealFS mount.');
					}
					if (createVmOptions.vfsMounts['/work']) {
						throw new Error('Expected Tool VM /work to remain rootfs/COW, not a RealFS mount.');
					}
					if (typeof workspaceMount.hostPath !== 'string') {
						throw new Error('Expected Tool VM /workspace RealFS mount to include hostPath.');
					}
					await writeFile(
						path.join(workspaceMount.hostPath, 'notes.md'),
						'persisted through /workspace',
					);
					return managedVm;
				},
				closePinnedRealFsRoot: () => {},
				pinRealFsRoot: createPinnedRealFsRoot,
			},
		);

		await expect(readFile(persistedFilePath, 'utf8')).resolves.toBe('persisted through /workspace');
	});

	it('creates the tool VM without running redundant runtime setup commands', async () => {
		const exec = vi.fn(() => createManagedExecProcessStub());
		const managedVm = createManagedVmStub({ exec, getHostPid: () => null });

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
				agentId: 'sun',
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
		expect(exec).toHaveBeenCalledOnce();
		expect(exec).toHaveBeenCalledWith('rm -f /etc/ssh/ssh_host_*');
	});

	it('uses a prepared Tool VM image record without rebuilding Gondolin assets', async () => {
		const managedVm = createManagedVmStub({ getHostPid: () => null });
		const systemConfig = await createToolVmSystemConfig();
		const standardProfile = systemConfig.toolVmProfiles.standard;
		if (!standardProfile) {
			throw new Error('Expected standard tool VM profile');
		}
		const requestedWorkMountDir = await createWorkMountDirectory(
			systemConfig,
			'openclaw-work-mount',
		);
		const cacheDir = path.join(systemConfig.cacheDir, 'tool-vm-images', 'default');
		const imagePath = path.join(cacheDir, 'prepared-fingerprint');
		await writeFakeImageAssets(imagePath);
		await writePreparedGondolinImage({
			buildConfigPath: '/project/vm-images/tool-vms/default/build-config.json',
			cacheDir,
			fingerprint: 'prepared-fingerprint',
			fingerprintInput: { dockerRootfsIdentity: { layers: ['sha256:tool'] }, schemaVersion: 1 },
			imagePath,
		});
		const buildGondolinImage = vi.fn(async () => ({
			built: true,
			fingerprint: 'rebuilt-fingerprint',
			imagePath: '/cache/rebuilt-fingerprint',
		}));
		let capturedCreateVmOptions: CreateVmOptions | undefined;

		await createToolVm(
			{
				cacheDir: systemConfig.cacheDir,
				agentId: 'sun',
				profile: standardProfile,
				systemConfig,
				tcpSlot: 0,
				hostWorkMountDir: requestedWorkMountDir,
				zoneId: 'shravan',
				secretResolver: createSecretResolver({}),
			},
			{
				buildGondolinImage,
				createManagedVm: async (createVmOptions) => {
					capturedCreateVmOptions = createVmOptions;
					return managedVm;
				},
				closePinnedRealFsRoot: () => {},
				pinRealFsRoot: createPinnedRealFsRoot,
			},
		);

		expect(buildGondolinImage).not.toHaveBeenCalled();
		expect(capturedCreateVmOptions?.imagePath).toBe(imagePath);
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
					agentId: 'sun',
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
					agentId: 'sun',
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
					agentId: 'sun',
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
