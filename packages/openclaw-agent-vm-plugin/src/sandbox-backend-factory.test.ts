import { describe, expect, it, vi } from 'vitest';

import { ControllerLeaseRequestError, type LeaseClient } from './controller-lease-client.js';
import {
	createGondolinSandboxBackendFactory,
	createGondolinSandboxBackendManager,
	type OpenClawFsBridgeLeaseContext,
	type OpenClawSandboxFsBridge,
} from './sandbox-backend-factory.js';

const OPENCLAW_TOOL_VM_WORKSPACE_MOUNT = '/workspace';

function createLeaseResponse(
	leaseId: string,
	options: {
		readonly agentId?: string;
		readonly idleTtlMs?: number;
		readonly scopeKey?: string;
	} = {},
): {
	readonly agentId: string;
	readonly idleTtlMs?: number;
	readonly leaseId: string;
	readonly scopeKey: string;
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
	return {
		agentId: options.agentId ?? 'main',
		...(options.idleTtlMs !== undefined ? { idleTtlMs: options.idleTtlMs } : {}),
		leaseId,
		scopeKey: options.scopeKey ?? 'agent:main',
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
	readonly lastUsedAt: number;
	readonly leaseId: string;
	readonly profileId: string;
	readonly scopeKey: string;
	readonly ssh: { readonly host: string; readonly port: number; readonly user: string };
	readonly tcpSlot: number;
	readonly transport: 'ssh-sandbox';
	readonly workdir: string;
	readonly zoneId: string;
} {
	return {
		agentId: 'main',
		createdAt: 1,
		lastUsedAt: 1,
		leaseId,
		profileId: 'standard',
		scopeKey: 'scope',
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
	'startActiveUse' | 'heartbeatActiveUse' | 'endActiveUse'
> {
	return {
		endActiveUse: vi.fn(async () => {}),
		heartbeatActiveUse: vi.fn(async () => ({
			expiresAt: 2_000,
			heartbeatAfterMs: 1_000,
		})),
		startActiveUse: vi.fn(async (_leaseId, request) => ({
			useId: request.useId,
			expiresAt: 2_000,
			heartbeatAfterMs: 1_000,
		})),
	};
}

function gondolinSandboxConfig(
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

describe('createGondolinSandboxBackendFactory', () => {
	it('rejects unsupported OpenClaw sandbox config before requesting a lease', async () => {
		const requestLease = vi.fn(async () => createLeaseResponse('lease-123'));
		const factory = createGondolinSandboxBackendFactory(
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

		await expect(
			factory({
				agentWorkspaceDir: '/work',
				cfg: gondolinSandboxConfig({ scope: 'session' }),
				scopeKey: 'agent:main',
				sessionKey: 'agent:main:session-abc',
				workspaceDir: '/work',
			}),
		).rejects.toThrow('OpenClaw Gondolin sandbox requires scope=agent; received session.');
		expect(requestLease).not.toHaveBeenCalled();
	});

	it('passes arbitrary scope provenance under the resolved OpenClaw agent', async () => {
		const requestLease = vi.fn(async () =>
			createLeaseResponse('shravan-main-100', {
				agentId: 'main',
				scopeKey: 'agent:beta',
			}),
		);
		const factory = createGondolinSandboxBackendFactory(
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

		await factory({
			agentWorkspaceDir: '/work',
			cfg: gondolinSandboxConfig(),
			scopeKey: 'agent:beta',
			sessionKey: 'agent:main:session-abc',
			workspaceDir: '/work',
		});

		expect(requestLease).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: 'main',
				scopeKey: 'agent:beta',
				sessionKey: 'agent:main:session-abc',
			}),
		);
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

		const factory = createGondolinSandboxBackendFactory(
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
					publishOpenClawRuntimeStatus,
					releaseLease: async () => {},
					requestLease,
				}),
				runRemoteShellScript,
			},
		);

		const backend = await factory({
			agentWorkspaceDir: '/home/openclaw/work',
			cfg: {
				...gondolinSandboxConfig(),
				docker: {
					env: {
						OPENCLAW_LOG_LEVEL: 'debug',
					},
				},
			},
			scopeKey: 'agent:main',
			sessionKey: 'session-abc',
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
			sandbox: gondolinSandboxConfig(),
			scopeKey: 'agent:main',
			sessionKey: 'session-abc',
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

		expect(backend.runtimeId).toBe('lease-123');
		expect(backend.runtimeLabel).toBe('lease-123');
		expect(backend.configLabel).toBe('http://controller.vm.host:18800 (shravan)');
		expect(backend.configLabelKind).toBe('VM');
		expect(typeof backend.finalizeExec).toBe('function');
	});

	it('reuses the same handle for repeated requests from the same agent', async () => {
		const requestLease = vi.fn(async () => createLeaseResponse('lease-reuse'));

		const factory = createGondolinSandboxBackendFactory(
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

		const firstHandle = await factory({
			agentWorkspaceDir: '/work',
			cfg: gondolinSandboxConfig(),
			scopeKey: 'agent:main',
			sessionKey: 'session-reuse',
			workspaceDir: '/work',
		});
		const secondHandle = await factory({
			agentWorkspaceDir: '/work',
			cfg: gondolinSandboxConfig(),
			scopeKey: 'agent:main',
			sessionKey: 'session-reuse',
			workspaceDir: '/work',
		});

		expect(firstHandle).toBe(secondHandle);
		expect(requestLease).toHaveBeenCalledTimes(1);
	});

	it('reuses one handle for channel-shaped scopes under the same agent', async () => {
		const requestLease = vi.fn(async () =>
			createLeaseResponse('shravan-beta-100', {
				agentId: 'beta',
				scopeKey: 'agent:beta:discord:channel:123',
			}),
		);

		const factory = createGondolinSandboxBackendFactory(
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

		const firstHandle = await factory({
			agentWorkspaceDir: '/workspace/beta',
			cfg: gondolinSandboxConfig(),
			scopeKey: 'agent:beta:discord:channel:123',
			sessionKey: 'agent:beta:discord:channel:123',
			workspaceDir: '/workspace/beta',
		});
		const secondHandle = await factory({
			agentWorkspaceDir: '/workspace/beta',
			cfg: gondolinSandboxConfig(),
			scopeKey: 'agent:beta:discord:channel:999',
			sessionKey: 'agent:beta:discord:channel:999',
			workspaceDir: '/workspace/beta',
		});

		expect(secondHandle).toBe(firstHandle);
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
			.mockResolvedValueOnce({ ok: true })
			.mockRejectedValueOnce(createControllerLeaseError(404));

		const factory = createGondolinSandboxBackendFactory(
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
				agentWorkspaceDir: '/work',
				cfg: gondolinSandboxConfig(),
				scopeKey: 'agent:main',
				sessionKey: 'session-stale',
				workspaceDir: '/work',
			});
			const secondHandle = await factory({
				agentWorkspaceDir: '/work',
				cfg: gondolinSandboxConfig(),
				scopeKey: 'agent:main',
				sessionKey: 'session-stale',
				workspaceDir: '/work',
			});
			const thirdHandle = await factory({
				agentWorkspaceDir: '/work',
				cfg: gondolinSandboxConfig(),
				scopeKey: 'agent:main',
				sessionKey: 'session-stale',
				workspaceDir: '/work',
			});

			expect(firstHandle).toBe(secondHandle);
			expect(thirdHandle).not.toBe(firstHandle);
			expect(requestLease).toHaveBeenCalledTimes(2);
			const loggedMessages = stderrWrite.mock.calls.map(([message]) => String(message));
			expect(
				loggedMessages.some(
					(message) =>
						message.includes('lease renew failed') &&
						message.includes("scope 'agent:main'") &&
						message.includes("lease 'lease-old'"),
				),
			).toBe(true);
		} finally {
			stderrWrite.mockRestore();
		}
	});

	it('does not request a fresh lease when cached renew returns a client error other than 404', async () => {
		const requestLease = vi.fn(async () => createLeaseResponse('lease-client-error'));
		const renewLease = vi.fn().mockRejectedValueOnce(createControllerLeaseError(409));

		const factory = createGondolinSandboxBackendFactory(
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
			agentWorkspaceDir: '/work',
			cfg: gondolinSandboxConfig(),
			scopeKey: 'agent:main',
			sessionKey: 'session-client-error',
			workspaceDir: '/work',
		});

		await expect(
			factory({
				agentWorkspaceDir: '/work',
				cfg: gondolinSandboxConfig(),
				scopeKey: 'agent:main',
				sessionKey: 'session-client-error',
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

		const factory = createGondolinSandboxBackendFactory(
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
			agentWorkspaceDir: '/work',
			cfg: gondolinSandboxConfig(),
			scopeKey: 'agent:main',
			sessionKey: 'session-server-error',
			workspaceDir: '/work',
		});

		await expect(
			factory({
				agentWorkspaceDir: '/work',
				cfg: gondolinSandboxConfig(),
				scopeKey: 'agent:main',
				sessionKey: 'session-server-error',
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

		const factory = createGondolinSandboxBackendFactory(
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
			agentWorkspaceDir: '/work',
			cfg: gondolinSandboxConfig(),
			scopeKey: 'agent:main',
			sessionKey: 'session-network-error',
			workspaceDir: '/work',
		});

		await expect(
			factory({
				agentWorkspaceDir: '/work',
				cfg: gondolinSandboxConfig(),
				scopeKey: 'agent:main',
				sessionKey: 'session-network-error',
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

		const factory = createGondolinSandboxBackendFactory(
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
			agentWorkspaceDir: '/work',
			cfg: gondolinSandboxConfig(),
			scopeKey: 'agent:alpha',
			sessionKey: 'agent:alpha:session-a',
			workspaceDir: '/work',
		});
		const handleB = await factory({
			agentWorkspaceDir: '/work',
			cfg: gondolinSandboxConfig(),
			scopeKey: 'agent:beta',
			sessionKey: 'agent:beta:session-b',
			workspaceDir: '/work',
		});

		expect(handleA).not.toBe(handleB);
		expect(handleA.runtimeId).toBe('lease-1');
		expect(handleB.runtimeId).toBe('lease-2');
		expect(requestLease).toHaveBeenCalledTimes(2);
	});

	it('requests a new lease when the cached scope handle points at a missing lease', async () => {
		let leaseCounter = 0;
		const renewLease = vi.fn(async (leaseId: string) => {
			if (leaseId === 'lease-1') {
				throw createControllerLeaseError(404);
			}
			return createLeaseResponse(leaseId);
		});
		const requestLease = vi.fn(async () => {
			leaseCounter += 1;
			return createLeaseResponse(`lease-${leaseCounter}`);
		});

		const factory = createGondolinSandboxBackendFactory(
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
			agentWorkspaceDir: '/work',
			cfg: gondolinSandboxConfig(),
			scopeKey: 'agent:main',
			sessionKey: 'session-stale',
			workspaceDir: '/work',
		});
		const secondHandle = await factory({
			agentWorkspaceDir: '/work',
			cfg: gondolinSandboxConfig(),
			scopeKey: 'agent:main',
			sessionKey: 'session-stale',
			workspaceDir: '/work',
		});

		expect(firstHandle).not.toBe(secondHandle);
		expect(requestLease).toHaveBeenCalledTimes(2);
		expect(renewLease).toHaveBeenCalledWith('lease-1');
		expect(secondHandle.runtimeId).toBe('lease-2');
	});

	it('finalizeExec calls dispose on token when dispose is present', async () => {
		const factory = createGondolinSandboxBackendFactory(
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
			agentWorkspaceDir: '/work',
			cfg: gondolinSandboxConfig(),
			scopeKey: 'agent:main',
			sessionKey: 'session-finalize',
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

	it('finalizeExec is a no-op when token has no dispose', async () => {
		const factory = createGondolinSandboxBackendFactory(
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
			agentWorkspaceDir: '/work',
			cfg: gondolinSandboxConfig(),
			scopeKey: 'agent:main',
			sessionKey: 'session-noop',
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

		const factory = createGondolinSandboxBackendFactory(
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
			agentWorkspaceDir: '/work',
			cfg: gondolinSandboxConfig(),
			scopeKey: 'agent:main',
			sessionKey: 'test',
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
		const factory = createGondolinSandboxBackendFactory(
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
			agentWorkspaceDir: '/work',
			cfg: gondolinSandboxConfig(),
			scopeKey: 'agent:main',
			sessionKey: 'session-dispose-throws',
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
		const factory = createGondolinSandboxBackendFactory(
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
				agentWorkspaceDir: '/work',
				cfg: gondolinSandboxConfig(),
				scopeKey: 'agent:main',
				sessionKey: 'test',
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
		const factory = createGondolinSandboxBackendFactory(
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
			cfg: gondolinSandboxConfig(),
			scopeKey: 'agent:main',
			sessionKey: 'session-abc',
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

		const factory = createGondolinSandboxBackendFactory(
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
			agentWorkspaceDir: '/work',
			cfg: gondolinSandboxConfig(),
			scopeKey: 'agent:main',
			sessionKey: 'test',
			workspaceDir: '/work',
		});

		expect(backend.env).toBeUndefined();
		expect(backend.createFsBridge).toBeUndefined();
		expect(backend.runtimeId).toBe('lease-456');
	});
});

describe('createGondolinSandboxBackendManager', () => {
	it('describeRuntime returns running true when peekLease succeeds', async () => {
		const renewLease = vi.fn(async () => {
			throw new Error('describeRuntime should not extend lease idle timers');
		});
		const peekLease = vi.fn(async () => createLeasePeekResponse());
		const manager = createGondolinSandboxBackendManager(
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
		const manager = createGondolinSandboxBackendManager(
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
		const manager = createGondolinSandboxBackendManager(
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
		const manager = createGondolinSandboxBackendManager(
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
		const manager = createGondolinSandboxBackendManager(
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
