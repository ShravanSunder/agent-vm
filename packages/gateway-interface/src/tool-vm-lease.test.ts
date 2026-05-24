import { describe, expect, it } from 'vitest';

import { isToolVmLeasePeek, isToolVmSshLease } from './tool-vm-lease.js';

const OPENCLAW_TOOL_VM_WORKSPACE_MOUNT = '/workspace';

describe('Tool VM SSH lease types', () => {
	it('accepts an SSH lease capability and does not model filesystem methods', () => {
		const lease = {
			agentId: 'main',
			leaseId: 'zone-scope-123',
			scopeKey: 'agent:main:discord:channel:123',
			ssh: {
				host: 'tool-0.vm.host',
				identityPem: 'pem',
				knownHostsLine: 'known-hosts',
				port: 22,
				user: 'root',
			},
			tcpSlot: 0,
			transport: 'ssh-sandbox',
			workdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
		};

		expect(isToolVmSshLease(lease)).toBe(true);
		expect('readFile' in lease).toBe(false);
		expect('writeFile' in lease).toBe(false);
	});

	it('rejects SSH leases without agent provenance', () => {
		expect(
			isToolVmSshLease({
				leaseId: 'zone-scope-123',
				ssh: {
					host: 'tool-0.vm.host',
					identityPem: 'pem',
					knownHostsLine: 'known-hosts',
					port: 22,
					user: 'root',
				},
				tcpSlot: 0,
				transport: 'ssh-sandbox',
				workdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			}),
		).toBe(false);
	});

	it('accepts read-only lease peek snapshots without private key material', () => {
		expect(
			isToolVmLeasePeek({
				agentId: 'main',
				createdAt: 1,
				lastUsedAt: 2,
				leaseId: 'zone-scope-123',
				profileId: 'standard',
				scopeKey: 'agent-session',
				ssh: {
					host: 'tool-0.vm.host',
					port: 22,
					user: 'root',
				},
				tcpSlot: 0,
				transport: 'ssh-sandbox',
				workdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
				zoneId: 'default',
			}),
		).toBe(true);
	});
});
