import { describe, expect, it, vi } from 'vitest';

import { ControllerLeaseRequestError } from './controller-lease-client.js';
import {
	createGondolinSandboxBackendFactory,
	createGondolinSandboxBackendManager,
	type FsBridgeLeaseContext,
	type GondolinFsBridge,
} from './sandbox-backend-factory.js';

function createLeaseResponse(leaseId: string): {
	readonly leaseId: string;
	readonly ssh: {
		readonly host: string;
		readonly identityPem: string;
		readonly knownHostsLine: string;
		readonly port: number;
		readonly user: string;
	};
	readonly tcpSlot: number;
	readonly workdir: string;
} {
	return {
		leaseId,
		ssh: {
			host: 'tool-0.vm.host',
			identityPem: 'pem',
			knownHostsLine: 'known-hosts',
			port: 22,
			user: 'sandbox',
		},
		tcpSlot: 0,
		workdir: '/work',
	};
}

function createLeasePeekResponse(leaseId: string = 'lease-123'): {
	readonly createdAt: number;
	readonly lastUsedAt: number;
	readonly leaseId: string;
	readonly profileId: string;
	readonly scopeKey: string;
	readonly ssh: { readonly host: string; readonly port: number; readonly user: string };
	readonly tcpSlot: number;
	readonly zoneId: string;
} {
	return {
		createdAt: 1,
		lastUsedAt: 1,
		leaseId,
		profileId: 'standard',
		scopeKey: 'scope',
		ssh: { host: 'tool-0.vm.host', port: 22, user: 'sandbox' },
		tcpSlot: 0,
		zoneId: 'shravan',
	};
}

function createMockFsBridge(): GondolinFsBridge {
	return {
		mkdirp: vi.fn(async () => {}),
		readFile: vi.fn(async () => Buffer.from('file-content')),
		remove: vi.fn(async () => {}),
		rename: vi.fn(async () => {}),
		resolvePath: vi.fn(() => ({ containerPath: '/work/file.txt', relativePath: 'file.txt' })),
		stat: vi.fn(async () => ({ mtimeMs: 1000, size: 42, type: 'file' as const })),
		writeFile: vi.fn(async () => {}),
	};
}

