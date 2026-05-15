import { describe, expect, it, vi } from 'vitest';

import { createControllerApp } from '../../agent-vm/src/controller/http/controller-http-routes.js';
import {
	createLeaseClient,
	type GondolinLeaseResponse,
	type LeasePeekResponse,
} from './controller-lease-client.js';
import { createGondolinSandboxBackendFactory } from './sandbox-backend-factory.js';

function createLeaseResponse(leaseId: string): GondolinLeaseResponse {
	return {
		leaseId,
		ssh: {
			host: 'tool-0.vm.host',
			identityPem: 'pem',
			knownHostsLine: 'known',
			port: 22,
			user: 'root',
		},
		tcpSlot: 0,
		workdir: '/work',
	};
}

function createLeasePeekResponse(leaseId: string): LeasePeekResponse {
	return {
		createdAt: 1,
		lastUsedAt: 1,
		leaseId,
		profileId: 'standard',
		scopeKey: 'agent:main',
		ssh: { host: 'tool-0.vm.host', port: 22, user: 'root' },
		tcpSlot: 0,
		zoneId: 'shravan',
	};
}

describe('gondolin controller integration', () => {
	it('requests a lease through the controller app and builds an exec spec from the returned ssh lease', async () => {
		const lease = {
			agentWorkspaceDir: '/zone',
			createdAt: 1,
			id: 'lease-123',
			lastUsedAt: 1,
			profileId: 'standard',
			scopeKey: 'agent:main:session-abc',
			guestWorkdir: '/work',
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
				getVmInstance: vi.fn(),
			},
			hostWorkMountDir: '/home/openclaw/.openclaw/state/sandboxes/work',
			zoneId: 'shravan',
		};
		const controllerApp = createControllerApp({
			readIdentityPem: async () => 'pem',
			toolVmProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
			},
			leaseManager: {
				createLease: vi.fn(async () => lease),
				keepLeaseAlive: vi.fn(() => ({
					kind: 'renewed' as const,
					lastUsedAt: 2,
					lease: {
						...lease,
						lastUsedAt: 2,
					},
				})),
				peekLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
			resolveLeaseWorkMountDir: async ({ workMountDir }) => ({
				guestWorkdir: '/work',
				hostWorkMountDir: workMountDir,
			}),
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

		expect(execSpec.argv).toEqual(['ssh', 'tool-0.vm.host', 'ls -la']);
		expect(execSpec.stdinMode).toBe('pipe-open');
		expect(backend.runtimeId).toBe('lease-123');
		expect(backend.configLabel).toBe('http://controller.vm.host:18800 (shravan)');
		expect(backend.configLabelKind).toBe('VM');
		await backend.finalizeExec?.({
			status: 'completed',
			exitCode: 0,
			timedOut: false,
			token: execSpec.finalizeToken,
		});
	});

	it('does not reuse a cached handle when the same scopeKey changes workspace identity', async () => {
		const requestLease = vi
			.fn()
			.mockResolvedValueOnce(createLeaseResponse('lease-1'))
			.mockResolvedValueOnce(createLeaseResponse('lease-2'));
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
				createLeaseClient: () => ({
					keepLeaseAlive: vi.fn(async () => createLeaseResponse('lease-1')),
					peekLease: vi.fn(async () => createLeasePeekResponse('lease-1')),
					releaseLease: vi.fn(async () => {}),
					requestLease,
				}),
				runRemoteShellScript: async () => ({
					code: 0,
					stderr: Buffer.from(''),
					stdout: Buffer.from('ok'),
				}),
			},
		);

		const first = await factory({
			agentWorkspaceDir: '/home/openclaw/work',
			cfg: {},
			scopeKey: 'agent:main',
			sessionKey: 'session-1',
			workspaceDir: '/home/openclaw/.openclaw/state/sandboxes/agent-main/work',
		});
		const second = await factory({
			agentWorkspaceDir: '/home/openclaw/other-work',
			cfg: {},
			scopeKey: 'agent:main',
			sessionKey: 'session-1',
			workspaceDir: '/home/openclaw/.openclaw/state/sandboxes/agent-main-other/work',
		});

		expect(first.runtimeId).toBe('lease-1');
		expect(second.runtimeId).toBe('lease-2');
		expect(requestLease).toHaveBeenCalledTimes(2);
	});
});
