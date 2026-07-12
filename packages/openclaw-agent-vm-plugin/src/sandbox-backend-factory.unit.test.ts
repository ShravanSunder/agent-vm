import {
	isToolVmLeaseId,
	parseToolVmLeaseId,
	type ToolVmLeaseId,
} from '@agent-vm/gateway-lifecycle';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	ControllerLeaseRequestError,
	type LeaseClient,
	type OpenClawAgentVmLeaseReacquireRequest,
} from './lease-client-contract.js';
import {
	createAgentVmSandboxBackendFactory,
	createAgentVmSandboxBackendManager,
	type OpenClawFsBridgeLeaseContext,
	type OpenClawSandboxFsBridge,
} from './sandbox-backend-factory.js';

const OPENCLAW_TOOL_VM_WORKSPACE_MOUNT = '/workspace';
const testLeaseIdByLabel = new Map<string, ToolVmLeaseId>();

function testToolVmLeaseId(label: string): ToolVmLeaseId {
	if (isToolVmLeaseId(label)) {
		return label;
	}
	const existingLeaseId = testLeaseIdByLabel.get(label);
	if (existingLeaseId) {
		return existingLeaseId;
	}
	const leaseId = `01890f00-0000-7000-8000-${String(testLeaseIdByLabel.size + 1).padStart(12, '0')}`;
	const parsedLeaseId = parseToolVmLeaseId(leaseId);
	testLeaseIdByLabel.set(label, parsedLeaseId);
	return parsedLeaseId;
}

function createLeaseResponse(
	leaseId: string,
	options: {
		readonly agentId?: string;
		readonly idleTtlMs?: number;
	} = {},
): {
	readonly agentId: string;
	readonly idleTtlMs: number;
	readonly leaseId: ToolVmLeaseId;
	readonly ssh: {
		readonly host: string;
		readonly identityPem: string;
		readonly knownHostsLine: string;
		readonly port: number;
		readonly user: string;
	};
	readonly tcpSlot: number;
	readonly transport: 'ssh-sandbox';
	readonly workdir: string;
} {
	const normalizedLeaseId = testToolVmLeaseId(leaseId);
	return {
		agentId: options.agentId ?? 'main',
		idleTtlMs: options.idleTtlMs ?? 6_000_000,
		leaseId: normalizedLeaseId,
		ssh: {
			host: 'tool-0.vm.host',
			identityPem: 'pem',
			knownHostsLine: 'known-hosts',
			port: 22,
			user: 'sandbox',
		},
		tcpSlot: 0,
		transport: 'ssh-sandbox' as const,
		workdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
	};
}

function createLeasePeekResponse(leaseId: string = 'lease-123'): {
	readonly agentId: string;
	readonly createdAt: number;
	readonly idleTtlMs: number;
	readonly lastUsedAt: number;
	readonly leaseId: ToolVmLeaseId;
	readonly profileId: string;
	readonly ssh: { readonly host: string; readonly port: number; readonly user: string };
	readonly tcpSlot: number;
	readonly transport: 'ssh-sandbox';
	readonly workdir: string;
	readonly zoneId: string;
} {
	const normalizedLeaseId = testToolVmLeaseId(leaseId);
	return {
		agentId: 'main',
		createdAt: 1,
		idleTtlMs: 6_000_000,
		lastUsedAt: 1,
		leaseId: normalizedLeaseId,
		profileId: 'standard',
		ssh: { host: 'tool-0.vm.host', port: 22, user: 'sandbox' },
		tcpSlot: 0,
		transport: 'ssh-sandbox' as const,
		workdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
		zoneId: 'shravan',
	};
}

function createMockFsBridge(): OpenClawSandboxFsBridge {
	return {
		mkdirp: vi.fn(async () => {}),
		readFile: vi.fn(async () => Buffer.from('file-content')),
		remove: vi.fn(async () => {}),
		rename: vi.fn(async () => {}),
		resolvePath: vi.fn(() => ({
			containerPath: `${OPENCLAW_TOOL_VM_WORKSPACE_MOUNT}/file.txt`,
			relativePath: 'file.txt',
		})),
		stat: vi.fn(async () => ({ mtimeMs: 1000, size: 42, type: 'file' as const })),
		writeFile: vi.fn(async () => {}),
	};
}

function createControllerLeaseError(status: number): ControllerLeaseRequestError {
	return new ControllerLeaseRequestError({
		bodyText: JSON.stringify({ error: 'lease-error' }),
		context: 'Controller lease renew API',
		responseBody: { error: 'lease-error' },
		status,
	});
}

function createActiveUseLeaseClientMethods(): Pick<
	LeaseClient,
	'startActiveUse' | 'heartbeatActiveUse' | 'endActiveUse' | 'reacquireLease'
> {
	return {
		endActiveUse: vi.fn(async () => {}),
		heartbeatActiveUse: vi.fn(async () => ({
			expiresAt: 2_000,
			heartbeatAfterMs: 1_000,
		})),
		reacquireLease: vi.fn(async (oldLeaseId) => createLeaseResponse(`${oldLeaseId}-reacquired`)),
		startActiveUse: vi.fn(async (_leaseId, request) => ({
			useId: request.useId,
			expiresAt: 2_000,
			heartbeatAfterMs: 1_000,
		})),
	};
}

function createFactoryParamsForAgent(agentId: string): {
	readonly agentWorkspaceDir: string;
	readonly cfg: ReturnType<typeof agentVmSandboxConfig>;
	readonly scopeKey: string;
	readonly sessionKey: string;
	readonly workspaceDir: string;
} {
	return {
		agentWorkspaceDir: `/zone/agents/${agentId}`,
		cfg: agentVmSandboxConfig(),
		scopeKey: `agent:${agentId}:discord:channel:123`,
		sessionKey: `agent:${agentId}:discord:channel:123`,
		workspaceDir: `/zone/agents/${agentId}`,
	};
}

function agentVmSandboxConfig(
	overrides: Partial<{
		readonly backend: unknown;
		readonly mode: unknown;
		readonly scope: unknown;
		readonly workspaceAccess: unknown;
	}> = {},
): {
	readonly backend: unknown;
	readonly mode: unknown;
	readonly scope: unknown;
	readonly workspaceAccess: unknown;
} {
	return {
		backend: 'gondolin',
		mode: 'all',
		scope: 'agent',
		workspaceAccess: 'rw',
		...overrides,
	};
}