function createControllerLeaseError(status: number): ControllerLeaseRequestError {
	return new ControllerLeaseRequestError({
		bodyText: JSON.stringify({ error: 'lease-error' }),
		context: 'Controller lease keepalive API',
		responseBody: { error: 'lease-error' },
		status,
	});
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
			workdir: '/work',
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
				profileId: 'gpu',
				zoneId: 'shravan',
			},
			{
				buildExecSpec,
				createFsBridgeBuilder,
				createLeaseClient: () => ({
					keepLeaseAlive: async () => createLeaseResponse('lease-keepalive'),
					peekLease: async () => createLeasePeekResponse(),
					releaseLease: async () => {},
					requestLease,
				}),
				runRemoteShellScript,
			},
		);

		const backend = await factory({
			agentWorkspaceDir: '/home/openclaw/work',
			cfg: {
				docker: {
					env: {
						OPENCLAW_LOG_LEVEL: 'debug',
					},
				},
			},
			scopeKey: 'agent:main:session-abc',
			sessionKey: 'session-abc',
			workspaceDir: '/home/openclaw/.openclaw/state/sandboxes/work',
		});

		const execSpec = await backend.buildExecSpec({
			command: 'ls -la',
			env: {
				TEST_ENV: '1',
			},
			usePty: false,
			workdir: '/work',
		});
		const commandResult = await backend.runShellCommand({
			script: 'pwd',
		});

		expect(requestLease).toHaveBeenCalledWith({
			agentWorkspaceDir: '/home/openclaw/work',
			profileId: 'gpu',
			scopeKey: 'agent:main:session-abc',
			workMountDir: '/home/openclaw/.openclaw/state/sandboxes/work',
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
			workdir: '/work',
		});
		expect(execSpec.argv).toEqual(['ssh', 'tool-0.vm.host']);
		expect(commandResult.code).toBe(0);

		// Verify createFsBridgeBuilder was called with lease context
		expect(createFsBridgeBuilder).toHaveBeenCalledWith(
			expect.objectContaining({
				remoteWorkspaceDir: '/work',
				remoteAgentWorkspaceDir: '/work',
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
			workdir: '/work',
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
					keepLeaseAlive: async () => createLeaseResponse('lease-keepalive'),
					peekLease: async () => createLeasePeekResponse(),
					releaseLease: async () => {},
					requestLease,
				}),
				runRemoteShellScript: vi.fn(),
			},
		);

		const firstHandle = await factory({
			agentWorkspaceDir: '/work',
			cfg: {},
			scopeKey: 'agent:main:session-reuse',
			sessionKey: 'session-reuse',
			workspaceDir: '/work',
		});
		const secondHandle = await factory({
			agentWorkspaceDir: '/work',
			cfg: {},
			scopeKey: 'agent:main:session-reuse',
			sessionKey: 'session-reuse',
			workspaceDir: '/work',
		});

		expect(firstHandle).toBe(secondHandle);
		expect(requestLease).toHaveBeenCalledTimes(1);
	});

	it('drops a cached handle when lease keepalive returns 404 and requests a fresh lease', async () => {
		const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		const requestLease = vi
			.fn()
			.mockResolvedValueOnce({
				leaseId: 'lease-old',
				ssh: {
					host: 'tool-0.vm.host',
					identityPem: 'pem',
					knownHostsLine: '',
					port: 22,
					user: 'sandbox',
				},
				tcpSlot: 0,
				workdir: '/work',
			})
			.mockResolvedValueOnce({
				leaseId: 'lease-new',
				ssh: {
					host: 'tool-1.vm.host',
					identityPem: 'pem',
					knownHostsLine: '',
					port: 22,
					user: 'sandbox',
				},
				tcpSlot: 1,
				workdir: '/work',
			});
		const keepLeaseAlive = vi
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
					keepLeaseAlive,
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
				cfg: {},
				scopeKey: 'agent:main:session-stale',
				sessionKey: 'session-stale',
				workspaceDir: '/work',
			});
			const secondHandle = await factory({
				agentWorkspaceDir: '/work',
				cfg: {},
				scopeKey: 'agent:main:session-stale',
				sessionKey: 'session-stale',
				workspaceDir: '/work',
			});
			const thirdHandle = await factory({
				agentWorkspaceDir: '/work',
				cfg: {},
				scopeKey: 'agent:main:session-stale',
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
						message.includes('lease keepalive failed') &&
						message.includes("scope 'agent:main:session-stale'") &&
						message.includes("lease 'lease-old'"),
				),
			).toBe(true);
		} finally {
			stderrWrite.mockRestore();
		}
	});

	it('does not request a fresh lease when cached keepalive returns a client error other than 404', async () => {
		const requestLease = vi.fn(async () => createLeaseResponse('lease-client-error'));
		const keepLeaseAlive = vi.fn().mockRejectedValueOnce(createControllerLeaseError(409));

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
					keepLeaseAlive,
					peekLease: async () => createLeasePeekResponse(),
					releaseLease: async () => {},
					requestLease,
				}),
				runRemoteShellScript: vi.fn(),
			},
		);

		await factory({
			agentWorkspaceDir: '/work',
			cfg: {},
			scopeKey: 'scope-client-error',
			sessionKey: 'session-client-error',
			workspaceDir: '/work',
		});

		await expect(
			factory({
				agentWorkspaceDir: '/work',
				cfg: {},
				scopeKey: 'scope-client-error',
				sessionKey: 'session-client-error',
				workspaceDir: '/work',
			}),
		).rejects.toMatchObject({
			status: 409,
		} satisfies Partial<ControllerLeaseRequestError>);
		expect(requestLease).toHaveBeenCalledTimes(1);
	});

	it('does not request a fresh lease when cached keepalive returns a server error', async () => {
		const requestLease = vi.fn(async () => createLeaseResponse('lease-server-error'));
		const keepLeaseAlive = vi.fn().mockRejectedValueOnce(createControllerLeaseError(503));

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
					keepLeaseAlive,
					peekLease: async () => createLeasePeekResponse(),
					releaseLease: async () => {},
					requestLease,
				}),
				runRemoteShellScript: vi.fn(),
			},
		);

		await factory({
			agentWorkspaceDir: '/work',
			cfg: {},
			scopeKey: 'scope-server-error',
			sessionKey: 'session-server-error',
			workspaceDir: '/work',
		});

		await expect(
			factory({
				agentWorkspaceDir: '/work',
				cfg: {},
				scopeKey: 'scope-server-error',
				sessionKey: 'session-server-error',
				workspaceDir: '/work',
			}),
		).rejects.toMatchObject({
			status: 503,
		} satisfies Partial<ControllerLeaseRequestError>);
		expect(requestLease).toHaveBeenCalledTimes(1);
	});

	it('does not request a fresh lease when cached keepalive has a network failure', async () => {
		const requestLease = vi.fn(async () => createLeaseResponse('lease-network-error'));
		const keepLeaseAlive = vi.fn().mockRejectedValueOnce(new Error('temporary network failure'));

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
					keepLeaseAlive,
					peekLease: async () => createLeasePeekResponse(),
					releaseLease: async () => {},
					requestLease,
				}),
				runRemoteShellScript: vi.fn(),
			},
		);

		await factory({
			agentWorkspaceDir: '/work',
			cfg: {},
			scopeKey: 'scope-network-error',
			sessionKey: 'session-network-error',
			workspaceDir: '/work',
		});

		await expect(
			factory({
				agentWorkspaceDir: '/work',
				cfg: {},
				scopeKey: 'scope-network-error',
				sessionKey: 'session-network-error',
				workspaceDir: '/work',
			}),
		).rejects.toThrow('temporary network failure');
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
				workdir: '/work',
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
					keepLeaseAlive: async () => createLeaseResponse('lease-keepalive'),
					peekLease: async () => createLeasePeekResponse(),
					releaseLease: async () => {},
					requestLease,
				}),
				runRemoteShellScript: vi.fn(),
			},
		);

		const handleA = await factory({
			agentWorkspaceDir: '/work',
			cfg: {},
			scopeKey: 'scope-a',
			sessionKey: 'session-a',
			workspaceDir: '/work',
		});
		const handleB = await factory({
			agentWorkspaceDir: '/work',
			cfg: {},
			scopeKey: 'scope-b',
			sessionKey: 'session-b',
			workspaceDir: '/work',
		});

		expect(handleA).not.toBe(handleB);
		expect(handleA.runtimeId).toBe('lease-1');
		expect(handleB.runtimeId).toBe('lease-2');
		expect(requestLease).toHaveBeenCalledTimes(2);
	});

	it('requests a new lease when the cached scope handle points at a missing lease', async () => {
		let leaseCounter = 0;
		const keepLeaseAlive = vi.fn(async (leaseId: string) => {
			if (leaseId === 'lease-1') {
				throw createControllerLeaseError(404);
			}
			return createLeaseResponse(leaseId);
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
				workdir: '/work',
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
					keepLeaseAlive,
					peekLease: async () => createLeasePeekResponse(),
					releaseLease: async () => {},
					requestLease,
				}),
				runRemoteShellScript: vi.fn(),
			},
		);

		const firstHandle = await factory({
			agentWorkspaceDir: '/work',
			cfg: {},
			scopeKey: 'scope-stale',
			sessionKey: 'session-stale',
			workspaceDir: '/work',
		});
		const secondHandle = await factory({
			agentWorkspaceDir: '/work',
			cfg: {},
			scopeKey: 'scope-stale',
			sessionKey: 'session-stale',
			workspaceDir: '/work',
		});

		expect(firstHandle).not.toBe(secondHandle);
		expect(requestLease).toHaveBeenCalledTimes(2);
		expect(keepLeaseAlive).toHaveBeenCalledWith('lease-1');
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
					keepLeaseAlive: async () => createLeaseResponse('lease-keepalive'),
					peekLease: async () => createLeasePeekResponse(),
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
			agentWorkspaceDir: '/work',
			cfg: {},
			scopeKey: 'finalize-test',
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
					keepLeaseAlive: async () => createLeaseResponse('lease-keepalive'),
					peekLease: async () => createLeasePeekResponse(),
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
			agentWorkspaceDir: '/work',
			cfg: {},
			scopeKey: 'noop-finalize',
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
					keepLeaseAlive: async () => createLeaseResponse('lease-keepalive'),
					peekLease: async () => createLeasePeekResponse(),
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
						workdir: '/work',
					})),
				}),
				runRemoteShellScript,
			},
		);

		await factory({
			agentWorkspaceDir: '/work',
			cfg: {},
			scopeKey: 'test',
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
					keepLeaseAlive: async () => createLeaseResponse('lease-keepalive'),
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
				cfg: {},
				scopeKey: 'test',
				sessionKey: 'test',
				workspaceDir: '/work',
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
			workdir: '/work',
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
					keepLeaseAlive: async () => createLeaseResponse('lease-keepalive'),
					peekLease: async () => createLeasePeekResponse(),
					releaseLease: async () => {},
					requestLease,
				}),
				runRemoteShellScript: vi.fn(),
			},
		);

		const backend = await factory({
			agentWorkspaceDir: '/work',
			cfg: {},
			scopeKey: 'test',
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
		const keepLeaseAlive = vi.fn(async () => {
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
					keepLeaseAlive,
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
		expect(keepLeaseAlive).not.toHaveBeenCalled();
	});

	it('describeRuntime returns running false when peekLease throws', async () => {
		const manager = createGondolinSandboxBackendManager(
			{
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId: 'shravan',
			},
			{
				buildExecSpec: vi.fn(),
				createLeaseClient: () => ({
					keepLeaseAlive: vi.fn(),
					peekLease: vi.fn(async () => {
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
					keepLeaseAlive: vi.fn(),
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

		expect(releaseLease).toHaveBeenCalledWith('gondolin-scope-remove');
	});
});
