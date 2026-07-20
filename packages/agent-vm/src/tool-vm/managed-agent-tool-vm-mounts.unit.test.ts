import type {
	ManagedVm,
	ManagedVmCanonicalDirectoryIdentity,
	ManagedVmCreateRequest,
	ManagedVmFactory,
	ManagedVmFilteredWorkspacePolicy,
	ManagedVmOwnedDirectoryCapability,
	OwnedHostDirectory,
} from '@agent-vm/managed-vm';
import { createOwnedHostDirectoryController } from '@agent-vm/managed-vm';
import { describe, expect, it, vi } from 'vitest';

import { createManagedVmWithFilteredAgentWorkspace } from './managed-agent-tool-vm-mounts.js';

const WORKSPACE_POLICY = {
	hiddenPaths: ['.env'],
	readonlyInputs: [],
	temporaryPaths: ['node_modules'],
	visibility: { kind: 'whole-root-writable' },
} satisfies ManagedVmFilteredWorkspacePolicy;
const HOST_GIT_DIRECTORY_ROOT = '/host/runtime/zones/zone-a/gitdirs/agents/alpha';

function createManagedVm(): ManagedVm {
	return {
		close: vi.fn(async () => {}),
		configureIngressRoutes: vi.fn(),
		enableIngress: vi.fn(),
		enableSsh: vi.fn(),
		exec: vi.fn(),
		getHostProcessId: vi.fn(() => null),
		id: 'tool-vm-alpha',
		start: vi.fn(async () => {}),
	};
}

function createRequest(): Omit<ManagedVmCreateRequest, 'mounts'> {
	return {
		allowedHosts: [],
		environment: {},
		imageReference: 'tool-image',
		mediatedSecrets: [],
		resources: { cpuCount: 1, memory: '1GiB' },
		rootfsMode: 'cow',
		sessionLabel: 'tool-alpha',
		tcpHosts: [],
	};
}

function identityForPath(hostPath: string): ManagedVmCanonicalDirectoryIdentity {
	return {
		canonicalPath: hostPath,
		device: 1,
		inode: hostPath.includes('gitdirs') ? 12 : 11,
	};
}

function createOwnedDirectoryHarness(options?: { readonly stalePath?: string }): {
	readonly capability: ManagedVmOwnedDirectoryCapability;
	readonly closedPaths: string[];
	readonly openedPaths: string[];
	readonly readDirectoryIdentity: (
		hostPath: string,
	) => Promise<ManagedVmCanonicalDirectoryIdentity>;
} {
	const closedPaths: string[] = [];
	const openedPaths: string[] = [];
	return {
		capability: {
			openHostDirectory(hostPath: string): OwnedHostDirectory {
				openedPaths.push(hostPath);
				const canonicalPath = options?.stalePath === hostPath ? `${hostPath}-stale` : hostPath;
				return createOwnedHostDirectoryController({
					identity: { ...identityForPath(hostPath), canonicalPath },
					onClose: () => {
						closedPaths.push(hostPath);
					},
				});
			},
		},
		closedPaths,
		openedPaths,
		readDirectoryIdentity: async (hostPath) => identityForPath(hostPath),
	};
}