beforeEach(() => {
	vi.stubGlobal(
		'fetch',
		vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true }))),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('createAgentVmSandboxBackendFactory', () => {
	it('rejects unsupported OpenClaw sandbox config before requesting a lease', async () => {
		const requestLease = vi.fn(async () => createLeaseResponse('lease-123'));
		const factory = createAgentVmSandboxBackendFactory(
			{
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId: 'shravan',
			},
			{
				buildExecSpec: vi.fn(async () => ({
					argv: ['ssh'],
					env: {},
					stdinMode: 'pipe-open' as const,
				})),
				createLeaseClient: () => ({
					...createActiveUseLeaseClientMethods(),
					renewLease: async () => createLeaseResponse('lease-reuse'),
					peekLease: async () => createLeasePeekResponse(),
					releaseLease: async () => {},
					requestLease,
				}),
				runRemoteShellScript: vi.fn(),
			},
		);

		await expect(
			factory({
				agentWorkspaceDir: '/zone/agents/main',
				cfg: agentVmSandboxConfig({ scope: 'session' }),
				scopeKey: 'agent:main',
				sessionKey: 'agent:main:session-abc',
				workspaceDir: '/work',
			}),
		).rejects.toThrow('OpenClaw Gondolin sandbox requires scope=agent; received session.');
		expect(requestLease).not.toHaveBeenCalled();
	});

	it('passes arbitrary scope provenance under the resolved OpenClaw agent', async () => {
		const requestLease = vi.fn(async (_request: Parameters<LeaseClient['requestLease']>[0]) =>
			createLeaseResponse('shravan-main-100', {
				agentId: 'main',
			}),
		);
		const factory = createAgentVmSandboxBackendFactory(
			{
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId: 'shravan',
			},
			{
				buildExecSpec: vi.fn(async () => ({
					argv: ['ssh'],
					env: {},
					stdinMode: 'pipe-open' as const,
				})),
				createLeaseClient: () => ({
					...createActiveUseLeaseClientMethods(),
					renewLease: async () => createLeaseResponse('lease-reuse'),
					peekLease: async () => createLeasePeekResponse(),
					releaseLease: async () => {},
					requestLease,
				}),
				runRemoteShellScript: vi.fn(),
			},
		);

		await factory({
			agentWorkspaceDir: '/zone/agents/main',
			cfg: agentVmSandboxConfig(),
			scopeKey: 'agent:beta',
			sessionKey: 'agent:main:session-abc',
			workspaceDir: '/work',
		});

		expect(requestLease).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: 'main',
				sessionKey: 'agent:main:session-abc',
			}),
		);
		expect(requestLease.mock.calls[0]?.[0]).not.toHaveProperty('scopeKey');
	});

	it('requests a lease and exposes an ssh-backed sandbox handle with fs bridge', async () => {
		const requestLease = vi.fn(async () => createLeaseResponse('lease-123'));
		const publishOpenClawRuntimeStatus = vi.fn(async () => {});
		const runRemoteShellScript = vi.fn(async () => ({
			code: 0,
			stderr: Buffer.from(''),
			stdout: Buffer.from('ok'),
		}));
		const mockBridge = createMockFsBridge();
		const createFsBridgeBuilder = vi.fn((_leaseContext: OpenClawFsBridgeLeaseContext) =>
			vi.fn((_params: { readonly sandbox: unknown }) => mockBridge),
		);
		const buildExecSpec = vi.fn(async () => ({
			argv: ['ssh', 'tool-0.vm.host'],
			env: {},
			stdinMode: 'pipe-open' as const,
		}));

		const factory = createAgentVmSandboxBackendFactory(
			{
				controllerUrl: 'http://controller.vm.host:18800',
				openClawRuntimeStatusProvider: () => ({
					pluginId: 'gondolin',
					zoneId: 'shravan',
					findings: [
						{
							id: 'openclaw-tool-vm-agents-defaults-sandbox-backend-shravan-defaults',
							ok: true,
							hint: 'agents.defaults.sandbox.backend=gondolin',
						},
					],
				}),
				profileId: 'gpu',
				zoneId: 'shravan',
			},
			{
				buildExecSpec,
				createFsBridgeBuilder,
				createLeaseClient: () => ({
					...createActiveUseLeaseClientMethods(),
					renewLease: async () => createLeaseResponse('lease-renew'),
					peekLease: async () => createLeasePeekResponse(),
					releaseLease: async () => {},
					requestLease,
				}),
				publishOpenClawRuntimeStatus,
				runRemoteShellScript,
			},
		);

		const backend = await factory({
			agentWorkspaceDir: '/home/openclaw/work',
			cfg: {
				...agentVmSandboxConfig(),
				docker: {
					env: {
						OPENCLAW_LOG_LEVEL: 'debug',
					},
				},
			},
			scopeKey: 'agent:main',
			sessionKey: 'agent:main:session-abc',
			workspaceDir: '/home/openclaw/.openclaw/state/sandboxes/work',
		});

		const execSpec = await backend.buildExecSpec({
			command: 'ls -la',
			env: {
				TEST_ENV: '1',
			},
			usePty: false,
			workdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
		});
		const commandResult = await backend.runShellCommand({
			script: 'pwd',
		});
		await backend.finalizeExec?.({
			status: 'completed',
			exitCode: 0,
			timedOut: false,
			token: execSpec.finalizeToken,
		});

		expect(requestLease).toHaveBeenCalledWith({
			agentId: 'main',
			agentWorkspaceDir: '/home/openclaw/work',
			profileId: 'gpu',
			sessionKey: 'agent:main:session-abc',
			workMountDir: '/home/openclaw/.openclaw/state/sandboxes/work',
			zoneId: 'shravan',
		});
		expect(publishOpenClawRuntimeStatus).toHaveBeenCalledTimes(1);
		expect(publishOpenClawRuntimeStatus.mock.invocationCallOrder[0]).toBeLessThan(
			requestLease.mock.invocationCallOrder[0] ?? 0,
		);
		expect(buildExecSpec).toHaveBeenCalledWith({
			command: 'ls -la',
			env: {
				TEST_ENV: '1',
			},
			ssh: {
				host: 'tool-0.vm.host',
				identityPem: 'pem',
				knownHostsLine: 'known-hosts',
				port: 22,
				user: 'sandbox',
			},
			usePty: false,
			workdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
		});
		expect(execSpec.argv).toEqual(['ssh', 'tool-0.vm.host']);
		expect(commandResult.code).toBe(0);

		// Verify createFsBridgeBuilder was called with lease context
		expect(createFsBridgeBuilder).toHaveBeenCalledWith(
			expect.objectContaining({
				remoteWorkspaceDir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
				remoteAgentWorkspaceDir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			}),
		);
		// Verify the lease context includes a runRemoteShellScript bound to lease SSH
		const leaseContext = createFsBridgeBuilder.mock.calls[0]?.[0] as OpenClawFsBridgeLeaseContext;
		expect(typeof leaseContext.runRemoteShellScript).toBe('function');

		// Verify createFsBridge on the handle delegates to the builder
		expect(backend.createFsBridge).toBeDefined();
		const bridge = backend.createFsBridge?.({ sandbox: { id: 'sandbox' } });
		expect(bridge).toBe(mockBridge);

		expect(backend.runtimeId).toBe(testToolVmLeaseId('lease-123'));
		expect(backend.runtimeLabel).toBe(testToolVmLeaseId('lease-123'));
		expect(backend.configLabel).toBe('http://controller.vm.host:18800 (shravan)');
		expect(backend.configLabelKind).toBe('VM');
		expect(typeof backend.finalizeExec).toBe('function');
	});

	it('normalizes /workspace subpaths before requesting a controller lease', async () => {
		const requestLease = vi.fn(async (_request: Parameters<LeaseClient['requestLease']>[0]) =>
			createLeaseResponse('lease-workspace-subpath'),
		);

		const factory = createAgentVmSandboxBackendFactory(
			{
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId: 'shravan',
			},
			{
				buildExecSpec: vi.fn(async () => ({
					argv: ['ssh'],
					env: {},
					stdinMode: 'pipe-open' as const,
				})),
				createLeaseClient: () => ({
					...createActiveUseLeaseClientMethods(),
					renewLease: async (leaseId: string) => createLeaseResponse(leaseId),
					peekLease: async () => createLeasePeekResponse(),
					releaseLease: async () => {},
					requestLease,
				}),
				runRemoteShellScript: vi.fn(),
			},
		);

		const handle = await factory({
			agentWorkspaceDir: '/zone/agents/beta',
			cfg: agentVmSandboxConfig(),
			scopeKey: 'agent:beta:subagent:child',
			sessionKey: 'agent:beta:subagent:child',
			workspaceDir: '/workspace/app',
		});

		expect(handle.workdir).toBe('/workspace/app');
		expect(requestLease).toHaveBeenCalledWith({
			agentId: 'beta',
			agentWorkspaceDir: '/zone/agents/beta',
			profileId: 'standard',
			sessionKey: 'agent:beta:subagent:child',
			workMountDir: '/zone/agents/beta',
			zoneId: 'shravan',
		});
		expect(requestLease.mock.calls[0]?.[0]).not.toHaveProperty('scopeKey');
		expect(requestLease.mock.calls[0]?.[0]).not.toHaveProperty('sandbox');
		expect(requestLease.mock.calls[0]?.[0]).not.toHaveProperty('workspaceDir');
	});

	it('canonicalizes leaked /workspace agentWorkspaceDir before requesting a controller lease', async () => {
		const requestLease = vi.fn(async (_request: Parameters<LeaseClient['requestLease']>[0]) =>
			createLeaseResponse('lease-leaked-workspace', {
				agentId: 'beta',
			}),
		);

		const factory = createAgentVmSandboxBackendFactory(
			{
				controllerUrl: 'http://controller.vm.host:18800',
				openClawDefaultWorkspaceDirProvider: () => '/home/openclaw/.openclaw/workspace',
				openClawRuntimeConfigProvider: () => ({
					agents: { list: [{ id: 'beta', workspace: '/zone/agents/beta' }] },
				}),
				openClawStateDirProvider: () => '/home/openclaw/.openclaw/state',
				zoneId: 'shravan',
			},
			{
				buildExecSpec: vi.fn(async () => ({
					argv: ['ssh'],
					env: {},
					stdinMode: 'pipe-open' as const,
				})),
				createLeaseClient: () => ({
					...createActiveUseLeaseClientMethods(),
					renewLease: async (leaseId: string) => createLeaseResponse(leaseId),
					peekLease: async () => createLeasePeekResponse(),
					releaseLease: async () => {},
					requestLease,
				}),
				runRemoteShellScript: vi.fn(),
			},
		);

		const handle = await factory({
			agentWorkspaceDir: '/workspace',
			cfg: agentVmSandboxConfig(),
			scopeKey: 'agent:beta:subagent:child',
			sessionKey: 'agent:beta:subagent:child',
			workspaceDir: '/workspace',
		});

		expect(handle.workdir).toBe('/workspace');
		expect(requestLease).toHaveBeenCalledWith({
			agentId: 'beta',
			agentWorkspaceDir: '/zone/agents/beta',
			profileId: 'standard',
			sessionKey: 'agent:beta:subagent:child',
			workMountDir: '/zone/agents/beta',
			zoneId: 'shravan',
		});
	});

	it('canonicalizes leaked OpenClaw default workspace agentWorkspaceDir before requesting a controller lease', async () => {
		const requestLease = vi.fn(async (_request: Parameters<LeaseClient['requestLease']>[0]) =>
			createLeaseResponse('lease-leaked-default-workspace', {
				agentId: 'beta',
			}),
		);

		const factory = createAgentVmSandboxBackendFactory(
			{
				controllerUrl: 'http://controller.vm.host:18800',
				openClawDefaultWorkspaceDirProvider: () => '/home/openclaw/.openclaw/workspace',
				openClawRuntimeConfigProvider: () => ({
					agents: { list: [{ id: 'beta', workspace: '/zone/agents/beta' }] },
				}),
				openClawStateDirProvider: () => '/home/openclaw/.openclaw/state',
				zoneId: 'shravan',
			},
			{
				buildExecSpec: vi.fn(async () => ({
					argv: ['ssh'],
					env: {},
					stdinMode: 'pipe-open' as const,
				})),
				createLeaseClient: () => ({
					...createActiveUseLeaseClientMethods(),
					renewLease: async (leaseId: string) => createLeaseResponse(leaseId),
					peekLease: async () => createLeasePeekResponse(),
					releaseLease: async () => {},
					requestLease,
				}),
				runRemoteShellScript: vi.fn(),
			},
		);

		const handle = await factory({
			agentWorkspaceDir: '/home/openclaw/.openclaw/workspace',
			cfg: agentVmSandboxConfig(),
			scopeKey: 'agent:beta:subagent:child',
			sessionKey: 'agent:beta:subagent:child',
			workspaceDir: '/home/openclaw/.openclaw/workspace',
		});

		expect(handle.workdir).toBe('/workspace');
		expect(requestLease).toHaveBeenCalledWith({
			agentId: 'beta',
			agentWorkspaceDir: '/zone/agents/beta',
			profileId: 'standard',
			sessionKey: 'agent:beta:subagent:child',
			workMountDir: '/zone/agents/beta',
			zoneId: 'shravan',
		});
	});

	it('uses the built-in OpenClaw state root fallback when default workspace leaks without explicit config', async () => {
		const requestLease = vi.fn(async (_request: Parameters<LeaseClient['requestLease']>[0]) =>
			createLeaseResponse('lease-default-workspace-fallback', {
				agentId: 'beta',
			}),
		);
		vi.stubEnv('HOME', '/home/openclaw');

		try {
			const factory = createAgentVmSandboxBackendFactory(
				{
					controllerUrl: 'http://controller.vm.host:18800',
					openClawRuntimeConfigProvider: () => ({
						agents: { list: [{ id: 'primary', default: true }, { id: 'beta' }] },
					}),
					zoneId: 'shravan',
				},
				{
					buildExecSpec: vi.fn(async () => ({
						argv: ['ssh'],
						env: {},
						stdinMode: 'pipe-open' as const,
					})),
					createLeaseClient: () => ({
						...createActiveUseLeaseClientMethods(),
						renewLease: async (leaseId: string) => createLeaseResponse(leaseId),
						peekLease: async () => createLeasePeekResponse(),
						releaseLease: async () => {},
						requestLease,
					}),
					runRemoteShellScript: vi.fn(),
				},
			);

			const handle = await factory({
				agentWorkspaceDir: '/home/openclaw/.openclaw/workspace',
				cfg: agentVmSandboxConfig(),
				scopeKey: 'agent:beta:subagent:child',
				sessionKey: 'agent:beta:subagent:child',
				workspaceDir: '/home/openclaw/.openclaw/workspace',
			});

			expect(handle.workdir).toBe('/workspace');
			expect(requestLease).toHaveBeenCalledWith({
				agentId: 'beta',
				agentWorkspaceDir: '/home/openclaw/.openclaw/state/workspace-beta',
				profileId: 'standard',
				sessionKey: 'agent:beta:subagent:child',
				workMountDir: '/home/openclaw/.openclaw/state/workspace-beta',
				zoneId: 'shravan',
			});
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it('rejects configured base implicit workspace when the active OpenClaw profile is non-default', async () => {
		const requestLease = vi.fn(async (_request: Parameters<LeaseClient['requestLease']>[0]) =>
			createLeaseResponse('lease-profile-poison', {
				agentId: 'beta',
			}),
		);
		vi.stubEnv('HOME', '/home/openclaw');
		vi.stubEnv('OPENCLAW_PROFILE', 'beta');

		try {
			const factory = createAgentVmSandboxBackendFactory(
				{
					controllerUrl: 'http://controller.vm.host:18800',
					openClawRuntimeConfigProvider: () => ({
						agents: {
							list: [
								{
									id: 'beta',
									workspace: '/home/openclaw/.openclaw/workspace',
								},
							],
						},
					}),
					zoneId: 'shravan',
				},
				{
					buildExecSpec: vi.fn(async () => ({
						argv: ['ssh'],
						env: {},
						stdinMode: 'pipe-open' as const,
					})),
					createLeaseClient: () => ({
						...createActiveUseLeaseClientMethods(),
						renewLease: async (leaseId: string) => createLeaseResponse(leaseId),
						peekLease: async () => createLeasePeekResponse(),
						releaseLease: async () => {},
						requestLease,
					}),
					runRemoteShellScript: vi.fn(),
				},
			);

			await expect(
				factory({
					agentWorkspaceDir: '/workspace',
					cfg: agentVmSandboxConfig(),
					scopeKey: 'agent:beta:subagent:child',
					sessionKey: 'agent:beta:subagent:child',
					workspaceDir: '/workspace',
				}),
			).rejects.toThrow(/controller lease-backed OpenClaw\/Gondolin source path/u);
			expect(requestLease).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it('canonicalizes leaked sandbox agentWorkspaceDir before cache compatibility', async () => {
		const requestLease = vi.fn(async (_request: Parameters<LeaseClient['requestLease']>[0]) =>
			createLeaseResponse('lease-leaked-sandbox', {
				agentId: 'beta',
			}),
		);

		const factory = createAgentVmSandboxBackendFactory(
			{
				controllerUrl: 'http://controller.vm.host:18800',
				openClawDefaultWorkspaceDirProvider: () => '/home/openclaw/.openclaw/workspace',
				openClawRuntimeConfigProvider: () => ({
					agents: { list: [{ id: 'beta', workspace: '/zone/agents/beta' }] },
				}),
				openClawStateDirProvider: () => '/home/openclaw/.openclaw/state',
				zoneId: 'shravan',
			},
			{
				buildExecSpec: vi.fn(async () => ({
					argv: ['ssh'],
					env: {},
					stdinMode: 'pipe-open' as const,
				})),
				createLeaseClient: () => ({
					...createActiveUseLeaseClientMethods(),
					renewLease: async (leaseId: string) => createLeaseResponse(leaseId),
					peekLease: async () => createLeasePeekResponse(),
					releaseLease: async () => {},
					requestLease,
				}),
				runRemoteShellScript: vi.fn(),
			},
		);

		const handle = await factory({
			agentWorkspaceDir: '/home/openclaw/.openclaw/state/sandboxes/child-123/work',
			cfg: agentVmSandboxConfig(),
			scopeKey: 'agent:beta:subagent:child',
			sessionKey: 'agent:beta:subagent:child',
			workspaceDir: '/home/openclaw/.openclaw/state/sandboxes/child-123/work/project',
		});

		expect(handle.workdir).toBe('/workspace/work/project');
		expect(requestLease).toHaveBeenCalledWith({
			agentId: 'beta',
			agentWorkspaceDir: '/zone/agents/beta',
			profileId: 'standard',
			sessionKey: 'agent:beta:subagent:child',
			workMountDir: '/home/openclaw/.openclaw/state/sandboxes/child-123',
			zoneId: 'shravan',
		});
	});

	it('reuses one cached lease while rebuilding handles for different cwd intents', async () => {
		const requestLease = vi.fn(async () =>
			createLeaseResponse('lease-cwd-intent', {
				agentId: 'beta',
			}),
		);
		const renewLease = vi.fn(async (leaseId: string) =>
			createLeaseResponse(leaseId, {
				agentId: 'beta',
			}),
		);
		const buildExecSpec = vi.fn(async () => ({
			argv: ['ssh'],
			env: {},
			stdinMode: 'pipe-open' as const,
		}));

		const factory = createAgentVmSandboxBackendFactory(
			{
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId: 'shravan',
			},
			{
				buildExecSpec,
				createLeaseClient: () => ({
					...createActiveUseLeaseClientMethods(),
					renewLease,
					peekLease: async () => createLeasePeekResponse(),
					releaseLease: async () => {},
					requestLease,
				}),
				runRemoteShellScript: vi.fn(async () => ({
					code: 0,
					stderr: Buffer.alloc(0),
					stdout: Buffer.alloc(0),
				})),
			},
		);

		const firstHandle = await factory({
			agentWorkspaceDir: '/zone/agents/beta',
			cfg: agentVmSandboxConfig(),
			scopeKey: 'agent:beta:discord:channel:123',
			sessionKey: 'agent:beta:discord:channel:123',
			workspaceDir: '/workspace/app',
		});
		const secondHandle = await factory({
			agentWorkspaceDir: '/zone/agents/beta',
			cfg: agentVmSandboxConfig(),
			scopeKey: 'agent:beta:subagent:child',
			sessionKey: 'agent:beta:subagent:child',
			workspaceDir: '/work/tmp',
		});

		expect(secondHandle).not.toBe(firstHandle);
		expect(firstHandle.runtimeId).toBe(secondHandle.runtimeId);
		expect(firstHandle.workdir).toBe('/workspace/app');
		expect(secondHandle.workdir).toBe('/work/tmp');
		await secondHandle.buildExecSpec({ command: 'pwd', env: {}, usePty: false });
		expect(buildExecSpec).toHaveBeenCalledWith({
			command: 'pwd',
			env: {},
			ssh: expect.any(Object),
			usePty: false,
			workdir: '/work/tmp',
		});
		expect(requestLease).toHaveBeenCalledTimes(1);
		expect(renewLease).toHaveBeenCalledTimes(1);
	});

	it('reuses the same lease for repeated requests from the same agent', async () => {
		const requestLease = vi.fn(async () => createLeaseResponse('lease-reuse'));

		const factory = createAgentVmSandboxBackendFactory(
			{
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId: 'shravan',
			},
			{
				buildExecSpec: vi.fn(async () => ({
					argv: ['ssh'],
					env: {},
					stdinMode: 'pipe-open' as const,
				})),
				createLeaseClient: () => ({
					...createActiveUseLeaseClientMethods(),
					renewLease: async () => createLeaseResponse('lease-reuse'),
					peekLease: async () => createLeasePeekResponse(),
					releaseLease: async () => {},
					requestLease,
				}),
				runRemoteShellScript: vi.fn(),
			},
		);

		const firstHandle = await factory({
			agentWorkspaceDir: '/zone/agents/main',
			cfg: agentVmSandboxConfig(),
			scopeKey: 'agent:main',
			sessionKey: 'agent:main:session-reuse',
			workspaceDir: '/work',
		});
		const secondHandle = await factory({
			agentWorkspaceDir: '/zone/agents/main',
			cfg: agentVmSandboxConfig(),
			scopeKey: 'agent:main',
			sessionKey: 'agent:main:session-reuse',
			workspaceDir: '/work',
		});

		expect(firstHandle).not.toBe(secondHandle);
		expect(firstHandle.runtimeId).toBe(secondHandle.runtimeId);
		expect(requestLease).toHaveBeenCalledTimes(1);
	});

	it('reacquires a cached handle when the cached SSH probe fails before reuse', async () => {
		const oldLease = createLeaseResponse('01890f00-0000-7000-8000-000000000001');
		const replacementLease = createLeaseResponse('01890f00-0000-7000-8000-000000000002');
		const requestLease = vi.fn(async () => oldLease);
		const reacquireLease = vi.fn(async () => replacementLease);
		const runRemoteShellScript = vi
			.fn()
			.mockRejectedValueOnce(new Error('kex reset'))
			.mockResolvedValue({ code: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) });
		const factory = createAgentVmSandboxBackendFactory(
			{
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId: 'shravan',
			},
			{
				buildExecSpec: vi.fn(async () => ({
					argv: ['ssh'],
					env: {},
					stdinMode: 'pipe-open' as const,
				})),
				createLeaseClient: () => ({
					...createActiveUseLeaseClientMethods(),
					peekLease: async () => createLeasePeekResponse(),
					reacquireLease,
					releaseLease: async () => {},
					renewLease: async (leaseId: string) => createLeaseResponse(leaseId),
					requestLease,
				}),
				runRemoteShellScript,
			},
		);

		const firstHandle = await factory(createFactoryParamsForAgent('beta'));
		const secondHandle = await factory(createFactoryParamsForAgent('beta'));

		expect(secondHandle).not.toBe(firstHandle);
		expect(firstHandle.runtimeId).toBe(oldLease.leaseId);
		expect(secondHandle.runtimeId).toBe(replacementLease.leaseId);
		expect(requestLease).toHaveBeenCalledTimes(1);
		expect(reacquireLease).toHaveBeenCalledWith(oldLease.leaseId, {
			observedAtMs: expect.any(Number),
			staleEvidence: {
				kind: 'tool-vm-ssh',
				operation: 'probe',
			},
		});
	});

	it('drops a cached handle after an SSH command failure inside an operation', async () => {
		const requestLease = vi
			.fn()
			.mockResolvedValueOnce(createLeaseResponse('01890f00-0000-7000-8000-000000000001'))
			.mockResolvedValueOnce(createLeaseResponse('01890f00-0000-7000-8000-000000000002'));
		const releaseLease = vi.fn(async () => {});
		const factory = createAgentVmSandboxBackendFactory(
			{
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId: 'shravan',
			},
			{
				buildExecSpec: vi.fn(async () => ({
					argv: ['ssh'],
					env: {},
					stdinMode: 'pipe-open' as const,
				})),
				createLeaseClient: () => ({
					...createActiveUseLeaseClientMethods(),
					peekLease: async () => createLeasePeekResponse(),
					releaseLease,
					renewLease: async (leaseId: string) => createLeaseResponse(leaseId),
					requestLease,
				}),
				runRemoteShellScript: vi.fn(async () => {
					throw new Error('ssh hung');
				}),
			},
		);

		const handle = await factory(createFactoryParamsForAgent('beta'));
		await expect(handle.runShellCommand({ script: 'pwd' })).rejects.toThrow(/ssh hung/u);
		await factory(createFactoryParamsForAgent('beta'));

		expect(releaseLease).not.toHaveBeenCalled();
		expect(requestLease).toHaveBeenCalledTimes(2);
	});

	it('reacquires from a sibling handle while the shared stale lease retains controller authority', async () => {
		const oldLease = createLeaseResponse('sibling-old');
		const replacementLease = createLeaseResponse('sibling-new');
		let retiredLeaseId: string | undefined;
		let retiredReacquireRequest:
			| {
					readonly observedAtMs: number;
					readonly staleEvidence: {
						readonly kind: 'tool-vm-ssh';
						readonly operation: 'command';
					};
			  }
			| undefined;
		let oldLeaseAuthorityAvailable = true;
		const requestLease = vi.fn(async () => oldLease);
		const startActiveUse = vi.fn(async (_leaseId: string, request) => ({
			expiresAt: 2_000,
			heartbeatAfterMs: 1_000,
			useId: request.useId,
		}));
		const reacquireLease = vi.fn(async (oldLeaseId: string) => {
			expect(oldLeaseId).toBe(oldLease.leaseId);
			expect(retiredLeaseId).toBe(oldLease.leaseId);
			expect(oldLeaseAuthorityAvailable).toBe(true);
			return replacementLease;
		});
		const releaseLease = vi.fn(async () => {
			oldLeaseAuthorityAvailable = false;
		});
		const retainRetiredLeaseReacquireRequest = vi.fn(
			(leaseId: string, reacquireRequest: OpenClawAgentVmLeaseReacquireRequest) => {
				retiredLeaseId = leaseId;
				if (
					reacquireRequest.staleEvidence.kind === 'tool-vm-ssh' &&
					reacquireRequest.staleEvidence.operation === 'command'
				) {
					retiredReacquireRequest = {
						observedAtMs: reacquireRequest.observedAtMs,
						staleEvidence: { kind: 'tool-vm-ssh', operation: 'command' },
					};
				}
				return true;
			},
		);
		const runRemoteShellScript = vi
			.fn()
			.mockResolvedValueOnce({ code: 0, stderr: Buffer.alloc(0), stdout: Buffer.from('probe') })
			.mockRejectedValueOnce(new Error('kex reset'))
			.mockResolvedValue({ code: 0, stderr: Buffer.alloc(0), stdout: Buffer.from('ok') });
		const leaseClient: LeaseClient = {
			endActiveUse: vi.fn(async () => {}),
			getRetiredLeaseReacquireRequest: (leaseId) =>
				retiredLeaseId === leaseId ? retiredReacquireRequest : undefined,
			heartbeatActiveUse: vi.fn(async () => ({
				expiresAt: 2_000,
				heartbeatAfterMs: 1_000,
			})),
			peekLease: async () => createLeasePeekResponse(oldLease.leaseId),
			reacquireLease,
			releaseLease,
			renewLease: async () => oldLease,
			requestLease,
			retainRetiredLeaseReacquireRequest,
			startActiveUse,
		};
		const factory = createAgentVmSandboxBackendFactory(
			{
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId: 'shravan',
			},
			{
				buildExecSpec: vi.fn(async () => ({
					argv: ['ssh'],
					env: {},
					stdinMode: 'pipe-open' as const,
				})),
				createLeaseClient: () => leaseClient,
				runRemoteShellScript,
			},
		);

		const firstHandle = await factory(createFactoryParamsForAgent('main'));
		const secondHandle = await factory(createFactoryParamsForAgent('main'));

		await expect(firstHandle.runShellCommand({ script: 'pwd' })).rejects.toThrow(/kex reset/u);
		await expect(secondHandle.runShellCommand({ script: 'pwd' })).resolves.toEqual({
			code: 0,
			stderr: Buffer.alloc(0),
			stdout: Buffer.from('ok'),
		});

		expect(firstHandle.runtimeId).toBe(oldLease.leaseId);
		expect(secondHandle.runtimeId).toBe(replacementLease.leaseId);
		expect(releaseLease).not.toHaveBeenCalled();
		expect(reacquireLease).toHaveBeenCalledWith(oldLease.leaseId, {
			observedAtMs: expect.any(Number),
			staleEvidence: {
				kind: 'tool-vm-ssh',
				operation: 'command',
			},
		});
		expect(startActiveUse.mock.calls.map(([leaseId]) => leaseId)).toEqual([
			oldLease.leaseId,
			replacementLease.leaseId,
		]);
		expect(runRemoteShellScript).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ ssh: oldLease.ssh }),
		);
		expect(runRemoteShellScript).toHaveBeenNthCalledWith(
			3,
			expect.objectContaining({ ssh: replacementLease.ssh }),
		);
	});

	it('shares a local stale marker without pre-releasing authority for sibling handles', async () => {
		const oldLease = createLeaseResponse('sibling-release-fails-old');
		const replacementLease = createLeaseResponse('sibling-release-fails-new');
		let retainedReacquireRequest: OpenClawAgentVmLeaseReacquireRequest | undefined;
		const requestLease = vi.fn(async () => oldLease);
		const startActiveUse = vi.fn(async (_leaseId: string, request) => ({
			expiresAt: 2_000,
			heartbeatAfterMs: 1_000,
			useId: request.useId,
		}));
		const reacquireLease = vi.fn(async (oldLeaseId: string) => {
			expect(oldLeaseId).toBe(oldLease.leaseId);
			expect(retainedReacquireRequest).toEqual({
				observedAtMs: expect.any(Number),
				staleEvidence: {
					kind: 'tool-vm-ssh',
					operation: 'command',
				},
			});
			return replacementLease;
		});
		const releaseLease = vi.fn(async () => {
			throw new Error('controller release transport failed');
		});
		const runRemoteShellScript = vi
			.fn()
			.mockResolvedValueOnce({ code: 0, stderr: Buffer.alloc(0), stdout: Buffer.from('probe') })
			.mockRejectedValueOnce(new Error('kex reset'))
			.mockResolvedValue({ code: 0, stderr: Buffer.alloc(0), stdout: Buffer.from('ok') });
		const leaseClient = {
			endActiveUse: vi.fn(async () => {}),
			getRetiredLeaseReacquireRequest: () => retainedReacquireRequest,
			heartbeatActiveUse: vi.fn(async () => ({
				expiresAt: 2_000,
				heartbeatAfterMs: 1_000,
			})),
			peekLease: async () => createLeasePeekResponse(oldLease.leaseId),
			reacquireLease,
			releaseLease,
			renewLease: async () => oldLease,
			requestLease,
			retainRetiredLeaseReacquireRequest: (_leaseId, reacquireRequest) => {
				if (
					reacquireRequest.staleEvidence.kind === 'tool-vm-ssh' &&
					reacquireRequest.staleEvidence.operation === 'command'
				) {
					retainedReacquireRequest = {
						observedAtMs: reacquireRequest.observedAtMs,
						staleEvidence: reacquireRequest.staleEvidence,
					};
					return true;
				}
				return false;
			},
			startActiveUse,
		} satisfies LeaseClient;
		const factory = createAgentVmSandboxBackendFactory(
			{
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId: 'shravan',
			},
			{
				buildExecSpec: vi.fn(async () => ({
					argv: ['ssh'],
					env: {},
					stdinMode: 'pipe-open' as const,
				})),
				createLeaseClient: () => leaseClient,
				runRemoteShellScript,
			},
		);

		const firstHandle = await factory(createFactoryParamsForAgent('main'));
		const secondHandle = await factory(createFactoryParamsForAgent('main'));

		await expect(firstHandle.runShellCommand({ script: 'pwd' })).rejects.toThrow(/kex reset/u);
		await expect(secondHandle.runShellCommand({ script: 'pwd' })).resolves.toEqual({
			code: 0,
			stderr: Buffer.alloc(0),
			stdout: Buffer.from('ok'),
		});

		expect(releaseLease).not.toHaveBeenCalled();
		expect(reacquireLease).toHaveBeenCalledTimes(1);
		expect(startActiveUse.mock.calls.map(([leaseId]) => leaseId)).toEqual([
			oldLease.leaseId,
			replacementLease.leaseId,
		]);
	});

	it('reacquires a cached-probe lease before cleanup can delete its controller authority', async () => {
		const oldLease = createLeaseResponse('cached-probe-old');
		const replacementLease = createLeaseResponse('cached-probe-new');
		const publishHealthEvent = vi.fn(async () => {});
		let retainedReacquireRequest: OpenClawAgentVmLeaseReacquireRequest | undefined;
		let oldLeaseAuthorityAvailable = true;
		const requestLease = vi.fn(async () => {
			oldLeaseAuthorityAvailable = true;
			return oldLease;
		});
		const startActiveUse = vi.fn(async (_leaseId: string, request) => ({
			expiresAt: 2_000,
			heartbeatAfterMs: 1_000,
			useId: request.useId,
		}));
		const reacquireLease = vi.fn(async (oldLeaseId: string) => {
			expect(oldLeaseId).toBe(oldLease.leaseId);
			if (!oldLeaseAuthorityAvailable) {
				throw new ControllerLeaseRequestError({
					bodyText: JSON.stringify({
						leaseRejectionReason: 'lease_authority_absent',
						message: 'gateway control lease authority is absent',
					}),
					context: 'Gateway control lease_reacquire',
					leaseRejectionReason: 'lease_authority_absent',
					responseBody: {
						leaseRejectionReason: 'lease_authority_absent',
						message: 'gateway control lease authority is absent',
					},
					status: 404,
				});
			}
			expect(retainedReacquireRequest).toEqual({
				observedAtMs: expect.any(Number),
				staleEvidence: {
					kind: 'tool-vm-ssh',
					operation: 'probe',
				},
			});
			return replacementLease;
		});
		const releaseLease = vi.fn(async () => {
			oldLeaseAuthorityAvailable = false;
		});
		const retainRetiredLeaseReacquireRequest = vi.fn(
			(_leaseId: string, reacquireRequest: OpenClawAgentVmLeaseReacquireRequest) => {
				retainedReacquireRequest = reacquireRequest;
				return true;
			},
		);
		const runRemoteShellScript = vi
			.fn()
			.mockRejectedValueOnce(new Error('cached probe reset'))
			.mockResolvedValue({ code: 0, stderr: Buffer.alloc(0), stdout: Buffer.from('ok') });
		const leaseClient = {
			endActiveUse: vi.fn(async () => {}),
			getRetiredLeaseReacquireRequest: (leaseId) =>
				leaseId === oldLease.leaseId ? retainedReacquireRequest : undefined,
			heartbeatActiveUse: vi.fn(async () => ({
				expiresAt: 2_000,
				heartbeatAfterMs: 1_000,
			})),
			peekLease: async () => createLeasePeekResponse(oldLease.leaseId),
			reacquireLease,
			releaseLease,
			renewLease: async () => oldLease,
			requestLease,
			retainRetiredLeaseReacquireRequest,
			startActiveUse,
		} satisfies LeaseClient;
		const factory = createAgentVmSandboxBackendFactory(
			{
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId: 'shravan',
			},
			{
				buildExecSpec: vi.fn(async () => ({
					argv: ['ssh'],
					env: {},
					stdinMode: 'pipe-open' as const,
				})),
				createLeaseClient: () => leaseClient,
				publishHealthEvent,
				runRemoteShellScript,
			},
		);

		const firstHandle = await factory(createFactoryParamsForAgent('main'));
		await factory(createFactoryParamsForAgent('main'));
		await expect(firstHandle.runShellCommand({ script: 'pwd' })).resolves.toEqual({
			code: 0,
			stderr: Buffer.alloc(0),
			stdout: Buffer.from('ok'),
		});

		expect(retainRetiredLeaseReacquireRequest).toHaveBeenCalledWith(oldLease.leaseId, {
			observedAtMs: expect.any(Number),
			staleEvidence: {
				kind: 'tool-vm-ssh',
				operation: 'probe',
			},
		});
		expect(releaseLease).not.toHaveBeenCalled();
		expect(reacquireLease).toHaveBeenCalledWith(oldLease.leaseId, {
			observedAtMs: expect.any(Number),
			staleEvidence: {
				kind: 'tool-vm-ssh',
				operation: 'probe',
			},
		});
		expect(publishHealthEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: 'main',
				callerContextState: 'stale',
				kind: 'tool-vm-ssh',
				leaseId: oldLease.leaseId,
				lifecycleEventRole: 'plugin_observation',
				lifecycleTransition: 'current_to_stale',
				oldLeaseId: oldLease.leaseId,
				operation: 'probe',
				result: 'failed',
				transitionId: `lease_reacquire:${oldLease.leaseId}`,
				zoneId: 'shravan',
			}),
		);
		expect(requestLease).toHaveBeenCalledTimes(1);
		expect(startActiveUse.mock.calls.map(([leaseId]) => leaseId)).toEqual([
			replacementLease.leaseId,
		]);
	});

	it('retains a cached-probe reacquire hint across direct reacquire failures without cleanup', async () => {
		const oldLease = createLeaseResponse('cached-probe-retain-old');
		const replacementLease = createLeaseResponse('cached-probe-retain-new');
		let retainedReacquireRequest: OpenClawAgentVmLeaseReacquireRequest | undefined;
		let reacquireAttempt = 0;
		const requestLease = vi.fn(async () => oldLease);
		const startActiveUse = vi.fn(async (_leaseId: string, request) => ({
			expiresAt: 2_000,
			heartbeatAfterMs: 1_000,
			useId: request.useId,
		}));
		const reacquireLease = vi.fn(async (oldLeaseId: string) => {
			expect(oldLeaseId).toBe(oldLease.leaseId);
			reacquireAttempt += 1;
			if (reacquireAttempt === 1) {
				throw new ControllerLeaseRequestError({
					bodyText: JSON.stringify({ message: 'controller reacquire unavailable' }),
					context: 'Gateway control lease_reacquire',
					responseBody: { message: 'controller reacquire unavailable' },
					status: 503,
				});
			}
			return replacementLease;
		});
		const releaseLease = vi.fn(async () => {
			throw new Error('controller release transport failed');
		});
		const retainRetiredLeaseReacquireRequest = vi.fn(
			(_leaseId: string, reacquireRequest: OpenClawAgentVmLeaseReacquireRequest) => {
				retainedReacquireRequest = reacquireRequest;
				return true;
			},
		);
		const runRemoteShellScript = vi
			.fn()
			.mockRejectedValueOnce(new Error('cached probe reset'))
			.mockResolvedValue({ code: 0, stderr: Buffer.alloc(0), stdout: Buffer.from('ok') });
		const leaseClient = {
			endActiveUse: vi.fn(async () => {}),
			getRetiredLeaseReacquireRequest: (leaseId: string) =>
				leaseId === oldLease.leaseId ? retainedReacquireRequest : undefined,
			heartbeatActiveUse: vi.fn(async () => ({
				expiresAt: 2_000,
				heartbeatAfterMs: 1_000,
			})),
			peekLease: async () => createLeasePeekResponse(oldLease.leaseId),
			reacquireLease,
			releaseLease,
			renewLease: async () => oldLease,
			requestLease,
			retainRetiredLeaseReacquireRequest,
			startActiveUse,
		} satisfies LeaseClient;
		const factory = createAgentVmSandboxBackendFactory(
			{
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId: 'shravan',
			},
			{
				buildExecSpec: vi.fn(async () => ({
					argv: ['ssh'],
					env: {},
					stdinMode: 'pipe-open' as const,
				})),
				createLeaseClient: () => leaseClient,
				runRemoteShellScript,
			},
		);

		const firstHandle = await factory(createFactoryParamsForAgent('main'));
		await expect(factory(createFactoryParamsForAgent('main'))).rejects.toThrow(
			'Gateway control lease_reacquire returned HTTP 503',
		);
		await expect(firstHandle.runShellCommand({ script: 'pwd' })).resolves.toEqual({
			code: 0,
			stderr: Buffer.alloc(0),
			stdout: Buffer.from('ok'),
		});

		expect(retainRetiredLeaseReacquireRequest).toHaveBeenCalledWith(oldLease.leaseId, {
			observedAtMs: expect.any(Number),
			staleEvidence: {
				kind: 'tool-vm-ssh',
				operation: 'probe',
			},
		});
		const retainCallOrder = retainRetiredLeaseReacquireRequest.mock.invocationCallOrder[0];
		const firstReacquireCallOrder = reacquireLease.mock.invocationCallOrder[0];
		if (retainCallOrder === undefined || firstReacquireCallOrder === undefined) {
			throw new Error('expected retain and reacquire calls');
		}
		expect(retainCallOrder).toBeLessThan(firstReacquireCallOrder);
		expect(releaseLease).not.toHaveBeenCalled();
		expect(reacquireLease).toHaveBeenCalledTimes(2);
		expect(startActiveUse.mock.calls.map(([leaseId]) => leaseId)).toEqual([
			replacementLease.leaseId,
		]);
	});

	it('refuses a cached agent lease when the agent workspace root changes', async () => {
		const requestLease = vi.fn(async (_request: Parameters<LeaseClient['requestLease']>[0]) =>
			createLeaseResponse('shravan-beta-100', {
				agentId: 'beta',
			}),
		);

		const factory = createAgentVmSandboxBackendFactory(
			{
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId: 'shravan',
			},
			{
				buildExecSpec: vi.fn(async () => ({
					argv: ['ssh'],
					env: {},
					stdinMode: 'pipe-open' as const,
				})),
				createLeaseClient: () => ({
					...createActiveUseLeaseClientMethods(),
					renewLease: async () => createLeaseResponse('shravan-beta-100'),
					peekLease: async () => createLeasePeekResponse(),
					releaseLease: async () => {},
					requestLease,
				}),
				runRemoteShellScript: vi.fn(),
			},
		);

		await factory({
			agentWorkspaceDir: '/zone/agents/beta',
			cfg: agentVmSandboxConfig(),
			scopeKey: 'agent:beta:discord:channel:123',
			sessionKey: 'agent:beta:discord:channel:123',
			workspaceDir: '/zone/agents/beta',
		});
		await expect(
			factory({
				agentWorkspaceDir: '/zone/agents/beta-edited',
				cfg: agentVmSandboxConfig(),
				scopeKey: 'agent:beta:discord:channel:999',
				sessionKey: 'agent:beta:discord:channel:999',
				workspaceDir: '/zone/agents/beta-edited',
			}),
		).rejects.toThrow(/cached Tool VM lease.*agentWorkspaceDir/u);

		expect(requestLease).toHaveBeenCalledTimes(1);
		expect(requestLease.mock.calls[0]?.[0]).not.toHaveProperty('scopeKey');
		expect(requestLease.mock.calls[0]?.[0]).not.toHaveProperty('sandbox');
	});

	it('shares one in-flight lease request for concurrent same-agent calls', async () => {
		let resolveRequest: (() => void) | undefined;
		const requestGate = new Promise<void>((resolve) => {
			resolveRequest = resolve;
		});
		const requestLease = vi.fn(async () => {
			await requestGate;
			return createLeaseResponse('shravan-beta-concurrent', {
				agentId: 'beta',
			});
		});
		const factory = createAgentVmSandboxBackendFactory(
			{
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId: 'shravan',
			},
			{
				buildExecSpec: vi.fn(async () => ({
					argv: ['ssh'],
					env: {},
					stdinMode: 'pipe-open' as const,
				})),
				createLeaseClient: () => ({
					...createActiveUseLeaseClientMethods(),
					renewLease: async () =>
						createLeaseResponse('shravan-beta-concurrent', {
							agentId: 'beta',
						}),
					peekLease: async () => createLeasePeekResponse(),
					releaseLease: async () => {},
					requestLease,
				}),
				runRemoteShellScript: vi.fn(),
			},
		);

		const firstHandlePromise = factory(createFactoryParamsForAgent('beta'));
		const secondHandlePromise = factory(createFactoryParamsForAgent('beta'));
		await Promise.resolve();

		expect(requestLease).toHaveBeenCalledTimes(1);
		resolveRequest?.();
		const [firstHandle, secondHandle] = await Promise.all([
			firstHandlePromise,
			secondHandlePromise,
		]);

		expect(firstHandle).not.toBe(secondHandle);
		expect(firstHandle.runtimeId).toBe(secondHandle.runtimeId);
		expect(requestLease).toHaveBeenCalledTimes(1);
	});

	it('drops a cached handle when lease renew returns 404 and requests a fresh lease', async () => {
		const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		const requestLease = vi
			.fn()
			.mockResolvedValueOnce(createLeaseResponse('lease-old'))
			.mockResolvedValueOnce(createLeaseResponse('lease-new'));
		const renewLease = vi
			.fn()
			.mockResolvedValueOnce(createLeaseResponse('lease-old'))
			.mockRejectedValueOnce(createControllerLeaseError(404));

		const factory = createAgentVmSandboxBackendFactory(
			{
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId: 'shravan',
			},
			{
				buildExecSpec: vi.fn(async () => ({
					argv: ['ssh'],
					env: {},
					stdinMode: 'pipe-open' as const,
				})),
				createLeaseClient: () => ({
					...createActiveUseLeaseClientMethods(),
					renewLease,
					peekLease: async () => createLeasePeekResponse(),
					releaseLease: async () => {},
					requestLease,
				}),
				runRemoteShellScript: vi.fn(),
			},
		);

		try {
			const firstHandle = await factory({
				agentWorkspaceDir: '/zone/agents/main',
				cfg: agentVmSandboxConfig(),
				scopeKey: 'agent:main',
				sessionKey: 'agent:main:session-stale',
				workspaceDir: '/work',
			});
			const secondHandle = await factory({
				agentWorkspaceDir: '/zone/agents/main',
				cfg: agentVmSandboxConfig(),
				scopeKey: 'agent:main',
				sessionKey: 'agent:main:session-stale',
				workspaceDir: '/work',
			});
			const thirdHandle = await factory({
				agentWorkspaceDir: '/zone/agents/main',
				cfg: agentVmSandboxConfig(),
				scopeKey: 'agent:main',
				sessionKey: 'agent:main:session-stale',
				workspaceDir: '/work',
			});

			expect(firstHandle).not.toBe(secondHandle);
			expect(firstHandle.runtimeId).toBe(secondHandle.runtimeId);
			expect(thirdHandle).not.toBe(firstHandle);
			expect(requestLease).toHaveBeenCalledTimes(2);
			const loggedMessages = stderrWrite.mock.calls.map(([message]) => String(message));
			expect(
				loggedMessages.some(
					(message) =>
						message.includes('lease renew failed') &&
						message.includes("agent 'main'") &&
						message.includes(`lease '${testToolVmLeaseId('lease-old')}'`),
				),
			).toBe(true);
		} finally {
			stderrWrite.mockRestore();
		}
	});

	it('does not request a fresh lease when cached renew returns a client error other than 404', async () => {
		const requestLease = vi.fn(async () => createLeaseResponse('lease-client-error'));
		const renewLease = vi.fn().mockRejectedValueOnce(createControllerLeaseError(409));

		const factory = createAgentVmSandboxBackendFactory(
			{
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId: 'shravan',
			},
			{
				buildExecSpec: vi.fn(async () => ({
					argv: ['ssh'],
					env: {},
					stdinMode: 'pipe-open' as const,
				})),
				createLeaseClient: () => ({
					...createActiveUseLeaseClientMethods(),
					renewLease,
					peekLease: async () => createLeasePeekResponse(),
					releaseLease: async () => {},
					requestLease,
				}),
				runRemoteShellScript: vi.fn(),
			},
		);

		await factory({
			agentWorkspaceDir: '/zone/agents/main',
			cfg: agentVmSandboxConfig(),
			scopeKey: 'agent:main',
			sessionKey: 'agent:main:session-client-error',
			workspaceDir: '/work',
		});

		await expect(
			factory({
				agentWorkspaceDir: '/zone/agents/main',
				cfg: agentVmSandboxConfig(),
				scopeKey: 'agent:main',
				sessionKey: 'agent:main:session-client-error',
				workspaceDir: '/work',
			}),
		).rejects.toMatchObject({
			status: 409,
		} satisfies Partial<ControllerLeaseRequestError>);
		expect(requestLease).toHaveBeenCalledTimes(1);
	});

	it('does not request a fresh lease when cached renew returns a server error', async () => {
		const requestLease = vi.fn(async () => createLeaseResponse('lease-server-error'));
		const renewLease = vi.fn().mockRejectedValueOnce(createControllerLeaseError(503));

		const factory = createAgentVmSandboxBackendFactory(
			{
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId: 'shravan',
			},
			{
				buildExecSpec: vi.fn(async () => ({
					argv: ['ssh'],
					env: {},
					stdinMode: 'pipe-open' as const,
				})),
				createLeaseClient: () => ({
					...createActiveUseLeaseClientMethods(),
					renewLease,
					peekLease: async () => createLeasePeekResponse(),
					releaseLease: async () => {},
					requestLease,
				}),
				runRemoteShellScript: vi.fn(),
			},
		);

		await factory({
			agentWorkspaceDir: '/zone/agents/main',
			cfg: agentVmSandboxConfig(),
			scopeKey: 'agent:main',
			sessionKey: 'agent:main:session-server-error',
			workspaceDir: '/work',
		});

		await expect(
			factory({
				agentWorkspaceDir: '/zone/agents/main',
				cfg: agentVmSandboxConfig(),
				scopeKey: 'agent:main',
				sessionKey: 'agent:main:session-server-error',
				workspaceDir: '/work',
			}),
		).rejects.toMatchObject({
			status: 503,
		} satisfies Partial<ControllerLeaseRequestError>);
		expect(requestLease).toHaveBeenCalledTimes(1);
	});

	it('does not request a fresh lease when cached renew has a network failure', async () => {
		const requestLease = vi.fn(async () => createLeaseResponse('lease-network-error'));
		const renewLease = vi.fn().mockRejectedValueOnce(new Error('temporary network failure'));

		const factory = createAgentVmSandboxBackendFactory(
			{
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId: 'shravan',
			},
			{
				buildExecSpec: vi.fn(async () => ({
					argv: ['ssh'],
					env: {},
					stdinMode: 'pipe-open' as const,
				})),
				createLeaseClient: () => ({
					...createActiveUseLeaseClientMethods(),
					renewLease,
					peekLease: async () => createLeasePeekResponse(),
					releaseLease: async () => {},
					requestLease,
				}),
				runRemoteShellScript: vi.fn(),
			},
		);

		await factory({
			agentWorkspaceDir: '/zone/agents/main',
			cfg: agentVmSandboxConfig(),
			scopeKey: 'agent:main',
			sessionKey: 'agent:main:session-network-error',
			workspaceDir: '/work',
		});

		await expect(
			factory({
				agentWorkspaceDir: '/zone/agents/main',
				cfg: agentVmSandboxConfig(),
				scopeKey: 'agent:main',
				sessionKey: 'agent:main:session-network-error',
				workspaceDir: '/work',
			}),
		).rejects.toThrow('temporary network failure');
		expect(requestLease).toHaveBeenCalledTimes(1);
	});

	it('creates separate handles for different agent scope keys', async () => {
		let leaseCounter = 0;
		const requestLease = vi.fn(async () => {
			leaseCounter++;
			return createLeaseResponse(`lease-${leaseCounter}`);
		});

		const factory = createAgentVmSandboxBackendFactory(
			{
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId: 'shravan',
			},
			{
				buildExecSpec: vi.fn(async () => ({
					argv: ['ssh'],
					env: {},
					stdinMode: 'pipe-open' as const,
				})),
				createLeaseClient: () => ({
					...createActiveUseLeaseClientMethods(),
					renewLease: async () => createLeaseResponse('lease-renew'),
					peekLease: async () => createLeasePeekResponse(),
					releaseLease: async () => {},
					requestLease,
				}),
				runRemoteShellScript: vi.fn(),
			},
		);

		const handleA = await factory({
			agentWorkspaceDir: '/zone/agents/main',
			cfg: agentVmSandboxConfig(),
			scopeKey: 'agent:alpha',
			sessionKey: 'agent:alpha:session-a',
			workspaceDir: '/work',
		});
		const handleB = await factory({
			agentWorkspaceDir: '/zone/agents/main',
			cfg: agentVmSandboxConfig(),
			scopeKey: 'agent:beta',
			sessionKey: 'agent:beta:session-b',
			workspaceDir: '/work',
		});

		expect(handleA).not.toBe(handleB);
		expect(handleA.runtimeId).toBe(testToolVmLeaseId('lease-1'));
		expect(handleB.runtimeId).toBe(testToolVmLeaseId('lease-2'));
		expect(requestLease).toHaveBeenCalledTimes(2);
	});

	it('requests a new lease when the cached scope handle points at a missing lease', async () => {
		let leaseCounter = 0;
		const renewLease = vi.fn(async (leaseId: string) => {
			if (leaseId === testToolVmLeaseId('lease-1')) {
				throw createControllerLeaseError(404);
			}
			return createLeaseResponse(leaseId);
		});
		const requestLease = vi.fn(async () => {
			leaseCounter += 1;
			return createLeaseResponse(`lease-${leaseCounter}`);
		});

		const factory = createAgentVmSandboxBackendFactory(
			{
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId: 'shravan',
			},
			{
				buildExecSpec: vi.fn(async () => ({
					argv: ['ssh'],
					env: {},
					stdinMode: 'pipe-open' as const,
				})),
				createLeaseClient: () => ({
					...createActiveUseLeaseClientMethods(),
					renewLease,
					peekLease: async () => createLeasePeekResponse(),
					releaseLease: async () => {},
					requestLease,
				}),
				runRemoteShellScript: vi.fn(),
			},
		);

		const firstHandle = await factory({
			agentWorkspaceDir: '/zone/agents/main',
			cfg: agentVmSandboxConfig(),
			scopeKey: 'agent:main',
			sessionKey: 'agent:main:session-stale',
			workspaceDir: '/work',
		});
		const secondHandle = await factory({
			agentWorkspaceDir: '/zone/agents/main',
			cfg: agentVmSandboxConfig(),
			scopeKey: 'agent:main',
			sessionKey: 'agent:main:session-stale',
			workspaceDir: '/work',
		});

		expect(firstHandle).not.toBe(secondHandle);
		expect(requestLease).toHaveBeenCalledTimes(2);
		expect(renewLease).toHaveBeenCalledWith(testToolVmLeaseId('lease-1'));
		expect(secondHandle.runtimeId).toBe(testToolVmLeaseId('lease-2'));
	});

	it('finalizeExec calls dispose on token when dispose is present', async () => {
		const factory = createAgentVmSandboxBackendFactory(
			{
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId: 'shravan',
			},
			{
				buildExecSpec: vi.fn(async () => ({
					argv: ['ssh'],
					env: {},
					stdinMode: 'pipe-open' as const,
				})),
				createLeaseClient: () => ({
					...createActiveUseLeaseClientMethods(),
					renewLease: async () => createLeaseResponse('lease-renew'),
					peekLease: async () => createLeasePeekResponse(),
					releaseLease: async () => {},
					requestLease: vi.fn(async () => createLeaseResponse('lease-finalize')),
				}),
				runRemoteShellScript: vi.fn(),
			},
		);

		const backend = await factory({
			agentWorkspaceDir: '/zone/agents/main',
			cfg: agentVmSandboxConfig(),
			scopeKey: 'agent:main',
			sessionKey: 'agent:main:session-finalize',
			workspaceDir: '/work',
		});

		const disposeFn = vi.fn(async () => {});
		await backend.finalizeExec?.({
			status: 'completed',
			exitCode: 0,
			timedOut: false,
			token: { dispose: disposeFn },
		});
		expect(disposeFn).toHaveBeenCalledTimes(1);
	});

	it('finalizeExec does not stale the cached lease for a nonzero user command exit', async () => {
		const releaseLease = vi.fn(async () => {});
		const endActiveUse = vi.fn(async () => {});
		const factory = createAgentVmSandboxBackendFactory(
			{
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId: 'shravan',
			},
			{
				buildExecSpec: vi.fn(async () => ({
					argv: ['ssh'],
					env: {},
					stdinMode: 'pipe-open' as const,
				})),
				createLeaseClient: () => ({
					...createActiveUseLeaseClientMethods(),
					endActiveUse,
					renewLease: async () => createLeaseResponse('lease-renew'),
					peekLease: async () => createLeasePeekResponse(),
					releaseLease,
					requestLease: vi.fn(async () => createLeaseResponse('lease-command-failed')),
				}),
				runRemoteShellScript: vi.fn(),
			},
		);

		const backend = await factory({
			agentWorkspaceDir: '/zone/agents/main',
			cfg: agentVmSandboxConfig(),
			scopeKey: 'agent:main',
			sessionKey: 'agent:main:session-command-failed',
			workspaceDir: '/work',
		});
		const execSpec = await backend.buildExecSpec({
			command: 'pnpm test',
			env: {},
			usePty: false,
		});

		await backend.finalizeExec?.({
			status: 'failed',
			exitCode: 1,
			timedOut: false,
			token: execSpec.finalizeToken,
		});

		expect(endActiveUse).toHaveBeenCalledWith(
			testToolVmLeaseId('lease-command-failed'),
			expect.any(String),
			expect.objectContaining({ outcome: 'failed' }),
		);
		expect(releaseLease).not.toHaveBeenCalled();
	});

	it('finalizeExec publishes Tool VM SSH finalize health', async () => {
		const publishHealthEvent = vi.fn(async () => {});
		const factory = createAgentVmSandboxBackendFactory(
			{
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId: 'shravan',
			},
			{
				buildExecSpec: vi.fn(async () => ({
					argv: ['ssh'],
					env: {},
					stdinMode: 'pipe-open' as const,
				})),
				createLeaseClient: () => ({
					...createActiveUseLeaseClientMethods(),
					renewLease: async () => createLeaseResponse('lease-renew'),
					peekLease: async () => createLeasePeekResponse(),
					releaseLease: async () => {},
					requestLease: vi.fn(async () => createLeaseResponse('lease-finalize-health')),
				}),
				publishHealthEvent,
				runRemoteShellScript: vi.fn(),
			},
		);

		const backend = await factory({
			agentWorkspaceDir: '/zone/agents/main',
			cfg: agentVmSandboxConfig(),
			scopeKey: 'agent:main',
			sessionKey: 'agent:main:session-finalize-health',
			workspaceDir: '/work',
		});
		const execSpec = await backend.buildExecSpec({
			command: 'pnpm test',
			env: {},
			usePty: false,
		});

		await backend.finalizeExec?.({
			status: 'completed',
			exitCode: 0,
			timedOut: false,
			token: execSpec.finalizeToken,
		});

		expect(publishHealthEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: 'main',
				kind: 'tool-vm-ssh',
				leaseId: testToolVmLeaseId('lease-finalize-health'),
				operation: 'finalize',
				result: 'ok',
				sessionKeyDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
				zoneId: 'shravan',
			}),
		);
	});

	it('finalizeExec does not wait for Tool VM SSH finalize health publishing', async () => {
		const publishHealthEvent = vi.fn(async () => new Promise<void>(() => {}));
		const factory = createAgentVmSandboxBackendFactory(
			{
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId: 'shravan',
			},
			{
				buildExecSpec: vi.fn(async () => ({
					argv: ['ssh'],
					env: {},
					stdinMode: 'pipe-open' as const,
				})),
				createLeaseClient: () => ({
					...createActiveUseLeaseClientMethods(),
					renewLease: async () => createLeaseResponse('lease-renew'),
					peekLease: async () => createLeasePeekResponse(),
					releaseLease: async () => {},
					requestLease: vi.fn(async () => createLeaseResponse('lease-finalize-health')),
				}),
				publishHealthEvent,
				runRemoteShellScript: vi.fn(),
			},
		);

		const backend = await factory({
			agentWorkspaceDir: '/zone/agents/main',
			cfg: agentVmSandboxConfig(),
			scopeKey: 'agent:main',
			sessionKey: 'agent:main:session-finalize-health',
			workspaceDir: '/work',
		});
		const execSpec = await backend.buildExecSpec({
			command: 'pnpm test',
			env: {},
			usePty: false,
		});

		await expect(
			backend.finalizeExec?.({
				status: 'completed',
				exitCode: 0,
				timedOut: false,
				token: execSpec.finalizeToken,
			}),
		).resolves.toBeUndefined();
		expect(publishHealthEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: 'tool-vm-ssh',
				operation: 'finalize',
				zoneId: 'shravan',
			}),
		);
	});

	it('finalizeExec is a no-op when token has no dispose', async () => {
		const factory = createAgentVmSandboxBackendFactory(
			{
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId: 'shravan',
			},
			{
				buildExecSpec: vi.fn(async () => ({
					argv: ['ssh'],
					env: {},
					stdinMode: 'pipe-open' as const,
				})),
				createLeaseClient: () => ({
					...createActiveUseLeaseClientMethods(),
					renewLease: async () => createLeaseResponse('lease-renew'),
					peekLease: async () => createLeasePeekResponse(),
					releaseLease: async () => {},
					requestLease: vi.fn(async () => createLeaseResponse('lease-noop')),
				}),
				runRemoteShellScript: vi.fn(),
			},
		);

		const backend = await factory({
			agentWorkspaceDir: '/zone/agents/main',
			cfg: agentVmSandboxConfig(),
			scopeKey: 'agent:main',
			sessionKey: 'agent:main:session-noop',
			workspaceDir: '/work',
		});

		// Should not throw when token is undefined or has no dispose
		await backend.finalizeExec?.({
			status: 'completed',
			exitCode: 0,
			timedOut: false,
			token: undefined,
		});
		await backend.finalizeExec?.({
			status: 'failed',
			exitCode: 1,
			timedOut: false,
			token: { someOtherField: true },
		});
	});

	it('createFsBridgeBuilder lease context runRemoteShellScript delegates to deps', async () => {
		const runRemoteShellScript = vi.fn(async () => ({
			code: 0,
			stderr: Buffer.from(''),
			stdout: Buffer.from('/work\n'),
		}));
		let capturedLeaseContext: OpenClawFsBridgeLeaseContext | undefined;
		const createFsBridgeBuilder = vi.fn((leaseContext: OpenClawFsBridgeLeaseContext) => {
			capturedLeaseContext = leaseContext;
			return vi.fn(() => createMockFsBridge());
		});

		const factory = createAgentVmSandboxBackendFactory(
			{
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId: 'shravan',
			},
			{
				buildExecSpec: vi.fn(async () => ({
					argv: ['ssh'],
					env: {},
					stdinMode: 'pipe-open' as const,
				})),
				createFsBridgeBuilder,
				createLeaseClient: () => ({
					...createActiveUseLeaseClientMethods(),
					renewLease: async () => createLeaseResponse('lease-renew'),
					peekLease: async () => createLeasePeekResponse(),
					releaseLease: async () => {},
					requestLease: vi.fn(async () => createLeaseResponse('lease-789')),
				}),
				runRemoteShellScript,
			},
		);

		await factory({
			agentWorkspaceDir: '/zone/agents/main',
			cfg: agentVmSandboxConfig(),
			scopeKey: 'agent:main',
			sessionKey: 'agent:main:test',
			workspaceDir: '/work',
		});

		// Call the captured runRemoteShellScript from the lease context
		expect(capturedLeaseContext).toBeDefined();
		if (!capturedLeaseContext) {
			throw new Error('Expected lease context to be captured');
		}
		await capturedLeaseContext.runRemoteShellScript({
			allowFailure: true,
			script: 'cat /etc/hostname',
			signal: new AbortController().signal,
			args: ['/work/file.txt'],
		});

		// Verify it delegates to the deps runRemoteShellScript with the lease SSH creds
		expect(runRemoteShellScript).toHaveBeenCalledWith({
			allowFailure: true,
			script: expect.stringContaining('cat /etc/hostname'),
			signal: expect.any(AbortSignal),
			ssh: {
				host: 'tool-0.vm.host',
				identityPem: 'pem',
				knownHostsLine: 'known-hosts',
				port: 22,
				user: 'sandbox',
			},
		});
	});

	it('rethrows undefined finalize token disposal failures', async () => {
		const factory = createAgentVmSandboxBackendFactory(
			{
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId: 'shravan',
			},
			{
				buildExecSpec: vi.fn(async () => ({
					argv: ['ssh'],
					env: {},
					stdinMode: 'pipe-open' as const,
				})),
				createLeaseClient: () => ({
					...createActiveUseLeaseClientMethods(),
					renewLease: async () => createLeaseResponse('lease-renew'),
					peekLease: async () => createLeasePeekResponse(),
					releaseLease: async () => {},
					requestLease: vi.fn(async () => createLeaseResponse('lease-dispose-throws')),
				}),
				runRemoteShellScript: vi.fn(),
			},
		);
		const backend = await factory({
			agentWorkspaceDir: '/zone/agents/main',
			cfg: agentVmSandboxConfig(),
			scopeKey: 'agent:main',
			sessionKey: 'agent:main:session-dispose-throws',
			workspaceDir: '/work',
		});

		let didThrow = false;
		try {
			await backend.finalizeExec?.({
				exitCode: 1,
				status: 'failed',
				timedOut: false,
				token: {
					dispose: () => {
						throw undefined;
					},
				},
			});
		} catch (error) {
			didThrow = true;
			expect(error).toBeUndefined();
		}

		expect(didThrow).toBe(true);
	});

	it('throws TypeError when the controller returns an invalid lease response', async () => {
		const factory = createAgentVmSandboxBackendFactory(
			{
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId: 'shravan',
			},
			{
				buildExecSpec: vi.fn(),
				createLeaseClient: () => ({
					...createActiveUseLeaseClientMethods(),
					renewLease: async () => createLeaseResponse('lease-renew'),
					peekLease: async () => createLeasePeekResponse(),
					releaseLease: async () => {},
					requestLease: async () =>
						// Return a response missing required fields
						({ unexpected: true }) as never,
				}),
				runRemoteShellScript: vi.fn(),
			},
		);

		await expect(
			factory({
				agentWorkspaceDir: '/zone/agents/main',
				cfg: agentVmSandboxConfig(),
				scopeKey: 'agent:main',
				sessionKey: 'agent:main:test',
				workspaceDir: '/work',
			}),
		).rejects.toThrow('Controller lease API returned an unexpected response.');
	});

	it('keeps filesystem bridging as an OpenClaw adapter concern over the SSH lease', async () => {
		const mockBridge = createMockFsBridge();
		const createFsBridge = vi.fn((_params: { readonly sandbox: unknown }) => mockBridge);
		const createFsBridgeBuilder = vi.fn(
			(_leaseContext: OpenClawFsBridgeLeaseContext) => createFsBridge,
		);
		const factory = createAgentVmSandboxBackendFactory(
			{
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId: 'shravan',
			},
			{
				buildExecSpec: vi.fn(async () => ({
					argv: ['ssh'],
					env: {},
					stdinMode: 'pipe-open' as const,
				})),
				createFsBridgeBuilder,
				createLeaseClient: () => ({
					...createActiveUseLeaseClientMethods(),
					renewLease: async () => createLeaseResponse('lease-renew'),
					peekLease: async () => createLeasePeekResponse(),
					releaseLease: async () => {},
					requestLease: async () => createLeaseResponse('lease-123'),
				}),
				runRemoteShellScript: vi.fn(),
			},
		);

		const backend = await factory({
			agentWorkspaceDir: '/home/openclaw/work',
			cfg: agentVmSandboxConfig(),
			scopeKey: 'agent:main',
			sessionKey: 'agent:main:session-abc',
			workspaceDir: '/home/openclaw/.openclaw/state/sandboxes/work',
		});

		const leaseContext = createFsBridgeBuilder.mock.calls[0]?.[0];
		expect(leaseContext).toEqual(
			expect.objectContaining({
				remoteAgentWorkspaceDir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
				remoteWorkspaceDir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			}),
		);
		expect(typeof leaseContext?.runRemoteShellScript).toBe('function');
		expect(backend.createFsBridge?.({ sandbox: { id: 'sandbox' } })).toBe(mockBridge);
		expect(createFsBridge).toHaveBeenCalledWith({ sandbox: { id: 'sandbox' } });
	});

	it('omits env and createFsBridge from handle when createFsBridgeBuilder is not provided', async () => {
		const requestLease = vi.fn(async () => createLeaseResponse('lease-456'));

		const factory = createAgentVmSandboxBackendFactory(
			{
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId: 'shravan',
			},
			{
				buildExecSpec: vi.fn(async () => ({
					argv: ['ssh'],
					env: {},
					stdinMode: 'pipe-open' as const,
				})),
				createLeaseClient: () => ({
					...createActiveUseLeaseClientMethods(),
					renewLease: async () => createLeaseResponse('lease-renew'),
					peekLease: async () => createLeasePeekResponse(),
					releaseLease: async () => {},
					requestLease,
				}),
				runRemoteShellScript: vi.fn(),
			},
		);

		const backend = await factory({
			agentWorkspaceDir: '/zone/agents/main',
			cfg: agentVmSandboxConfig(),
			scopeKey: 'agent:main',
			sessionKey: 'agent:main:test',
			workspaceDir: '/work',
		});

		expect(backend.env).toBeUndefined();
		expect(backend.createFsBridge).toBeUndefined();
		expect(backend.runtimeId).toBe(testToolVmLeaseId('lease-456'));
	});
});

