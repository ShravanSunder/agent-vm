import { describe, expect, it, vi } from 'vitest';

import { createGondolinSandboxBackendFactory, type FsBridgeLeaseContext, type GondolinFsBridge } from './backend.js';

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
		await capturedLeaseContext!.runRemoteShellScript({
			script: 'cat /etc/hostname',
			args: ['/workspace/file.txt'],
		});

		// Verify it delegates to the deps runRemoteShellScript with the lease SSH creds
		expect(runRemoteShellScript).toHaveBeenCalledWith({
			script: expect.stringContaining('cat /etc/hostname'),
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
