import { describe, expect, it, vi } from 'vitest';

import {
	createGondolinSandboxBackendFactory,
	createGondolinSandboxBackendManager,
	type FsBridgeLeaseContext,
	type GondolinFsBridge,
} from './sandbox-backend-factory.js';

function createMockFsBridge(): GondolinFsBridge {
	return {
		mkdirp: vi.fn(async () => {}),
		readFile: vi.fn(async () => Buffer.from('file-content')),
		remove: vi.fn(async () => {}),
		rename: vi.fn(async () => {}),
		resolvePath: vi.fn(() => ({ containerPath: '/workspace/file.txt', relativePath: 'file.txt' })),
		stat: vi.fn(async () => ({ mtimeMs: 1000, size: 42, type: 'file' as const })),
		writeFile: vi.fn(async () => {}),
	};
}

describe('createGondolinSandboxBackendFactory', () => {
	it('requests a lease and exposes an ssh-backed sandbox handle with fs bridge', async () => {
		const requestLease = vi.fn(async () => ({
			leaseId: 'lease-123',
			ssh: {
				host: 'tool-0.vm.host',
				identityPem: 'pem',
				knownHostsLine: 'known-hosts',
				port: 22,
				user: 'sandbox',
			},
			tcpSlot: 0,
			workdir: '/workspace',
		}));
		const runRemoteShellScript = vi.fn(async () => ({
			code: 0,
			stderr: Buffer.from(''),
			stdout: Buffer.from('ok'),
		}));
		const mockBridge = createMockFsBridge();
		const createFsBridgeBuilder = vi.fn((_leaseContext: FsBridgeLeaseContext) =>
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
				zoneId: 'shravan',
			},
			{
				buildExecSpec,
				createFsBridgeBuilder,
				createLeaseClient: () => ({
					getLeaseStatus: async () => ({ ok: true }),
					releaseLease: async () => {},
					requestLease,
				}),
				runRemoteShellScript,
			},
		);

		const backend = await factory({
			agentWorkspaceDir: '/home/openclaw/workspace',
			cfg: {
				docker: {
					env: {
						OPENCLAW_LOG_LEVEL: 'debug',
					},
				},
			},
			scopeKey: 'agent:main:session-abc',
			sessionKey: 'session-abc',
			workspaceDir: '/home/openclaw/.openclaw/sandboxes/workspace',
		});

		const execSpec = await backend.buildExecSpec({
			command: 'ls -la',
			env: {
				TEST_ENV: '1',
			},
			usePty: false,
			workdir: '/workspace',
		});
		const commandResult = await backend.runShellCommand({
			script: 'pwd',
		});

		expect(requestLease).toHaveBeenCalledWith({
			agentWorkspaceDir: '/home/openclaw/workspace',
			profileId: 'standard',
			scopeKey: 'agent:main:session-abc',
			workspaceDir: '/home/openclaw/.openclaw/sandboxes/workspace',
			zoneId: 'shravan',
		});
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
			workdir: '/workspace',
		});
		expect(execSpec.argv).toEqual(['ssh', 'tool-0.vm.host']);
		expect(commandResult.code).toBe(0);

		// Verify createFsBridgeBuilder was called with lease context
		expect(createFsBridgeBuilder).toHaveBeenCalledWith(
			expect.objectContaining({
				remoteWorkspaceDir: '/workspace',
				remoteAgentWorkspaceDir: '/workspace',
			}),
		);
		// Verify the lease context includes a runRemoteShellScript bound to lease SSH
		const leaseContext = createFsBridgeBuilder.mock.calls[0]?.[0] as FsBridgeLeaseContext;
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

	it('reuses the same handle for the same scopeKey (scope-based VM reuse)', async () => {
		const requestLease = vi.fn(async () => ({
			leaseId: 'lease-reuse',
			ssh: {
				host: 'tool-0.vm.host',
				identityPem: 'pem',
				knownHostsLine: '',
				port: 22,
				user: 'sandbox',
			},
			tcpSlot: 0,
			workdir: '/workspace',
		}));

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
					getLeaseStatus: async () => ({ ok: true }),
					releaseLease: async () => {},
					requestLease,
				}),
				runRemoteShellScript: vi.fn(),
			},
		);

		const firstHandle = await factory({
			agentWorkspaceDir: '/workspace',
			cfg: {},
			scopeKey: 'agent:main:session-reuse',
			sessionKey: 'session-reuse',
			workspaceDir: '/workspace',
		});
		const secondHandle = await factory({
			agentWorkspaceDir: '/workspace',
			cfg: {},
			scopeKey: 'agent:main:session-reuse',
			sessionKey: 'session-reuse',
			workspaceDir: '/workspace',
		});

		expect(firstHandle).toBe(secondHandle);
		expect(requestLease).toHaveBeenCalledTimes(1);
	});

	it('creates separate handles for different scopeKeys', async () => {
		let leaseCounter = 0;
		const requestLease = vi.fn(async () => {
			leaseCounter++;
			return {
				leaseId: `lease-${leaseCounter}`,
				ssh: {
					host: 'tool-0.vm.host',
					identityPem: 'pem',
					knownHostsLine: '',
					port: 22,
					user: 'sandbox',
				},
				tcpSlot: 0,
				workdir: '/workspace',
			};
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
					getLeaseStatus: async () => ({ ok: true }),
					releaseLease: async () => {},
					requestLease,
				}),
				runRemoteShellScript: vi.fn(),
			},
		);

		const handleA = await factory({
			agentWorkspaceDir: '/workspace',
			cfg: {},
			scopeKey: 'scope-a',
			sessionKey: 'session-a',
			workspaceDir: '/workspace',
		});
		const handleB = await factory({
			agentWorkspaceDir: '/workspace',
			cfg: {},
			scopeKey: 'scope-b',
			sessionKey: 'session-b',
			workspaceDir: '/workspace',
		});

		expect(handleA).not.toBe(handleB);
		expect(handleA.runtimeId).toBe('lease-1');
		expect(handleB.runtimeId).toBe('lease-2');
		expect(requestLease).toHaveBeenCalledTimes(2);
	});

	it('requests a new lease when the cached scope handle points at a stale lease', async () => {
		let leaseCounter = 0;
		const getLeaseStatus = vi.fn(async (leaseId: string) => {
			if (leaseId === 'lease-1') {
				throw new Error('stale');
			}
			return { status: 'active' };
		});
		const requestLease = vi.fn(async () => {
			leaseCounter += 1;
			return {
				leaseId: `lease-${leaseCounter}`,
				ssh: {
					host: 'tool-0.vm.host',
					identityPem: 'pem',
					knownHostsLine: '',
					port: 22,
					user: 'sandbox',
				},
				tcpSlot: 0,
				workdir: '/workspace',
			};
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
					getLeaseStatus,
					releaseLease: async () => {},
					requestLease,
				}),
				runRemoteShellScript: vi.fn(),
			},
		);

		const firstHandle = await factory({
			agentWorkspaceDir: '/workspace',
			cfg: {},
			scopeKey: 'scope-stale',
			sessionKey: 'session-stale',
			workspaceDir: '/workspace',
		});
		const secondHandle = await factory({
			agentWorkspaceDir: '/workspace',
			cfg: {},
			scopeKey: 'scope-stale',
			sessionKey: 'session-stale',
			workspaceDir: '/workspace',
		});

		expect(firstHandle).not.toBe(secondHandle);
		expect(requestLease).toHaveBeenCalledTimes(2);
		expect(getLeaseStatus).toHaveBeenCalledWith('lease-1');
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
					getLeaseStatus: async () => ({ ok: true }),
					releaseLease: async () => {},
					requestLease: vi.fn(async () => ({
						leaseId: 'lease-finalize',
						ssh: { host: 'h', identityPem: 'p', knownHostsLine: '', port: 22, user: 'u' },
						tcpSlot: 0,
						workdir: '/w',
					})),
				}),
				runRemoteShellScript: vi.fn(),
			},
		);

		const backend = await factory({
			agentWorkspaceDir: '/workspace',
			cfg: {},
			scopeKey: 'finalize-test',
			sessionKey: 'session-finalize',
			workspaceDir: '/workspace',
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
					getLeaseStatus: async () => ({ ok: true }),
					releaseLease: async () => {},
					requestLease: vi.fn(async () => ({
						leaseId: 'lease-noop',
						ssh: { host: 'h', identityPem: 'p', knownHostsLine: '', port: 22, user: 'u' },
						tcpSlot: 0,
						workdir: '/w',
					})),
				}),
				runRemoteShellScript: vi.fn(),
			},
		);

		const backend = await factory({
			agentWorkspaceDir: '/workspace',
			cfg: {},
			scopeKey: 'noop-finalize',
			sessionKey: 'session-noop',
			workspaceDir: '/workspace',
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
			stdout: Buffer.from('/workspace\n'),
		}));
		let capturedLeaseContext: FsBridgeLeaseContext | undefined;
		const createFsBridgeBuilder = vi.fn((leaseContext: FsBridgeLeaseContext) => {
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
					getLeaseStatus: async () => ({ ok: true }),
					releaseLease: async () => {},
					requestLease: vi.fn(async () => ({
						leaseId: 'lease-789',
						ssh: {
							host: 'tool-0.vm.host',
							identityPem: 'pem',
							knownHostsLine: '',
							port: 22,
							user: 'sandbox',
						},
						tcpSlot: 0,
						workdir: '/workspace',
					})),
				}),
				runRemoteShellScript,
			},
		);

		await factory({
			agentWorkspaceDir: '/workspace',
			cfg: {},
			scopeKey: 'test',
			sessionKey: 'test',
			workspaceDir: '/workspace',
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
			args: ['/workspace/file.txt'],
		});

		// Verify it delegates to the deps runRemoteShellScript with the lease SSH creds
		expect(runRemoteShellScript).toHaveBeenCalledWith({
			allowFailure: true,
			script: expect.stringContaining('cat /etc/hostname'),
			signal: expect.any(AbortSignal),
			ssh: {
				host: 'tool-0.vm.host',
				identityPem: 'pem',
				knownHostsLine: '',
				port: 22,
				user: 'sandbox',
			},
		});
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
					getLeaseStatus: async () => ({ ok: true }),
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
				agentWorkspaceDir: '/workspace',
				cfg: {},
				scopeKey: 'test',
				sessionKey: 'test',
				workspaceDir: '/workspace',
			}),
		).rejects.toThrow('Controller lease API returned an unexpected response.');
	});

	it('omits env and createFsBridge from handle when createFsBridgeBuilder is not provided', async () => {
		const requestLease = vi.fn(async () => ({
			leaseId: 'lease-456',
			ssh: {
				host: 'tool-0.vm.host',
				identityPem: 'pem',
				knownHostsLine: '',
				port: 22,
				user: 'sandbox',
			},
			tcpSlot: 1,
			workdir: '/workspace',
		}));

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
					getLeaseStatus: async () => ({ ok: true }),
					releaseLease: async () => {},
					requestLease,
				}),
				runRemoteShellScript: vi.fn(),
			},
		);

		const backend = await factory({
			agentWorkspaceDir: '/workspace',
			cfg: {},
			scopeKey: 'test',
			sessionKey: 'test',
			workspaceDir: '/workspace',
		});

		expect(backend.env).toBeUndefined();
		expect(backend.createFsBridge).toBeUndefined();
		expect(backend.runtimeId).toBe('lease-456');
	});
});

describe('createGondolinSandboxBackendManager', () => {
	it('describeRuntime returns running true when getLeaseStatus succeeds', async () => {
		const getLeaseStatus = vi.fn(async () => ({ status: 'active' }));
		const manager = createGondolinSandboxBackendManager(
			{
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId: 'shravan',
			},
			{
				buildExecSpec: vi.fn(),
				createLeaseClient: () => ({
					getLeaseStatus,
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
		expect(getLeaseStatus).toHaveBeenCalledWith('lease-123');
	});

	it('describeRuntime returns running false when getLeaseStatus throws', async () => {
		const manager = createGondolinSandboxBackendManager(
			{
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId: 'shravan',
			},
			{
				buildExecSpec: vi.fn(),
				createLeaseClient: () => ({
					getLeaseStatus: vi.fn(async () => {
						throw new Error('not found');
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
					getLeaseStatus: vi.fn(),
					releaseLease,
					requestLease: vi.fn(),
				}),
				runRemoteShellScript: vi.fn(),
			},
		);

		await manager.removeRuntime({
			entry: { containerName: 'gondolin-scope-remove' },
		});

		expect(releaseLease).toHaveBeenCalledWith('gondolin-scope-remove');
	});
});
