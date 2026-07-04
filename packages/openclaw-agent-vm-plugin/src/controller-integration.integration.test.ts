import {
	isToolVmLeaseId,
	parseToolVmLeaseId,
	type ToolVmLeaseId,
	type ToolVmLeasePeek,
	type ToolVmSshLease,
} from '@agent-vm/gateway-interface';
import { describe, expect, it, vi } from 'vitest';

import type { LeaseClient } from './lease-client-contract.js';
import { createGondolinSandboxBackendFactory } from './sandbox-backend-factory.js';

const OPENCLAW_TOOL_VM_WORKSPACE_MOUNT = '/workspace';
const testLeaseIdByLabel = new Map<string, ToolVmLeaseId>();

function testToolVmLeaseId(label: string): ToolVmLeaseId {
	if (isToolVmLeaseId(label)) {
		return label;
	}
	const existingLeaseId = testLeaseIdByLabel.get(label);
	if (existingLeaseId) {
		return existingLeaseId;
	}
	const leaseId = `01890f00-0000-7000-8000-${String(testLeaseIdByLabel.size + 1).padStart(12, '0')}`;
	const parsedLeaseId = parseToolVmLeaseId(leaseId);
	testLeaseIdByLabel.set(label, parsedLeaseId);
	return parsedLeaseId;
}

function createLeaseResponse(leaseId: string): ToolVmSshLease {
	return {
		agentId: 'main',
		idleTtlMs: 6_000_000,
		leaseId: testToolVmLeaseId(leaseId),
		ssh: {
			host: 'tool-0.vm.host',
			identityPem: 'pem',
			knownHostsLine: 'known',
			port: 22,
			user: 'root',
		},
		tcpSlot: 0,
		transport: 'ssh-sandbox' as const,
		workdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
	};
}

function createLeasePeekResponse(leaseId: string): ToolVmLeasePeek {
	return {
		agentId: 'main',
		createdAt: 1,
		idleTtlMs: 6_000_000,
		lastUsedAt: 1,
		leaseId: testToolVmLeaseId(leaseId),
		profileId: 'standard',
		ssh: { host: 'tool-0.vm.host', port: 22, user: 'root' },
		tcpSlot: 0,
		transport: 'ssh-sandbox' as const,
		workdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
		zoneId: 'shravan',
	};
}

function gondolinSandboxConfig(): {
	readonly backend: 'gondolin';
	readonly mode: 'all';
	readonly scope: 'agent';
	readonly workspaceAccess: 'rw';
} {
	return {
		backend: 'gondolin',
		mode: 'all',
		scope: 'agent',
		workspaceAccess: 'rw',
	};
}

