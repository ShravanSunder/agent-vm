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
	ManagedVm,
	ManagedVmCreateRequest,
	ManagedVmExactProcessTerminationCapability,
	OwnedHostDirectory,
} from '@agent-vm/managed-vm';
import type { SecretRef, SecretResolver } from '@agent-vm/secret-management';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { configuredImageSelectionRecordPath } from '../build/prepared-gondolin-image-cache.js';
import { createManagedVmRuntimeComposition } from '../composition/gondolin-managed-vm-provider.js';
import { createLoadedSystemConfig, type LoadedSystemConfig } from '../config/system-config.js';
import {
	deploymentGeneratedDirForStorageRoot,
	sharedImageCacheDirForSystemConfig,
} from '../config/system-config.js';
import {
	createInvalidImageSelectionFixture,
	invalidImageSelectionKinds,
} from '../testing/image-selection-test-fixture.js';
import {
	TEST_SSH_SERVER_HOST_KEY,
	createManagedExecProcessStub,
} from '../testing/managed-vm-test-helpers.js';
import {
	createToolVm as createToolVmWithManagedProvider,
	type StartedToolVmLifecycleDependencies,
	type ToolVmLifecycleDependencies,
} from './tool-vm-lifecycle.js';

type CreateVmOptions = ManagedVmCreateRequest;

interface OwnedDirectoryBackingFixture {
	readonly device: number;
	readonly fd: number;
	readonly hostPath: string;
	readonly inode: number;
	readonly realPath: string;
}

interface ToolVmTestProviderOverrides {
	readonly managedAgentRootMountDependencies?: ToolVmLifecycleDependencies['managedAgentRootMountDependencies'];
	readonly prepareImage?: () => Promise<{
		readonly built: boolean;
		readonly fingerprint: string;
		readonly imageReference: string;
	}>;
	readonly closeOwnedDirectoryBacking?: (root: OwnedDirectoryBackingFixture) => void;
	readonly createManagedVm?: (request: ManagedVmCreateRequest) => Promise<ManagedVm>;
	readonly managedVmExactProcessTermination?: ManagedVmExactProcessTerminationCapability;
	readonly openOwnedDirectoryBacking?: (hostPath: string) => OwnedDirectoryBackingFixture;
	readonly readProcessIdentity?: StartedToolVmLifecycleDependencies['readProcessIdentity'];
	readonly validateControllerSelectedToolVmDirectory?: ToolVmLifecycleDependencies['validateControllerSelectedToolVmDirectory'];
}

function createToolVmTestDependencies(
	options: ToolVmTestProviderOverrides,
): StartedToolVmLifecycleDependencies {
	return {
		managedAgentRootMountDependencies: options.managedAgentRootMountDependencies ?? {
			readDirectoryIdentity: async (hostPath) => ({
				canonicalPath: hostPath,
				device: 1,
				inode: hostPath.includes('/gitdirs/') ? 2 : 1,
			}),
		},
		managedVmFactory: {
			async createManagedVm(request): Promise<ManagedVm> {
				const transfers = Object.values(request.mounts).flatMap((mount) =>
					mount.kind === 'owned-host-directory' || mount.kind === 'owned-filtered-workspace'
						? [mount.directory.consume()]
						: [],
				);
				try {
					return await (
						options.createManagedVm ??
						(async () => {
							throw new Error('Unexpected managed VM creation.');
						})
					)(request);
				} catch (error) {
					for (const transfer of transfers) transfer.close();
					throw error;
				}
			},
		},
		managedVmImages: {
			prepareImage: async () => {
				const image = await (
					options.prepareImage ??
					(async () => ({
						built: true,
						fingerprint: 'tool-fingerprint',
						imageReference: '/cache/tool-fingerprint',
					}))
				)();
				return {
					built: image.built,
					fingerprint: image.fingerprint,
					imageReference: image.imageReference,
				};
			},
		},
		managedVmOwnedDirectories: {
			openHostDirectory(hostPath): OwnedHostDirectory {
				const directoryBacking = (
					options.openOwnedDirectoryBacking ?? createOwnedDirectoryBackingFixture
				)(hostPath);
				let state: OwnedHostDirectory['state'] = 'acquired';
				return {
					close(): void {
						if (state === 'closed') return;
						state = 'closed';
						options.closeOwnedDirectoryBacking?.(directoryBacking);
					},
					consume() {
						if (state !== 'acquired') throw new Error('owned directory consumed twice');
						state = 'adapter-owned';
						return {
							close: () => {
								state = 'closed';
								options.closeOwnedDirectoryBacking?.(directoryBacking);
							},
							identity: {
								canonicalPath: directoryBacking.realPath,
								device: directoryBacking.device,
								inode: directoryBacking.inode,
							},
							get state() {
								return state === 'closed' ? ('closed' as const) : ('adapter-owned' as const);
							},
						};
					},
					identity: {
						canonicalPath: directoryBacking.realPath,
						device: directoryBacking.device,
						inode: directoryBacking.inode,
					},
					get state() {
						return state;
					},
				};
			},
		},
		managedVmExactProcessTermination:
			options.managedVmExactProcessTermination ?? createManagedVmExactProcessTermination(),
		managedVmTerminationSleep: async () => {},
		readProcessIdentity: options.readProcessIdentity ?? (async () => testToolVmProcessIdentity),
		...(options.validateControllerSelectedToolVmDirectory
			? {
					validateControllerSelectedToolVmDirectory:
						options.validateControllerSelectedToolVmDirectory,
				}
			: {}),
	};
}

