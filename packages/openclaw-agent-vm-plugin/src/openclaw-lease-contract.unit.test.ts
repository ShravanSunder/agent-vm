import {
	parseToolVmLeaseId,
	type ToolVmLeasePeek,
	type ToolVmSshLease,
} from '@agent-vm/gateway-interface';
import { describe, expect, it, vi } from 'vitest';

import type { LeaseClient, OpenClawGondolinLeaseRequest } from './lease-client-contract.js';
import { createGondolinSandboxBackendFactory } from './sandbox-backend-factory.js';

const openClawToolVmWorkspaceMount = '/workspace';

interface CapturedLeaseClientCalls {
	readonly reacquireLeaseIds: string[];
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
		leaseId: parseToolVmLeaseId(
			`01890f00-0000-7000-8000-${String(options.leaseIndex).padStart(12, '0')}`,
		),
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
		reacquireLease: vi.fn(async (oldLeaseId, _request) => {
			calls.reacquireLeaseIds.push(oldLeaseId);
			const oldLease = leasesById.get(oldLeaseId);
			if (!oldLease) {
				throw new Error(`Unknown lease ${oldLeaseId}`);
			}
			const replacementLease = createLeaseResponse({
				agentId: oldLease.agentId,
				leaseIndex: calls.requestedLeases.length + calls.reacquireLeaseIds.length,
			});
			leasesById.set(replacementLease.leaseId, replacementLease);
			return replacementLease;
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
	readonly workspaceDir?: string;
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
		workspaceDir: options.workspaceDir ?? agentWorkspaceDir,
	};
}

describe('OpenClaw agent-vm lease contract', () => {
	it('requires the lease client contract to expose stale lease reacquisition', async () => {
		const calls: CapturedLeaseClientCalls = {
			reacquireLeaseIds: [],
			renewLeaseIds: [],
			requestedLeases: [],
		};
		const leaseClient = createSmokeLeaseClient(calls);
		const initialLease = await leaseClient.requestLease({
			agentId: 'beta',
			agentWorkspaceDir: '/zone/agents/beta',
			profileId: 'standard',
			sessionKey: 'agent:beta:discord:channel:123',
			workMountDir: '/zone/agents/beta',
			zoneId: 'shravan',
		});

		const replacementLease = await leaseClient.reacquireLease(initialLease.leaseId, {
			idleTtlMs: 120_000,
			observedAtMs: 2_000,
			staleEvidence: {
				errorCode: 'ssh-command-failed',
				kind: 'tool-vm-ssh',
				operation: 'file-bridge',
			},
		});

		expect(calls.reacquireLeaseIds).toEqual([initialLease.leaseId]);
		expect(replacementLease.leaseId).not.toBe(initialLease.leaseId);
	});

	it('discards OpenClaw scope input and keys Tool VM leases by zone and agent', async () => {
		const calls: CapturedLeaseClientCalls = {
			reacquireLeaseIds: [],
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

		expect(betaSecondHandle).not.toBe(betaFirstHandle);
		expect(betaSecondHandle.runtimeId).toBe(betaFirstHandle.runtimeId);
		expect(mainHandle.runtimeId).not.toBe(betaFirstHandle.runtimeId);
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

	it('normalizes Tool VM guest cwd aliases without forking the agent lease', async () => {
		const calls: CapturedLeaseClientCalls = {
			reacquireLeaseIds: [],
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

		const workspaceHandle = await factory(
			createOpenClawSandboxParams({
				agentId: 'beta',
				scopeKey: 'agent:beta:discord:channel:123',
				sessionKey: 'agent:beta:discord:channel:123',
				workspaceDir: '/workspace/app',
			}),
		);
		const scratchHandle = await factory(
			createOpenClawSandboxParams({
				agentId: 'beta',
				scopeKey: 'agent:beta:subagent:child',
				sessionKey: 'agent:beta:subagent:child',
				workspaceDir: '/work/tmp',
			}),
		);

		expect(scratchHandle).not.toBe(workspaceHandle);
		expect(scratchHandle.runtimeId).toBe(workspaceHandle.runtimeId);
		expect(workspaceHandle.workdir).toBe('/workspace/app');
		expect(scratchHandle.workdir).toBe('/work/tmp');
		expect(calls.requestedLeases).toEqual([
			{
				agentId: 'beta',
				agentWorkspaceDir: '/zone/agents/beta',
				profileId: 'standard',
				sessionKey: 'agent:beta:discord:channel:123',
				workMountDir: '/zone/agents/beta',
				zoneId: 'shravan',
			},
		]);
		expect(calls.renewLeaseIds).toEqual(['01890f00-0000-7000-8000-000000000001']);
		expect(runRemoteShellScript).toHaveBeenCalledWith(
			expect.objectContaining({
				allowFailure: false,
				script: 'true',
			}),
		);
		const request = calls.requestedLeases[0];
		expect(request).not.toHaveProperty('scopeKey');
		expect(request).not.toHaveProperty('sandbox');
		expect(request).not.toHaveProperty('workspaceDir');
	});
});
