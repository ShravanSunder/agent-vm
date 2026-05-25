import type { ToolVmLeasePeek, ToolVmSshLease } from '@agent-vm/gateway-interface';
import { describe, expect, it, vi } from 'vitest';

import type { LeaseClient, OpenClawGondolinLeaseRequest } from './controller-lease-client.js';
import { createGondolinSandboxBackendFactory } from './sandbox-backend-factory.js';

const openClawToolVmWorkspaceMount = '/workspace';

interface CapturedLeaseClientCalls {
	readonly renewLeaseIds: string[];
	readonly requestedLeases: OpenClawGondolinLeaseRequest[];
}

function createLeaseResponse(options: {
	readonly agentId: string;
	readonly leaseIndex: number;
}): ToolVmSshLease {
	return {
		agentId: options.agentId,
		idleTtlMs: 6_000_000,
		leaseId: `01890f00-0000-7000-8000-${String(options.leaseIndex).padStart(12, '0')}`,
		ssh: {
			host: `tool-${String(options.leaseIndex)}.vm.host`,
			identityPem: 'pem',
			knownHostsLine: 'known-hosts',
			port: 22,
			user: 'sandbox',
		},
		tcpSlot: options.leaseIndex,
		transport: 'ssh-sandbox',
		workdir: openClawToolVmWorkspaceMount,
	};
}

function createLeasePeekResponse(lease: ToolVmSshLease): ToolVmLeasePeek {
	return {
		agentId: lease.agentId,
		createdAt: 1_000,
		idleTtlMs: lease.idleTtlMs,
		lastUsedAt: 2_000,
		leaseId: lease.leaseId,
		profileId: 'standard',
		ssh: {
			host: lease.ssh.host,
			port: lease.ssh.port,
			user: lease.ssh.user,
		},
		tcpSlot: lease.tcpSlot,
		transport: 'ssh-sandbox',
		workdir: lease.workdir,
		zoneId: 'shravan',
	};
}

function createSmokeLeaseClient(calls: CapturedLeaseClientCalls): LeaseClient {
	const leasesById = new Map<string, ToolVmSshLease>();
	return {
		endActiveUse: vi.fn(async () => {}),
		heartbeatActiveUse: vi.fn(async () => ({
			expiresAt: 3_000,
			heartbeatAfterMs: 1_000,
		})),
		peekLease: vi.fn(async (leaseId) => {
			const lease = leasesById.get(leaseId);
			if (!lease) {
				throw new Error(`Unknown lease ${leaseId}`);
			}
			return createLeasePeekResponse(lease);
		}),
		releaseLease: vi.fn(async () => {}),
		renewLease: vi.fn(async (leaseId) => {
			calls.renewLeaseIds.push(leaseId);
			const lease = leasesById.get(leaseId);
			if (!lease) {
				throw new Error(`Unknown lease ${leaseId}`);
			}
			return lease;
		}),
		requestLease: vi.fn(async (request) => {
			calls.requestedLeases.push(request);
			const lease = createLeaseResponse({
				agentId: request.agentId,
				leaseIndex: calls.requestedLeases.length,
			});
			leasesById.set(lease.leaseId, lease);
			return lease;
		}),
		startActiveUse: vi.fn(async (_leaseId, request) => ({
			expiresAt: 3_000,
			heartbeatAfterMs: 1_000,
			useId: request.useId,
		})),
	};
}

function createOpenClawSandboxParams(options: {
	readonly agentId: string;
	readonly scopeKey: string;
	readonly sessionKey: string;
}): Parameters<ReturnType<typeof createGondolinSandboxBackendFactory>>[0] {
	const agentWorkspaceDir = `/zone/agents/${options.agentId}`;
	return {
		agentWorkspaceDir,
		cfg: {
			backend: 'gondolin',
			mode: 'all',
			scope: 'agent',
			workspaceAccess: 'rw',
		},
		scopeKey: options.scopeKey,
		sessionKey: options.sessionKey,
		workspaceDir: agentWorkspaceDir,
	};
}

describe('smoke: OpenClaw agent-vm lease contract', () => {
	it('discards OpenClaw scope input and keys Tool VM leases by zone and agent', async () => {
		const calls: CapturedLeaseClientCalls = {
			renewLeaseIds: [],
			requestedLeases: [],
		};
		const runRemoteShellScript = vi.fn(async () => ({
			code: 0,
			stderr: Buffer.from(''),
			stdout: Buffer.from('ok'),
		}));
		const leaseClient = createSmokeLeaseClient(calls);
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
				createLeaseClient: () => leaseClient,
				runRemoteShellScript,
			},
		);

		const betaFirstHandle = await factory(
			createOpenClawSandboxParams({
				agentId: 'beta',
				scopeKey: 'agent:beta:discord:channel:123',
				sessionKey: 'agent:beta:discord:channel:123',
			}),
		);
		const betaSecondHandle = await factory(
			createOpenClawSandboxParams({
				agentId: 'beta',
				scopeKey: 'agent:beta:subagent:child',
				sessionKey: 'agent:beta:subagent:child',
			}),
		);
		const mainHandle = await factory(
			createOpenClawSandboxParams({
				agentId: 'main',
				scopeKey: 'agent:main:discord:channel:123',
				sessionKey: 'agent:main:discord:channel:123',
			}),
		);

		expect(betaSecondHandle).toBe(betaFirstHandle);
		expect(mainHandle).not.toBe(betaFirstHandle);
		expect(calls.requestedLeases).toHaveLength(2);
		expect(calls.renewLeaseIds).toEqual(['01890f00-0000-7000-8000-000000000001']);
		expect(runRemoteShellScript).toHaveBeenCalledWith(
			expect.objectContaining({
				allowFailure: false,
				script: 'true',
			}),
		);
		expect(calls.requestedLeases[0]).toEqual({
			agentId: 'beta',
			agentWorkspaceDir: '/zone/agents/beta',
			profileId: 'standard',
			sessionKey: 'agent:beta:discord:channel:123',
			workMountDir: '/zone/agents/beta',
			zoneId: 'shravan',
		});
		expect(calls.requestedLeases[1]).toEqual({
			agentId: 'main',
			agentWorkspaceDir: '/zone/agents/main',
			profileId: 'standard',
			sessionKey: 'agent:main:discord:channel:123',
			workMountDir: '/zone/agents/main',
			zoneId: 'shravan',
		});
		for (const request of calls.requestedLeases) {
			expect(request).not.toHaveProperty('scopeKey');
			expect(request).not.toHaveProperty('sandbox');
		}
	});
});
