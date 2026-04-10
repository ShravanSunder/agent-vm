import { describe, expect, it, vi } from 'vitest';

import { createLeaseManager } from './lease-manager.js';
import { createTcpPool } from './tcp-pool.js';

describe('createLeaseManager', () => {
	it('creates, stores, and releases a lease while returning its tcp slot', async () => {
		const closeMock = vi.fn(async () => {});
		const enableSshMock = vi.fn(async () => ({
			command: 'ssh ...',
			host: '127.0.0.1',
			identityFile: '/tmp/key',
			port: 19000,
			user: 'sandbox',
		}));
		const leaseManager = createLeaseManager({
			createManagedVm: vi.fn(async () => ({
				close: closeMock,
				enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
				enableSsh: enableSshMock,
				exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
				id: 'tool-vm-1',
				setIngressRoutes: vi.fn(),
			})),
			now: () => 123,
			tcpPool: createTcpPool({
				basePort: 19000,
				size: 2,
			}),
		});

		const lease = await leaseManager.createLease({
			agentWorkspaceDir: '/home/openclaw/workspace',
			profile: {
				cpus: 1,
				memory: '1G',
				workspaceRoot: '/workspaces/tools',
			},
			profileId: 'standard',
			scopeKey: 'agent:main:session-abc',
			workspaceDir: '/home/openclaw/.openclaw/sandboxes/session/workspace',
			zoneId: 'shravan',
		});

		expect(lease.tcpSlot).toBe(0);
		expect(leaseManager.getLease(lease.id)).toMatchObject({
			id: lease.id,
			zoneId: 'shravan',
		});

		await leaseManager.releaseLease(lease.id);

		expect(closeMock).toHaveBeenCalled();
		expect(leaseManager.getLease(lease.id)).toBeUndefined();
	});

	it('listLeases returns all active leases', async () => {
		const leaseManager = createLeaseManager({
			createManagedVm: vi.fn(async () => ({
				close: vi.fn(async () => {}),
				enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
				enableSsh: vi.fn(async () => ({
					command: 'ssh ...',
					host: '127.0.0.1',
					identityFile: '/tmp/key',
					port: 19000,
					user: 'sandbox',
				})),
				exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
				id: 'tool-vm-1',
				setIngressRoutes: vi.fn(),
			})),
			now: () => 100,
			tcpPool: createTcpPool({ basePort: 19000, size: 5 }),
		});

		const lease1 = await leaseManager.createLease({
			agentWorkspaceDir: '/workspace',
			profile: { cpus: 1, memory: '1G', workspaceRoot: '/workspaces/tools' },
			profileId: 'standard',
			scopeKey: 'scope-a',
			workspaceDir: '/workspace',
			zoneId: 'shravan',
		});
		const lease2 = await leaseManager.createLease({
			agentWorkspaceDir: '/workspace',
			profile: { cpus: 1, memory: '1G', workspaceRoot: '/workspaces/tools' },
			profileId: 'standard',
			scopeKey: 'scope-b',
			workspaceDir: '/workspace',
			zoneId: 'shravan',
		});

		const all = leaseManager.listLeases();
		expect(all).toHaveLength(2);
		expect(all.map((lease) => lease.id)).toContain(lease1.id);
		expect(all.map((lease) => lease.id)).toContain(lease2.id);
	});

	it('releaseLease is a no-op for non-existent lease ids', async () => {
		const leaseManager = createLeaseManager({
			createManagedVm: vi.fn(),
			now: () => 100,
			tcpPool: createTcpPool({ basePort: 19000, size: 2 }),
		});

		// Should not throw
		await leaseManager.releaseLease('does-not-exist');

		expect(leaseManager.listLeases()).toHaveLength(0);
	});
});
