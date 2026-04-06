import { describe, expect, it, vi } from 'vitest';

import { createControllerApp } from '../../agent-vm/src/features/controller/controller-service.js';
import { createGondolinSandboxBackendFactory } from './backend.js';
import { createLeaseClient } from './lease-client.js';

describe('gondolin controller integration', () => {
	it('requests a lease through the controller app and builds an exec spec from the returned ssh lease', async () => {
		const controllerApp = createControllerApp({
			readIdentityPem: async () => 'pem',
			leaseManager: {
				createLease: vi.fn(async () => ({
					createdAt: 1,
					id: 'lease-123',
					lastUsedAt: 1,
					profileId: 'standard',
					scopeKey: 'agent:main:session-abc',
					sshAccess: {
						command: 'ssh ...',
						host: '127.0.0.1',
						identityFile: '/tmp/key',
						port: 19000,
						user: 'sandbox',
					},
					tcpSlot: 0,
					vm: {
						close: vi.fn(async () => {}),
						enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
						enableSsh: vi.fn(async () => ({
							command: 'ssh ...',
							host: '127.0.0.1',
							identityFile: '/tmp/key',
							port: 19000,
							user: 'sandbox',
						})),
						exec: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: '' })),
						id: 'tool-vm-1',
						setIngressRoutes: vi.fn(),
					},
					zoneId: 'shravan',
				})),
				getLease: vi.fn(),
				releaseLease: vi.fn(async () => {}),
			},
		});
		const leaseClient = createLeaseClient({
			controllerUrl: 'http://controller.vm.host:18800',
			fetchImpl: async (input, init) =>
				await controllerApp.request(
					typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
					init,
				),
		});
		const factory = createGondolinSandboxBackendFactory(
			{
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId: 'shravan',
			},
			{
				buildExecSpec: async ({ command, env, ssh }) => ({
					argv: ['ssh', ssh.host, command],
					env,
					stdinMode: 'pipe-open',
				}),
				createLeaseClient: () => leaseClient,
				runRemoteShellScript: async () => ({
					code: 0,
					stderr: Buffer.from(''),
					stdout: Buffer.from('ok'),
				}),
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

		expect(execSpec.argv).toEqual(['ssh', 'tool-0.vm.host', 'ls -la']);
		expect(execSpec.stdinMode).toBe('pipe-open');
		expect(backend.runtimeId).toBe('lease-123');
	});
});