describe('managed agent Tool VM workspace mount', () => {
	it('transfers filtered workspace and writable Git directories while leaving /work in rootfs', async () => {
		const ownedDirectories = createOwnedDirectoryHarness();
		const toolVm = createManagedVm();
		let capturedRequest: ManagedVmCreateRequest | undefined;
		const factory: ManagedVmFactory = {
			async createManagedVm(request): Promise<ManagedVm> {
				capturedRequest = request;
				const workspaceMount = request.mounts['/workspace'];
				const gitDirectoriesMount = request.mounts['/gitdirs'];
				if (workspaceMount?.kind !== 'owned-filtered-workspace') {
					throw new Error('Expected filtered workspace mount.');
				}
				if (gitDirectoriesMount?.kind !== 'owned-host-directory') {
					throw new Error('Expected owned Git directories mount.');
				}
				workspaceMount.directory.consume();
				gitDirectoriesMount.directory.consume();
				return toolVm;
			},
		};

		await expect(
			createManagedVmWithFilteredAgentWorkspace(
				{
					factory,
					hostGitDirectoryRoot: '/host/runtime/zones/zone-a/gitdirs/agents/alpha',
					hostWorkspaceRoot: '/host/zone/agents/alpha',
					ownedDirectories: ownedDirectories.capability,
					request: createRequest(),
					workspacePolicy: WORKSPACE_POLICY,
				},
				{ readDirectoryIdentity: ownedDirectories.readDirectoryIdentity },
			),
		).resolves.toBe(toolVm);
		expect(capturedRequest?.mounts['/workspace']).toEqual({
			directory: expect.objectContaining({ state: 'adapter-owned' }),
			kind: 'owned-filtered-workspace',
			policy: WORKSPACE_POLICY,
		});
		expect(capturedRequest?.mounts['/gitdirs']).toEqual({
			access: 'read-write',
			directory: expect.objectContaining({ state: 'adapter-owned' }),
			kind: 'owned-host-directory',
		});
		expect(capturedRequest?.mounts).not.toHaveProperty('/work');
		expect(ownedDirectories.openedPaths).toEqual([
			'/host/zone/agents/alpha',
			'/host/runtime/zones/zone-a/gitdirs/agents/alpha',
		]);
		expect(ownedDirectories.closedPaths).toEqual([]);
	});

	it('transfers exactly one filtered workspace at /workspace and leaves /work in rootfs', async () => {
		const ownedDirectories = createOwnedDirectoryHarness();
		const toolVm = createManagedVm();
		let capturedRequest: ManagedVmCreateRequest | undefined;
		const factory: ManagedVmFactory = {
			async createManagedVm(request): Promise<ManagedVm> {
				capturedRequest = request;
				const workspaceMount = request.mounts['/workspace'];
				const gitDirectoriesMount = request.mounts['/gitdirs'];
				if (workspaceMount?.kind !== 'owned-filtered-workspace') {
					throw new Error('Expected one filtered workspace mount.');
				}
				if (gitDirectoriesMount?.kind !== 'owned-host-directory') {
					throw new Error('Expected owned Git directories mount.');
				}
				workspaceMount.directory.consume();
				gitDirectoriesMount.directory.consume();
				return toolVm;
			},
		};

		await expect(
			createManagedVmWithFilteredAgentWorkspace(
				{
					factory,
					hostGitDirectoryRoot: HOST_GIT_DIRECTORY_ROOT,
					hostWorkspaceRoot: '/host/zone/agents/alpha',
					ownedDirectories: ownedDirectories.capability,
					request: createRequest(),
					workspacePolicy: WORKSPACE_POLICY,
				},
				{ readDirectoryIdentity: ownedDirectories.readDirectoryIdentity },
			),
		).resolves.toBe(toolVm);
		expect(capturedRequest?.mounts['/workspace']).toEqual({
			directory: expect.objectContaining({ state: 'adapter-owned' }),
			kind: 'owned-filtered-workspace',
			policy: WORKSPACE_POLICY,
		});
		expect(capturedRequest?.mounts).not.toHaveProperty('/work');
		expect(capturedRequest?.mounts).not.toHaveProperty('/agent');
		expect(ownedDirectories.openedPaths).toEqual([
			'/host/zone/agents/alpha',
			HOST_GIT_DIRECTORY_ROOT,
		]);
		expect(ownedDirectories.closedPaths).toEqual([]);
	});

	it('closes the VM and workspace when the provider does not consume ownership', async () => {
		const ownedDirectories = createOwnedDirectoryHarness();
		const toolVm = createManagedVm();
		const closeToolVm = vi.spyOn(toolVm, 'close');
		const factory: ManagedVmFactory = {
			async createManagedVm(): Promise<ManagedVm> {
				return toolVm;
			},
		};

		await expect(
			createManagedVmWithFilteredAgentWorkspace(
				{
					factory,
					hostGitDirectoryRoot: HOST_GIT_DIRECTORY_ROOT,
					hostWorkspaceRoot: '/host/zone/agents/alpha',
					ownedDirectories: ownedDirectories.capability,
					request: createRequest(),
					workspacePolicy: WORKSPACE_POLICY,
				},
				{ readDirectoryIdentity: ownedDirectories.readDirectoryIdentity },
			),
		).rejects.toThrow(/must transfer the managed agent workspace/u);
		expect(closeToolVm).toHaveBeenCalledOnce();
		expect(ownedDirectories.closedPaths).toEqual([
			'/host/zone/agents/alpha',
			HOST_GIT_DIRECTORY_ROOT,
		]);
	});

	it('retains the workspace capability when an invalid provider returns a live runner without consuming it', async () => {
		const ownedDirectories = createOwnedDirectoryHarness();
		const toolVm = createManagedVm();
		vi.spyOn(toolVm, 'getHostProcessId').mockReturnValue(4242);
		const closeToolVm = vi.spyOn(toolVm, 'close');
		const factory: ManagedVmFactory = {
			async createManagedVm(): Promise<ManagedVm> {
				return toolVm;
			},
		};

		await expect(
			createManagedVmWithFilteredAgentWorkspace(
				{
					factory,
					hostGitDirectoryRoot: HOST_GIT_DIRECTORY_ROOT,
					hostWorkspaceRoot: '/host/zone/agents/alpha',
					ownedDirectories: ownedDirectories.capability,
					request: createRequest(),
					workspacePolicy: WORKSPACE_POLICY,
				},
				{ readDirectoryIdentity: ownedDirectories.readDirectoryIdentity },
			),
		).rejects.toThrow(/live runner.*without captured process identity/u);
		expect(closeToolVm).not.toHaveBeenCalled();
		expect(ownedDirectories.closedPaths).toEqual([]);
	});

	it('closes the workspace when post-acquisition identity validation is stale', async () => {
		const workspaceRoot = '/host/zone/agents/alpha';
		const ownedDirectories = createOwnedDirectoryHarness({ stalePath: workspaceRoot });
		const factory = { createManagedVm: vi.fn() } satisfies ManagedVmFactory;

		await expect(
			createManagedVmWithFilteredAgentWorkspace(
				{
					factory,
					hostGitDirectoryRoot: HOST_GIT_DIRECTORY_ROOT,
					hostWorkspaceRoot: workspaceRoot,
					ownedDirectories: ownedDirectories.capability,
					request: createRequest(),
					workspacePolicy: WORKSPACE_POLICY,
				},
				{ readDirectoryIdentity: ownedDirectories.readDirectoryIdentity },
			),
		).rejects.toThrow(/canonical path/u);
		expect(factory.createManagedVm).not.toHaveBeenCalled();
		expect(ownedDirectories.closedPaths).toEqual([workspaceRoot, HOST_GIT_DIRECTORY_ROOT]);
	});

	it('contains provider rejection after ownership transfer through provider cleanup', async () => {
		const ownedDirectories = createOwnedDirectoryHarness();
		const factory: ManagedVmFactory = {
			async createManagedVm(request): Promise<ManagedVm> {
				const workspaceMount = request.mounts['/workspace'];
				if (workspaceMount?.kind !== 'owned-filtered-workspace') {
					throw new Error('Expected managed workspace mount.');
				}
				workspaceMount.directory.consume().close();
				throw new Error('provider rejected mount transaction');
			},
		};

		await expect(
			createManagedVmWithFilteredAgentWorkspace(
				{
					factory,
					hostGitDirectoryRoot: HOST_GIT_DIRECTORY_ROOT,
					hostWorkspaceRoot: '/host/zone/agents/alpha',
					ownedDirectories: ownedDirectories.capability,
					request: createRequest(),
					workspacePolicy: WORKSPACE_POLICY,
				},
				{ readDirectoryIdentity: ownedDirectories.readDirectoryIdentity },
			),
		).rejects.toThrow('provider rejected mount transaction');
		expect(ownedDirectories.closedPaths).toEqual([
			'/host/zone/agents/alpha',
			HOST_GIT_DIRECTORY_ROOT,
		]);
	});

	it('mounts managed skills only at the fixed read-only guest path', async () => {
		const ownedDirectories = createOwnedDirectoryHarness();
		let capturedRequest: ManagedVmCreateRequest | undefined;
		const factory: ManagedVmFactory = {
			async createManagedVm(request): Promise<ManagedVm> {
				capturedRequest = request;
				const workspaceMount = request.mounts['/workspace'];
				const gitDirectoriesMount = request.mounts['/gitdirs'];
				if (workspaceMount?.kind === 'owned-filtered-workspace') {
					workspaceMount.directory.consume();
				}
				if (gitDirectoriesMount?.kind === 'owned-host-directory') {
					gitDirectoriesMount.directory.consume();
				}
				return createManagedVm();
			},
		};

		await createManagedVmWithFilteredAgentWorkspace(
			{
				factory,
				hostGitDirectoryRoot: HOST_GIT_DIRECTORY_ROOT,
				hostWorkspaceRoot: '/host/zone/agents/alpha',
				managedSkillsHostPath: '/host/managed-skills',
				ownedDirectories: ownedDirectories.capability,
				request: createRequest(),
				workspacePolicy: WORKSPACE_POLICY,
			},
			{ readDirectoryIdentity: ownedDirectories.readDirectoryIdentity },
		);

		expect(capturedRequest?.mounts['/agent-vm/managed-skills']).toEqual({
			access: 'read-only',
			hostPath: '/host/managed-skills',
			kind: 'host-directory',
		});
		expect(Object.keys(capturedRequest?.mounts ?? {}).toSorted()).toEqual([
			'/agent-vm/managed-skills',
			'/gitdirs',
			'/workspace',
		]);
	});

	it('rejects retired arbitrary supplemental-mount APIs', async () => {
		const ownedDirectories = createOwnedDirectoryHarness();
		const factory = { createManagedVm: vi.fn() } satisfies ManagedVmFactory;
		const baseOptions = {
			factory,
			hostGitDirectoryRoot: HOST_GIT_DIRECTORY_ROOT,
			hostWorkspaceRoot: '/host/zone/agents/alpha',
			ownedDirectories: ownedDirectories.capability,
			request: createRequest(),
			workspacePolicy: WORKSPACE_POLICY,
		};

		for (const unsupportedOptions of [
			{
				reviewedReadOnlyMounts: {
					'/zone': {
						access: 'read-only',
						hostPath: '/host/zone',
						kind: 'host-directory',
					},
				},
			},
			{
				managedSkillsMount: {
					access: 'read-write',
					hostPath: '/host/managed-skills',
					kind: 'host-directory',
				},
			},
		]) {
			// oxlint-disable-next-line no-await-in-loop -- each retired API shape is an independent fail-closed assertion.
			await expect(
				createManagedVmWithFilteredAgentWorkspace(
					{
						...baseOptions,
						...unsupportedOptions,
					} as unknown as Parameters<typeof createManagedVmWithFilteredAgentWorkspace>[0],
					{ readDirectoryIdentity: ownedDirectories.readDirectoryIdentity },
				),
			).rejects.toThrow(/unsupported option/u);
		}
		await expect(
			createManagedVmWithFilteredAgentWorkspace(
				{
					...baseOptions,
					request: {
						...createRequest(),
						mounts: {
							'/zone': {
								access: 'read-only',
								hostPath: '/host/zone',
								kind: 'host-directory',
							},
						},
					} as unknown as Omit<ManagedVmCreateRequest, 'mounts'>,
				},
				{ readDirectoryIdentity: ownedDirectories.readDirectoryIdentity },
			),
		).rejects.toThrow(/must not provide additional mounts/u);
		expect(factory.createManagedVm).not.toHaveBeenCalled();
	});

	it('rejects a relative managed-skills host source before acquiring workspace authority', async () => {
		const ownedDirectories = createOwnedDirectoryHarness();
		const factory = { createManagedVm: vi.fn() } satisfies ManagedVmFactory;

		await expect(
			createManagedVmWithFilteredAgentWorkspace(
				{
					factory,
					hostGitDirectoryRoot: HOST_GIT_DIRECTORY_ROOT,
					hostWorkspaceRoot: '/host/zone/agents/alpha',
					managedSkillsHostPath: 'managed-skills',
					ownedDirectories: ownedDirectories.capability,
					request: createRequest(),
					workspacePolicy: WORKSPACE_POLICY,
				},
				{ readDirectoryIdentity: ownedDirectories.readDirectoryIdentity },
			),
		).rejects.toThrow(/managed skills host path must be absolute/iu);
		expect(factory.createManagedVm).not.toHaveBeenCalled();
		expect(ownedDirectories.openedPaths).toEqual([]);
		expect(ownedDirectories.closedPaths).toEqual([]);
	});
});
