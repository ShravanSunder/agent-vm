import { describe, expect, it } from 'vitest';

import { isToolVmLeasePeek, isToolVmSshLease } from './tool-vm-lease.js';

const OPENCLAW_TOOL_VM_WORKSPACE_MOUNT = '/workspace';

describe('Tool VM SSH lease types', () => {
	it('accepts an SSH lease capability and does not model filesystem methods', () => {
		const lease = {
			agentId: 'main',
			idleTtlMs: 6_000_000,
			leaseId: '01890f00-0000-7000-8000-000000000000',
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
				idleTtlMs: 6_000_000,
				leaseId: '01890f00-0000-7000-8000-000000000000',
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

	it('rejects SSH leases that still include scopeKey', () => {
		expect(
			isToolVmSshLease({
				agentId: 'main',
				idleTtlMs: 6_000_000,
				leaseId: '01890f00-0000-7000-8000-000000000000',
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
			}),
		).toBe(false);
	});

	it('rejects SSH leases whose lease id is not an opaque Tool VM lease id', () => {
		expect(
			isToolVmSshLease({
				agentId: 'main',
				idleTtlMs: 6_000_000,
				leaseId: 'shravan-main-1700000000000',
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
				idleTtlMs: 6_000_000,
				lastUsedAt: 2,
				leaseId: '01890f00-0000-7000-8000-000000000000',
				profileId: 'standard',
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

	it('rejects read-only lease peek snapshots that still include scopeKey', () => {
		expect(
			isToolVmLeasePeek({
				agentId: 'main',
				createdAt: 1,
				lastUsedAt: 2,
				leaseId: '01890f00-0000-7000-8000-000000000000',
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
		).toBe(false);
	});
});