describe('createAgentVmSandboxBackendManager', () => {
	it('describeRuntime returns running true when peekLease succeeds', async () => {
		const renewLease = vi.fn(async () => {
			throw new Error('describeRuntime should not extend lease idle timers');
		});
		const peekLease = vi.fn(async () => createLeasePeekResponse());
		const manager = createAgentVmSandboxBackendManager(
			{
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId: 'shravan',
			},
			{
				buildExecSpec: vi.fn(),
				createLeaseClient: () => ({
					...createActiveUseLeaseClientMethods(),
					renewLease,
					peekLease,
					releaseLease: vi.fn(async () => {}),
					requestLease: vi.fn(),
				}),
				runRemoteShellScript: vi.fn(),
			},
		);

		const result = await manager.describeRuntime({
			entry: { containerName: 'lease-123' },
		});

		expect(result).toEqual({ running: true, configLabelMatch: true });
		expect(peekLease).toHaveBeenCalledWith('lease-123');
		expect(renewLease).not.toHaveBeenCalled();
	});

	it('describeRuntime returns running false when peekLease returns not found', async () => {
		const manager = createAgentVmSandboxBackendManager(
			{
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId: 'shravan',
			},
			{
				buildExecSpec: vi.fn(),
				createLeaseClient: () => ({
					...createActiveUseLeaseClientMethods(),
					renewLease: vi.fn(),
					peekLease: vi.fn(async () => {
						throw createControllerLeaseError(404);
					}),
					releaseLease: vi.fn(async () => {}),
					requestLease: vi.fn(),
				}),
				runRemoteShellScript: vi.fn(),
			},
		);

		const result = await manager.describeRuntime({
			entry: { containerName: 'gondolin-scope-missing' },
		});

		expect(result).toEqual({ running: false, configLabelMatch: false });
	});

	it('describeRuntime rethrows controller errors other than not found', async () => {
		const manager = createAgentVmSandboxBackendManager(
			{
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId: 'shravan',
			},
			{
				buildExecSpec: vi.fn(),
				createLeaseClient: () => ({
					...createActiveUseLeaseClientMethods(),
					renewLease: vi.fn(),
					peekLease: vi.fn(async () => {
						throw createControllerLeaseError(500);
					}),
					releaseLease: vi.fn(async () => {}),
					requestLease: vi.fn(),
				}),
				runRemoteShellScript: vi.fn(),
			},
		);

		await expect(
			manager.describeRuntime({
				entry: { containerName: 'gondolin-scope-error' },
			}),
		).rejects.toThrow('Controller lease renew API returned HTTP 500');
	});

	it('describeRuntime rethrows network errors instead of treating them as missing leases', async () => {
		const manager = createAgentVmSandboxBackendManager(
			{
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId: 'shravan',
			},
			{
				buildExecSpec: vi.fn(),
				createLeaseClient: () => ({
					...createActiveUseLeaseClientMethods(),
					renewLease: vi.fn(),
					peekLease: vi.fn(async () => {
						throw new Error('temporary controller outage');
					}),
					releaseLease: vi.fn(async () => {}),
					requestLease: vi.fn(),
				}),
				runRemoteShellScript: vi.fn(),
			},
		);

		await expect(
			manager.describeRuntime({
				entry: { containerName: 'gondolin-scope-network-error' },
			}),
		).rejects.toThrow('temporary controller outage');
	});

	it('removeRuntime calls releaseLease with the containerName', async () => {
		const releaseLease = vi.fn(async () => {});
		const manager = createAgentVmSandboxBackendManager(
			{
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId: 'shravan',
			},
			{
				buildExecSpec: vi.fn(),
				createLeaseClient: () => ({
					...createActiveUseLeaseClientMethods(),
					renewLease: vi.fn(),
					peekLease: vi.fn(async () => createLeasePeekResponse()),
					releaseLease,
					requestLease: vi.fn(),
				}),
				runRemoteShellScript: vi.fn(),
			},
		);

		await manager.removeRuntime({
			entry: { containerName: 'gondolin-scope-remove' },
		});

		expect(releaseLease).toHaveBeenCalledWith('gondolin-scope-remove', { force: true });
	});
});