describe('gondolin controller integration', () => {
	it('reuses one controller lease for same-agent subagent scopes while sending no scopeKey', async () => {
		const requestBodies: unknown[] = [];
		const leaseClient: LeaseClient = {
			endActiveUse: vi.fn(async () => {}),
			heartbeatActiveUse: vi.fn(async () => ({
				expiresAt: 3_000,
				heartbeatAfterMs: 1_000,
			})),
			peekLease: vi.fn(async () => createLeasePeekResponse('subagent-lease')),
			releaseLease: vi.fn(async () => {}),
			renewLease: vi.fn(async () => createLeaseResponse('subagent-lease')),
			requestLease: vi.fn(async (request) => {
				requestBodies.push(request);
				return createLeaseResponse('subagent-lease');
			}),
			startActiveUse: vi.fn(async (_leaseId, request) => ({
				expiresAt: 3_000,
				heartbeatAfterMs: 1_000,
				useId: request.useId,
			})),
		};
		const factory = createGondolinSandboxBackendFactory(
			{
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId: 'shravan',
			},
			{
				buildExecSpec: async () => ({ argv: ['ssh'], env: {}, stdinMode: 'pipe-open' }),
				createLeaseClient: () => leaseClient,
				runRemoteShellScript: vi.fn(),
			},
		);

		const firstHandle = await factory({
			agentWorkspaceDir: '/zone/agents/beta',
			cfg: gondolinSandboxConfig(),
			scopeKey: 'agent:beta:discord:channel:123',
			sessionKey: 'agent:beta:discord:channel:123',
			workspaceDir: '/zone/agents/beta',
		});
		const secondHandle = await factory({
			agentWorkspaceDir: '/zone/agents/beta',
			cfg: gondolinSandboxConfig(),
			scopeKey: 'agent:beta:subagent:child',
			sessionKey: 'agent:beta:subagent:child',
			workspaceDir: '/zone/agents/beta',
		});

		expect(secondHandle).not.toBe(firstHandle);
		expect(secondHandle.runtimeId).toBe(firstHandle.runtimeId);
		expect(requestBodies).toEqual([
			{
				agentId: 'beta',
				agentWorkspaceDir: '/zone/agents/beta',
				profileId: 'standard',
				sessionKey: 'agent:beta:discord:channel:123',
				workMountDir: '/zone/agents/beta',
				zoneId: 'shravan',
			},
		]);
	});

	it('does not reuse a cached handle when the profile changes for the same agent scope', async () => {
		const requestLease = vi
			.fn()
			.mockResolvedValueOnce(createLeaseResponse('lease-1'))
			.mockResolvedValueOnce(createLeaseResponse('lease-2'));
		const standardFactory = createGondolinSandboxBackendFactory(
			{
				controllerUrl: 'http://controller.vm.host:18800',
				profileId: 'standard',
				zoneId: 'shravan',
			},
			{
				buildExecSpec: async ({ command, env, ssh }) => ({
					argv: ['ssh', ssh.host, command],
					env,
					stdinMode: 'pipe-open',
				}),
				createLeaseClient: () => ({
					endActiveUse: vi.fn(async () => {}),
					heartbeatActiveUse: vi.fn(async () => ({
						expiresAt: 3_000,
						heartbeatAfterMs: 1_000,
					})),
					renewLease: vi.fn(async () => createLeaseResponse('lease-1')),
					peekLease: vi.fn(async () => createLeasePeekResponse('lease-1')),
					releaseLease: vi.fn(async () => {}),
					requestLease,
					startActiveUse: vi.fn(async (_leaseId, request) => ({
						expiresAt: 3_000,
						heartbeatAfterMs: 1_000,
						useId: request.useId,
					})),
				}),
				runRemoteShellScript: async () => ({
					code: 0,
					stderr: Buffer.from(''),
					stdout: Buffer.from('ok'),
				}),
			},
		);
		const gpuFactory = createGondolinSandboxBackendFactory(
			{
				controllerUrl: 'http://controller.vm.host:18800',
				profileId: 'gpu',
				zoneId: 'shravan',
			},
			{
				buildExecSpec: async ({ command, env, ssh }) => ({
					argv: ['ssh', ssh.host, command],
					env,
					stdinMode: 'pipe-open',
				}),
				createLeaseClient: () => ({
					endActiveUse: vi.fn(async () => {}),
					heartbeatActiveUse: vi.fn(async () => ({
						expiresAt: 3_000,
						heartbeatAfterMs: 1_000,
					})),
					renewLease: vi.fn(async () => createLeaseResponse('lease-1')),
					peekLease: vi.fn(async () => createLeasePeekResponse('lease-1')),
					releaseLease: vi.fn(async () => {}),
					requestLease,
					startActiveUse: vi.fn(async (_leaseId, request) => ({
						expiresAt: 3_000,
						heartbeatAfterMs: 1_000,
						useId: request.useId,
					})),
				}),
				runRemoteShellScript: async () => ({
					code: 0,
					stderr: Buffer.from(''),
					stdout: Buffer.from('ok'),
				}),
			},
		);

		const first = await standardFactory({
			agentWorkspaceDir: '/home/openclaw/work',
			cfg: gondolinSandboxConfig(),
			scopeKey: 'agent:main',
			sessionKey: 'agent:main:session-1',
			workspaceDir: '/home/openclaw/work',
		});
		const second = await gpuFactory({
			agentWorkspaceDir: '/home/openclaw/work',
			cfg: gondolinSandboxConfig(),
			scopeKey: 'agent:main',
			sessionKey: 'agent:main:session-1',
			workspaceDir: '/home/openclaw/work',
		});

		expect(first.runtimeId).toBe(testToolVmLeaseId('lease-1'));
		expect(second.runtimeId).toBe(testToolVmLeaseId('lease-2'));
		expect(requestLease).toHaveBeenCalledTimes(2);
	});
});