async function createToolVm(
	options: Omit<Parameters<typeof createToolVmWithManagedProvider>[0], 'rootBinding'> & {
		readonly hostWorkspaceRoot: string;
	},
	dependencies: ToolVmTestProviderOverrides,
): Promise<ManagedVm> {
	const hostGitDirectoryRoot = await createAgentGitDirectoryRoot({
		agentId: options.agentId,
		systemConfig: options.systemConfig,
		zoneId: options.zoneId,
	});
	return await createToolVmWithManagedProvider(
		{
			...options,
			rootBinding: {
				hostGitDirectoryRoot,
				hostWorkspaceRoot: options.hostWorkspaceRoot,
				kind: 'managed-agent-workspace',
			},
		},
		createToolVmTestDependencies(dependencies),
	);
}

const createdDirectories: string[] = [];

describe('Tool VM invalid image selection admission', () => {
	it.each(invalidImageSelectionKinds)(
		'rejects %s selection before creating a VM',
		async (invalidKind) => {
			const systemConfig = await createInvalidImageSelectionFixture({
				systemConfig: await createToolVmSystemConfig(),
				family: 'toolVm',
				profileName: 'default',
				invalidKind,
			});
			const profile = systemConfig.toolVmProfiles.standard;
			const imageProfile = systemConfig.imageProfiles.toolVms.default;
			if (profile === undefined || imageProfile === undefined)
				throw new Error('Expected Tool VM fixture profiles.');
			const hostWorkspaceRoot = await createWorkMountDirectory(systemConfig, 'selection-proof');
			const createManagedVm = vi.fn();
			const composition = createManagedVmRuntimeComposition();

			await expect(
				createToolVm(
					{
						agentId: 'sun',
						profile,
						systemConfig,
						zoneId: 'shravan',
						secretResolver: createSecretResolver({}),
						hostWorkspaceRoot,
						tcpSlot: 19000,
					},
					{
						createManagedVm,
						prepareImage: async () =>
							await composition.managedVmImages.prepareImage({
								artifactCacheDirectory: sharedImageCacheDirForSystemConfig(systemConfig),
								recipePath: imageProfile.buildConfig,
								selectionRecordPath: configuredImageSelectionRecordPath({
									deploymentGeneratedDir: deploymentGeneratedDirForStorageRoot(
										systemConfig.storageRootDir,
									),
									family: 'toolVm',
									profileName: 'default',
								}),
							}),
					},
				),
			).rejects.toThrow(/Run agent-vm build/u);
			expect(createManagedVm).not.toHaveBeenCalled();
		},
	);
});
const testToolVmProcessIdentity = {
	command: 'qemu-system-aarch64 -name tool-vm-test',
	lstart: 'Sat Jul 11 18:00:00 2026',
} as const;

function createManagedVmExactProcessTermination(
	overrides: Partial<ManagedVmExactProcessTerminationCapability> = {},
): ManagedVmExactProcessTerminationCapability {
	return {
		terminateRecordedHostProcess: async ({ identity }) => ({
			hostProcessId: identity.hostProcessId,
			kind: 'already-absent',
		}),
		...overrides,
	};
}

afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
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

	return createLoadedSystemConfig(
		{
			storageRootDir: path.join(temporaryDirectory, 'storage'),
			host: {
				controllerPort: 18800,
				projectNamespace: 'agent-vm-tests-a1b2c3d4',
				secretsProvider: {
					type: '1password',
					tokenSource: { type: 'env' },
				},
			},
			imageProfiles: {
				gateways: {
					hermes: {
						type: 'hermes',
						buildConfig: '/project/vm-images/gateways/hermes/build-config.json',
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
						type: 'hermes',
						imageProfile: 'hermes',
						cpus: 2,
						memory: '2G',
						config: './config/shravan/hermes.json',
						profileSecretProjectionsByAgent: {
							sun: {
								API_SERVER_KEY: 'API_SERVER_KEY_SUN',
								DISCORD_BOT_TOKEN: 'DISCORD_BOT_TOKEN_SUN',
							},
						},
						profilesByAgent: { sun: 'sun' },
						port: 18791,
					},
					id: 'shravan',
					secrets: {
						API_SERVER_KEY_SUN: {
							source: 'environment',
							envVar: 'API_SERVER_KEY_SUN',
							injection: 'env',
							audience: 'gateway',
						},
						DISCORD_BOT_TOKEN_SUN: {
							source: 'environment',
							envVar: 'DISCORD_BOT_TOKEN_SUN',
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
	if (zone === undefined || zone.gateway.type === 'worker') {
		throw new Error('Expected shravan managed framework zone');
	}
	const hostWorkMountDir = path.join(
		zone.gateway.zoneFilesDir,
		name.startsWith('agents/') ? name : 'agents/sun',
	);
	await mkdir(hostWorkMountDir, { recursive: true });
	return hostWorkMountDir;
}

async function createAgentGitDirectoryRoot(options: {
	readonly agentId: string;
	readonly systemConfig: LoadedSystemConfig;
	readonly zoneId: string;
}): Promise<string> {
	const zone = options.systemConfig.zones.find(
		(candidateZone) => candidateZone.id === options.zoneId,
	);
	if (zone === undefined) {
		throw new Error(`Unknown test zone '${options.zoneId}'.`);
	}
	const hostGitDirectoryRoot = path.join(
		zone.gateway.zoneRuntimeDir,
		'gitdirs',
		'agents',
		options.agentId,
	);
	await mkdir(hostGitDirectoryRoot, { recursive: true });
	return await realpath(hostGitDirectoryRoot);
}

function createOwnedDirectoryBackingFixture(hostPath: string): OwnedDirectoryBackingFixture {
	return {
		device: 1,
		fd: -1,
		hostPath,
		inode: hostPath.includes('/gitdirs/') ? 2 : 1,
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

function createManagedVmStub(
	options: {
		readonly close?: ManagedVm['close'];
		readonly enableSsh?: ManagedVm['enableSsh'];
		readonly exec?: ManagedVm['exec'];
		readonly getHostProcessId?: ManagedVm['getHostProcessId'];
		readonly id?: string;
		readonly start?: ManagedVm['start'];
	} = {},
): ManagedVm {
	const close = options.close ?? vi.fn(async () => {});
	const exec = options.exec ?? vi.fn(() => createManagedExecProcessStub());
	const start = options.start ?? vi.fn(async () => {});
	const id = options.id ?? 'managed-vm';
	let defaultHostProcessIdReadCount = 0;
	return {
		close,
		configureIngressRoutes: () => {},
		enableIngress: async () => ({ close: async () => {}, host: '127.0.0.1', port: 18791 }),
		enableSsh: options.enableSsh ?? (async () => createSshAccessStub()),
		exec,
		getHostProcessId:
			options.getHostProcessId ??
			(() => {
				defaultHostProcessIdReadCount += 1;
				return defaultHostProcessIdReadCount <= 2 ? 28_282 : null;
			}),
		id,
		start,
	};
}

describe('createToolVm', () => {
	function createOwnedDirectoryFixture(options: {
		readonly canonicalPath: string;
		readonly closeError?: Error;
		readonly inode?: number;
	}): { readonly close: ReturnType<typeof vi.fn>; readonly directory: OwnedHostDirectory } {
		let state: OwnedHostDirectory['state'] = 'acquired';
		const close = vi.fn(() => {
			if (state === 'closed') return;
			state = 'closed';
			if (options.closeError) throw options.closeError;
		});
		return {
			close,
			directory: {
				close,
				consume() {
					if (state !== 'acquired') throw new Error('owned directory consumed twice');
					state = 'adapter-owned';
					return {
						close,
						identity: {
							canonicalPath: options.canonicalPath,
							device: 1,
							inode: options.inode ?? 1,
						},
						get state() {
							return state === 'closed' ? ('closed' as const) : ('adapter-owned' as const);
						},
					};
				},
				identity: {
					canonicalPath: options.canonicalPath,
					device: 1,
					inode: options.inode ?? 1,
				},
				get state() {
					return state;
				},
			},
		};
	}

	it('closes the acquired agent workspace when the factory rejects before consumption', async () => {
		const systemConfig = await createToolVmSystemConfig();
		const profile = systemConfig.toolVmProfiles.standard;
		if (!profile) throw new Error('Expected standard Tool VM profile.');
		const hostWorkspaceRoot = await realpath(
			await createWorkMountDirectory(systemConfig, 'reject-before-consume'),
		);
		const hostGitDirectoryRoot = await createAgentGitDirectoryRoot({
			agentId: 'sun',
			systemConfig,
			zoneId: 'shravan',
		});
		const workspaceDirectory = createOwnedDirectoryFixture({
			canonicalPath: hostWorkspaceRoot,
		});
		const gitDirectory = createOwnedDirectoryFixture({
			canonicalPath: hostGitDirectoryRoot,
			inode: 2,
		});
		const createError = new Error('factory rejected before consuming mounts');

		await expect(
			createToolVmWithManagedProvider(
				{
					agentId: 'sun',
					profile,
					rootBinding: {
						hostGitDirectoryRoot,
						hostWorkspaceRoot,
						kind: 'managed-agent-workspace',
					},
					secretResolver: createSecretResolver({}),
					systemConfig,
					tcpSlot: 0,
					zoneId: 'shravan',
				},
				{
					managedVmExactProcessTermination: createManagedVmExactProcessTermination(),
					managedVmFactory: {
						createManagedVm: async () => {
							throw createError;
						},
					},
					managedVmImages: {
						prepareImage: async () => ({
							built: true,
							fingerprint: 'image',
							imageReference: '/image',
						}),
					},
					managedAgentRootMountDependencies: {
						readDirectoryIdentity: async (hostPath) => ({
							canonicalPath: hostPath,
							device: 1,
							inode: hostPath === hostGitDirectoryRoot ? 2 : 1,
						}),
					},
					managedVmOwnedDirectories: {
						openHostDirectory: (hostPath) =>
							hostPath === hostGitDirectoryRoot
								? gitDirectory.directory
								: workspaceDirectory.directory,
					},
				},
			),
		).rejects.toBe(createError);
		expect(workspaceDirectory.close).toHaveBeenCalledOnce();
		expect(gitDirectory.close).not.toHaveBeenCalled();
	});

	it('aggregates an acquired-directory close failure with factory rejection', async () => {
		const systemConfig = await createToolVmSystemConfig();
		const profile = systemConfig.toolVmProfiles.standard;
		if (!profile) throw new Error('Expected standard Tool VM profile.');
		const hostWorkspaceRoot = await realpath(
			await createWorkMountDirectory(systemConfig, 'reject-close-failure'),
		);
		const hostGitDirectoryRoot = await createAgentGitDirectoryRoot({
			agentId: 'sun',
			systemConfig,
			zoneId: 'shravan',
		});
		const closeError = new Error('owned directory close failed');
		const workspaceDirectory = createOwnedDirectoryFixture({
			canonicalPath: hostWorkspaceRoot,
			closeError,
		});
		const gitDirectory = createOwnedDirectoryFixture({
			canonicalPath: hostGitDirectoryRoot,
			inode: 2,
		});
		const createError = new Error('factory rejected before consuming mounts');

		const creation = createToolVmWithManagedProvider(
			{
				agentId: 'sun',
				profile,
				rootBinding: {
					hostGitDirectoryRoot,
					hostWorkspaceRoot,
					kind: 'managed-agent-workspace',
				},
				secretResolver: createSecretResolver({}),
				systemConfig,
				tcpSlot: 0,
				zoneId: 'shravan',
			},
			{
				managedVmExactProcessTermination: createManagedVmExactProcessTermination(),
				managedVmFactory: {
					createManagedVm: async () => {
						throw createError;
					},
				},
				managedVmImages: {
					prepareImage: async () => ({
						built: true,
						fingerprint: 'image',
						imageReference: '/image',
					}),
				},
				managedAgentRootMountDependencies: {
					readDirectoryIdentity: async (hostPath) => ({
						canonicalPath: hostPath,
						device: 1,
						inode: hostPath === hostGitDirectoryRoot ? 2 : 1,
					}),
				},
				managedVmOwnedDirectories: {
					openHostDirectory: (hostPath) =>
						hostPath === hostGitDirectoryRoot
							? gitDirectory.directory
							: workspaceDirectory.directory,
				},
			},
		);
		await expect(creation).rejects.toMatchObject({
			errors: [createError, expect.objectContaining({ errors: [closeError] })],
		});
		expect(gitDirectory.close).not.toHaveBeenCalled();
	});

	it('mounts one filtered agent workspace at /workspace and leaves /work in rootfs', async () => {
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
		const requestedWorkspaceRoot = await createWorkMountDirectory(systemConfig, 'agents/sun');
		const realWorkspaceRoot = await realpath(requestedWorkspaceRoot);

		await createToolVm(
			{
				agentId: 'sun',
				profile: standardProfile,
				systemConfig,
				tcpSlot: 0,
				hostWorkspaceRoot: requestedWorkspaceRoot,
				zoneId: 'shravan',
				secretResolver: createSecretResolver({}),
			},
			{
				prepareImage: async () => ({
					built: true,
					fingerprint: 'tool-fingerprint',
					imageReference: '/cache/tool-fingerprint',
				}),
				createManagedVm,
				closeOwnedDirectoryBacking: () => {},
				managedVmExactProcessTermination: createManagedVmExactProcessTermination(),
				openOwnedDirectoryBacking: createOwnedDirectoryBackingFixture,
			},
		);

		expect(createManagedVm).toHaveBeenCalledWith(
			expect.objectContaining({
				mounts: expect.objectContaining({
					'/workspace': {
						kind: 'owned-filtered-workspace',
						directory: expect.objectContaining({
							identity: expect.objectContaining({ canonicalPath: realWorkspaceRoot }),
						}),
						policy: {
							hiddenPaths: [],
							readonlyInputs: [],
							temporaryPaths: [],
							visibility: {
								kind: 'positive-paths',
								visiblePaths: [''],
								writablePaths: [''],
							},
						},
					},
				}),
			}),
		);
		expect(capturedCreateVmOptions?.mounts['/workspace']).toEqual(
			expect.objectContaining({
				kind: 'owned-filtered-workspace',
				directory: expect.objectContaining({
					identity: expect.objectContaining({ canonicalPath: realWorkspaceRoot }),
				}),
			}),
		);
		expect(capturedCreateVmOptions?.mounts).not.toHaveProperty('/work');
		expect(capturedCreateVmOptions?.mounts).not.toHaveProperty('/gitdirs');
		expect(capturedCreateVmOptions?.mounts).not.toHaveProperty('/agent');
		expect(capturedCreateVmOptions?.mounts).not.toHaveProperty('/scratch');
		// IPv4-preference egress for Node consumers inside the Tool VM
		// to defeat Happy Eyeballs racing on gondolin's synthetic AAAA.
		// See FORCE_IPV4_EGRESS_NODE_OPTIONS in @agent-vm/gateway-lifecycle.
		expect(capturedCreateVmOptions?.environment.NODE_OPTIONS).toBe(
			'--dns-result-order=ipv4first --no-network-family-autoselection',
		);
		expect(capturedCreateVmOptions?.runtimeRootfsSize).toBe('16G');
	});

	it('attaches read-only Git SSH egress for a selected Hermes managed workspace repository', async () => {
		// Arrange
		vi.stubEnv('SSH_AUTH_SOCK', '/tmp/agent-vm-test-agent.sock');
		const managedVm = createManagedVmStub();
		let capturedCreateVmOptions: CreateVmOptions | undefined;
		const systemConfig = await createToolVmSystemConfig();
		const zone = systemConfig.zones[0];
		const standardProfile = systemConfig.toolVmProfiles.standard;
		if (zone === undefined || standardProfile === undefined) {
			throw new Error('Expected Tool VM lifecycle test zone and profile.');
		}
		zone.agents = [
			{
				id: 'sun',
				workspaceGit: {
					mode: 'remote',
					remote: {
						branch: 'agent/sun',
						defaultBranch: 'main',
						repoUrl: 'https://github.com/shravan/sun-workspace.git',
					},
				},
			},
		];
		const requestedWorkspaceRoot = await createWorkMountDirectory(systemConfig, 'agents/sun');

		// Act
		await createToolVm(
			{
				agentId: 'sun',
				hostWorkspaceRoot: requestedWorkspaceRoot,
				profile: standardProfile,
				secretResolver: createSecretResolver({}),
				systemConfig,
				tcpSlot: 0,
				zoneId: 'shravan',
			},
			{
				createManagedVm: async (createVmOptions) => {
					capturedCreateVmOptions = createVmOptions;
					return managedVm;
				},
				openOwnedDirectoryBacking: createOwnedDirectoryBackingFixture,
			},
		);

		// Assert
		expect(capturedCreateVmOptions?.sshEgress).toEqual({
			agentSocket: '/tmp/agent-vm-test-agent.sock',
			allowedHosts: ['github.com'],
			allowedRepositories: ['shravan/sun-workspace'],
			kind: 'git-read-only',
		});
		expect(capturedCreateVmOptions?.mounts['/workspace']).toEqual(
			expect.objectContaining({
				policy: {
					hiddenPaths: [],
					readonlyInputs: [
						{
							destinationRelativePath: '.git',
							sourceRelativePath: '.git',
						},
					],
					temporaryPaths: [],
					visibility: {
						kind: 'positive-paths',
						visiblePaths: [''],
						writablePaths: [''],
					},
				},
			}),
		);
		expect(capturedCreateVmOptions?.mounts['/gitdirs']).toEqual(
			expect.objectContaining({
				access: 'read-write',
				kind: 'owned-host-directory',
			}),
		);
	});

	it('does not attach Git SSH egress without remote workspace Git', async () => {
		// Arrange
		vi.stubEnv('SSH_AUTH_SOCK', '/tmp/agent-vm-test-agent.sock');
		const managedVm = createManagedVmStub();
		let capturedCreateVmOptions: CreateVmOptions | undefined;
		const systemConfig = await createToolVmSystemConfig();
		const standardProfile = systemConfig.toolVmProfiles.standard;
		if (standardProfile === undefined) {
			throw new Error('Expected standard Tool VM profile.');
		}
		const requestedWorkspaceRoot = await createWorkMountDirectory(systemConfig, 'agents/sun');

		// Act
		await createToolVm(
			{
				agentId: 'sun',
				hostWorkspaceRoot: requestedWorkspaceRoot,
				profile: standardProfile,
				secretResolver: createSecretResolver({}),
				systemConfig,
				tcpSlot: 0,
				zoneId: 'shravan',
			},
			{
				createManagedVm: async (createVmOptions) => {
					capturedCreateVmOptions = createVmOptions;
					return managedVm;
				},
				openOwnedDirectoryBacking: createOwnedDirectoryBackingFixture,
			},
		);

		// Assert
		expect(capturedCreateVmOptions?.sshEgress).toBeUndefined();
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
				hostWorkspaceRoot: requestedWorkMountDir,
				profile: standardProfile,
				secretResolver: createSecretResolver({ TOOL_TOKEN: 'real-secret' }),
				systemConfig,
				tcpSlot: 0,
				zoneId: 'shravan',
			},
			{
				prepareImage: async () => ({
					built: true,
					fingerprint: 'tool-fingerprint',
					imageReference: '/cache/tool-fingerprint',
				}),
				closeOwnedDirectoryBacking: () => {},
				createManagedVm: async () => managedVm,
				readProcessIdentity: async () => {
					orderedEvents.push('capture-process-identity');
					return testToolVmProcessIdentity;
				},
				openOwnedDirectoryBacking: createOwnedDirectoryBackingFixture,
			},
		);
		await createdVm.enableSsh();

		// Assert
		expect(orderedEvents).toEqual([
			'start',
			'capture-process-identity',
			'exec',
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
			getHostProcessId: () => null,
			start: async () => {
				throw startError;
			},
		});

		// Act
		const creation = createToolVm(
			{
				agentId: 'sun',
				hostWorkspaceRoot: requestedWorkMountDir,
				profile: standardProfile,
				secretResolver: createSecretResolver({}),
				systemConfig,
				tcpSlot: 0,
				zoneId: 'shravan',
			},
			{
				prepareImage: async () => ({
					built: true,
					fingerprint: 'tool-fingerprint',
					imageReference: '/cache/tool-fingerprint',
				}),
				closeOwnedDirectoryBacking: () => {},
				createManagedVm: async () => managedVm,
				openOwnedDirectoryBacking: createOwnedDirectoryBackingFixture,
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
			getHostProcessId: () => 28_282,
			start: async () => {
				throw startError;
			},
		});

		// Act
		const creation = createToolVm(
			{
				agentId: 'sun',
				hostWorkspaceRoot: requestedWorkMountDir,
				profile: standardProfile,
				secretResolver: createSecretResolver({}),
				systemConfig,
				tcpSlot: 0,
				zoneId: 'shravan',
			},
			{
				prepareImage: async () => ({
					built: true,
					fingerprint: 'tool-fingerprint',
					imageReference: '/cache/tool-fingerprint',
				}),
				closeOwnedDirectoryBacking: () => {},
				createManagedVm: async () => managedVm,
				openOwnedDirectoryBacking: createOwnedDirectoryBackingFixture,
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

	it('closes the adapter-owned workspace backing once when construction fails', async () => {
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
		const closeOwnedDirectoryBacking = vi.fn();

		// Act
		const creation = createToolVm(
			{
				agentId: 'sun',
				hostWorkspaceRoot: requestedWorkMountDir,
				profile: standardProfile,
				secretResolver: createSecretResolver({}),
				systemConfig,
				tcpSlot: 0,
				zoneId: 'shravan',
			},
			{
				prepareImage: async () => ({
					built: true,
					fingerprint: 'tool-fingerprint',
					imageReference: '/cache/tool-fingerprint',
				}),
				closeOwnedDirectoryBacking,
				createManagedVm: async (createVmOptions) => {
					const workspaceMount = createVmOptions.mounts['/workspace'];
					if (workspaceMount?.kind !== 'owned-filtered-workspace') {
						throw new Error('Expected provider-owned filtered workspace.');
					}
					throw createError;
				},
				openOwnedDirectoryBacking: createOwnedDirectoryBackingFixture,
			},
		);

		// Assert
		await expect(creation).rejects.toBe(createError);
		expect(closeOwnedDirectoryBacking).toHaveBeenCalledOnce();
	});

	it('passes only Tool VM egress hosts and mediated secrets into the Tool VM', async () => {
		const exec = vi.fn<ManagedVm['exec']>(() => createManagedExecProcessStub());
		const managedVm = createManagedVmStub({ exec });
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
				agentId: 'sun',
				profile: standardProfile,
				systemConfig,
				tcpSlot: 0,
				hostWorkspaceRoot: requestedWorkMountDir,
				zoneId: 'shravan',
				secretResolver,
			},
			{
				prepareImage: async () => ({
					built: true,
					fingerprint: 'tool-fingerprint',
					imageReference: '/cache/tool-fingerprint',
				}),
				createManagedVm,
				closeOwnedDirectoryBacking: () => {},
				openOwnedDirectoryBacking: createOwnedDirectoryBackingFixture,
			},
		);

		expect(capturedCreateVmOptions).toMatchObject({
			allowedHosts: ['api.github.com', 'api.linear.app', 'mcp2.readwise.io'],
			mediatedSecrets: expect.arrayContaining([
				{
					allowedHosts: ['api.github.com'],
					environmentVariable: 'GITHUB_TOKEN',
					value: 'github-real-secret',
				},
				{
					allowedHosts: ['api.linear.app'],
					environmentVariable: 'LINEAR_API_KEY',
					value: 'linear-real-secret',
				},
			]),
		});
		expect(capturedCreateVmOptions?.mediatedSecrets).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ environmentVariable: 'DISCORD_BOT_TOKEN' }),
				expect.objectContaining({ environmentVariable: 'GATEWAY_ONLY_TOKEN' }),
				expect.objectContaining({ environmentVariable: 'READWISE_ACCESS_TOKEN' }),
			]),
		);
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
		expect(exec).toHaveBeenCalledTimes(3);
		expect(exec.mock.calls[0]?.[0]).toBe('rm -f /etc/ssh/ssh_host_*');
		expect(exec.mock.calls[1]?.[0]).toEqual([
			'git',
			'config',
			'--system',
			'--replace-all',
			'safe.directory',
			'/workspace',
		]);
		const bootstrapCommand = exec.mock.calls[2]?.[0];
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
		const managedVm = createManagedVmStub();
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
				agentId: 'sun',
				profile: standardProfile,
				systemConfig,
				tcpSlot: 0,
				hostWorkspaceRoot: requestedWorkMountDir,
				zoneId: 'shravan',
				secretResolver: createSecretResolver({}),
			},
			{
				prepareImage: async () => ({
					built: true,
					fingerprint: 'tool-fingerprint',
					imageReference: '/cache/tool-fingerprint',
				}),
				createManagedVm,
				closeOwnedDirectoryBacking: () => {},
				openOwnedDirectoryBacking: createOwnedDirectoryBackingFixture,
			},
		);

		const onRequest = capturedCreateVmOptions?.mediation?.onRequest;
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
			const managedVm = createManagedVmStub({ exec });
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
						agentId: 'sun',
						profile: standardProfile,
						systemConfig,
						tcpSlot: 0,
						hostWorkspaceRoot: requestedWorkMountDir,
						zoneId: 'shravan',
						secretResolver: createSecretResolver({ [reservedSecretName]: 'real-secret' }),
					},
					{
						prepareImage: async () => ({
							built: true,
							fingerprint: 'tool-fingerprint',
							imageReference: '/cache/tool-fingerprint',
						}),
						createManagedVm,
						closeOwnedDirectoryBacking: () => {},
						openOwnedDirectoryBacking: createOwnedDirectoryBackingFixture,
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
		const closeOwnedDirectoryBacking = vi.fn();
		let adapterOwnedDirectory: OwnedHostDirectory | undefined;
		let runnerAttached = true;
		const closeError = new Error('stock VM close failed');
		const closeMock = vi.fn(async () => {
			if (adapterOwnedDirectory) {
				adapterOwnedDirectory.close();
			}
			throw closeError;
		});
		let execCount = 0;
		const managedVm = createManagedVmStub({
			close: closeMock,
			exec: () => {
				execCount += 1;
				return createManagedExecProcessStub(
					execCount < 3
						? {}
						: {
								exitCode: 1,
								stderr: 'mediated env bootstrap failed',
							},
				);
			},
			id: 'managed-vm-failed-create-rollback',
			getHostProcessId: () => (runnerAttached ? 28_282 : null),
		});

		let thrownError: unknown;
		try {
			await createToolVm(
				{
					agentId: 'sun',
					profile: standardProfile,
					systemConfig,
					tcpSlot: 0,
					hostWorkspaceRoot: requestedWorkMountDir,
					zoneId: 'shravan',
					secretResolver: createSecretResolver({ TOOL_TOKEN: 'real-secret' }),
				},
				{
					prepareImage: async () => ({
						built: true,
						fingerprint: 'tool-fingerprint',
						imageReference: '/cache/tool-fingerprint',
					}),
					createManagedVm: async (createVmOptions) => {
						const workspaceMount = createVmOptions.mounts['/workspace'];
						adapterOwnedDirectory =
							workspaceMount?.kind === 'owned-filtered-workspace'
								? workspaceMount.directory
								: undefined;
						return managedVm;
					},
					closeOwnedDirectoryBacking,
					managedVmExactProcessTermination: createManagedVmExactProcessTermination({
						terminateRecordedHostProcess: async ({ identity }) => {
							if (!runnerAttached) {
								return { hostProcessId: identity.hostProcessId, kind: 'already-absent' };
							}
							runnerAttached = false;
							return { hostProcessId: identity.hostProcessId, kind: 'terminated' };
						},
					}),
					readProcessIdentity: async () => (runnerAttached ? testToolVmProcessIdentity : null),
					openOwnedDirectoryBacking: createOwnedDirectoryBackingFixture,
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
		expect(closeOwnedDirectoryBacking).toHaveBeenCalledOnce();
	});

	it('persists agent edits through the owned filtered /workspace backing directory', async () => {
		const managedVm = createManagedVmStub();
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
				agentId: 'sun',
				profile: standardProfile,
				systemConfig,
				tcpSlot: 0,
				hostWorkspaceRoot: requestedWorkMountDir,
				zoneId: 'shravan',
				secretResolver: createSecretResolver({}),
			},
			{
				prepareImage: async () => ({
					built: true,
					fingerprint: 'tool-fingerprint',
					imageReference: '/cache/tool-fingerprint',
				}),
				createManagedVm: async (createVmOptions) => {
					const workspaceMount = createVmOptions.mounts['/workspace'];
					if (workspaceMount?.kind !== 'owned-filtered-workspace') {
						throw new Error('Expected Tool VM /workspace to be an owned filtered mount.');
					}
					if (createVmOptions.mounts['/work']) {
						throw new Error('Expected Tool VM /work to remain rootfs/COW.');
					}
					if (createVmOptions.mounts['/scratch']) {
						throw new Error('Expected Tool VM /scratch to remain rootfs/COW, not a host mount.');
					}
					await writeFile(
						path.join(requestedWorkMountDir, 'notes.md'),
						'persisted through /workspace',
					);
					return managedVm;
				},
				closeOwnedDirectoryBacking: () => {},
				openOwnedDirectoryBacking: createOwnedDirectoryBackingFixture,
			},
		);

		await expect(readFile(persistedFilePath, 'utf8')).resolves.toBe('persisted through /workspace');
	});

	it('configures only /workspace as the safe Git directory in the started Tool VM', async () => {
		const exec = vi.fn(() => createManagedExecProcessStub());
		const managedVm = createManagedVmStub({ exec });

		const systemConfig = await createToolVmSystemConfig();
		const standardProfile = systemConfig.toolVmProfiles.standard;
		if (!standardProfile) {
			throw new Error('Expected standard tool VM profile');
		}
		const requestedWorkMountDir = await createWorkMountDirectory(systemConfig, 'hermes-work-mount');
		const prepareImage = vi.fn(async () => ({
			built: true,
			fingerprint: 'tool-fingerprint',
			imageReference: '/cache/tool-fingerprint',
		}));

		const result = await createToolVm(
			{
				agentId: 'sun',
				profile: standardProfile,
				systemConfig,
				tcpSlot: 0,
				hostWorkspaceRoot: requestedWorkMountDir,
				zoneId: 'shravan',
				secretResolver: createSecretResolver({}),
			},
			{
				prepareImage,
				createManagedVm: async () => managedVm,
				closeOwnedDirectoryBacking: () => {},
				openOwnedDirectoryBacking: createOwnedDirectoryBackingFixture,
			},
		);

		expect(result).toBe(managedVm);
		expect(prepareImage).toHaveBeenCalledOnce();
		expect(exec).toHaveBeenCalledTimes(2);
		expect(exec).toHaveBeenNthCalledWith(1, 'rm -f /etc/ssh/ssh_host_*');
		expect(exec).toHaveBeenNthCalledWith(2, [
			'git',
			'config',
			'--system',
			'--replace-all',
			'safe.directory',
			'/workspace',
		]);
	});

	it('uses the image reference returned by the managed VM image capability', async () => {
		const managedVm = createManagedVmStub();
		const systemConfig = await createToolVmSystemConfig();
		const standardProfile = systemConfig.toolVmProfiles.standard;
		if (!standardProfile) {
			throw new Error('Expected standard tool VM profile');
		}
		const requestedWorkMountDir = await createWorkMountDirectory(systemConfig, 'hermes-work-mount');
		const imagePath = path.join(systemConfig.cacheDir, 'vm-images', '1111111111111111');
		const prepareImage = vi.fn(async () => ({
			built: false,
			fingerprint: '1111111111111111',
			imageReference: imagePath,
		}));
		let capturedCreateVmOptions: CreateVmOptions | undefined;

		await createToolVm(
			{
				agentId: 'sun',
				profile: standardProfile,
				systemConfig,
				tcpSlot: 0,
				hostWorkspaceRoot: requestedWorkMountDir,
				zoneId: 'shravan',
				secretResolver: createSecretResolver({}),
			},
			{
				prepareImage,
				createManagedVm: async (createVmOptions) => {
					capturedCreateVmOptions = createVmOptions;
					return managedVm;
				},
				closeOwnedDirectoryBacking: () => {},
				openOwnedDirectoryBacking: createOwnedDirectoryBackingFixture,
			},
		);

		expect(prepareImage).toHaveBeenCalledOnce();
		expect(capturedCreateVmOptions?.imageReference).toBe(imagePath);
	});

	it('rejects direct lifecycle calls with host work mount paths outside Hermes roots', async () => {
		const systemConfig = await createToolVmSystemConfig();
		const standardProfile = systemConfig.toolVmProfiles.standard;
		if (!standardProfile) {
			throw new Error('Expected standard tool VM profile');
		}
		const prepareImage = vi.fn(async () => ({
			built: true,
			fingerprint: 'tool-fingerprint',
			imageReference: '/cache/tool-fingerprint',
		}));
		const createManagedVm = vi.fn();

		await expect(
			createToolVm(
				{
					agentId: 'sun',
					profile: standardProfile,
					secretResolver: createSecretResolver({}),
					systemConfig,
					tcpSlot: 0,
					hostWorkspaceRoot: '/etc',
					zoneId: 'shravan',
				},
				{
					prepareImage,
					createManagedVm,
				},
			),
		).rejects.toThrow(/could not be inspected/u);
		expect(prepareImage).not.toHaveBeenCalled();
		expect(createManagedVm).not.toHaveBeenCalled();
	});

	it('revalidates the host work mount directory after image build and before pinning', async () => {
		const systemConfig = await createToolVmSystemConfig();
		const standardProfile = systemConfig.toolVmProfiles.standard;
		if (!standardProfile) {
			throw new Error('Expected standard tool VM profile');
		}
		const requestedWorkMountDir = await createWorkMountDirectory(systemConfig, 'hermes-work-mount');
		const movedWorkMountDir = path.join(path.dirname(requestedWorkMountDir), 'moved-work-mount');
		const outsideDirectory = await createTemporaryDirectory();
		const prepareImage = vi.fn(async () => {
			await rename(requestedWorkMountDir, movedWorkMountDir);
			await symlink(outsideDirectory, requestedWorkMountDir);
			return {
				built: true,
				fingerprint: 'tool-fingerprint',
				imageReference: '/cache/tool-fingerprint',
			};
		});
		const createManagedVm = vi.fn();

		await expect(
			createToolVm(
				{
					agentId: 'sun',
					profile: standardProfile,
					secretResolver: createSecretResolver({}),
					systemConfig,
					tcpSlot: 0,
					hostWorkspaceRoot: requestedWorkMountDir,
					zoneId: 'shravan',
				},
				{
					prepareImage,
					createManagedVm,
				},
			),
		).rejects.toThrow(/must be a real directory/u);

		expect(prepareImage).toHaveBeenCalledOnce();
		expect(createManagedVm).not.toHaveBeenCalled();
	});

	it('closes the pinned workspace when post-acquisition revalidation fails', async () => {
		const systemConfig = await createToolVmSystemConfig();
		const standardProfile = systemConfig.toolVmProfiles.standard;
		if (!standardProfile) {
			throw new Error('Expected standard tool VM profile');
		}
		const requestedWorkMountDir = await createWorkMountDirectory(systemConfig, 'hermes-work-mount');
		let workspaceIdentityReadCount = 0;
		const closeOwnedDirectoryBacking = vi.fn();
		const createManagedVm = vi.fn();

		await expect(
			createToolVm(
				{
					agentId: 'sun',
					profile: standardProfile,
					secretResolver: createSecretResolver({}),
					systemConfig,
					tcpSlot: 0,
					hostWorkspaceRoot: requestedWorkMountDir,
					zoneId: 'shravan',
				},
				{
					prepareImage: async () => ({
						built: true,
						fingerprint: 'tool-fingerprint',
						imageReference: '/cache/tool-fingerprint',
					}),
					closeOwnedDirectoryBacking,
					createManagedVm,
					managedAgentRootMountDependencies: {
						readDirectoryIdentity: async (hostPath) => {
							const isGitDirectory = hostPath.includes('/gitdirs/');
							if (!isGitDirectory) {
								workspaceIdentityReadCount += 1;
							}
							return {
								canonicalPath:
									!isGitDirectory && workspaceIdentityReadCount === 2
										? `${hostPath}-stale`
										: hostPath,
								device: 1,
								inode: isGitDirectory ? 2 : 1,
							};
						},
					},
					openOwnedDirectoryBacking: createOwnedDirectoryBackingFixture,
				},
			),
		).rejects.toThrow(/stale canonical path/u);

		expect(closeOwnedDirectoryBacking).toHaveBeenCalledOnce();
		expect(createManagedVm).not.toHaveBeenCalled();
	});
});
