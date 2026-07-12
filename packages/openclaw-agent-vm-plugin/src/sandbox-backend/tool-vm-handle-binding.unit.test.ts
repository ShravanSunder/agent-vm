import { parseToolVmLeaseId, type ToolVmSshLease } from '@agent-vm/gateway-interface';
import { describe, expect, it, vi } from 'vitest';

import { ControllerLeaseRequestError, type LeaseClient } from '../lease-client-contract.js';
import type {
	OpenClawFsBridgeLeaseContext,
	OpenClawSandboxBackendHandle,
} from './sandbox-backend-contract.js';
import { createGondolinSandboxBackendFactory } from './sandbox-backend-handle-factory.js';
import { createToolVmHandleBinding } from './tool-vm-handle-binding.js';

const OPENCLAW_TOOL_VM_WORKSPACE_MOUNT = '/workspace';
type BackendDependencies = Parameters<typeof createGondolinSandboxBackendFactory>[1];
type BuildExecSpec = BackendDependencies['buildExecSpec'];
type CreateFsBridgeBuilder = NonNullable<BackendDependencies['createFsBridgeBuilder']>;
type RunRemoteShellScript = BackendDependencies['runRemoteShellScript'];

function createLeaseResponse(leaseLabel: string): ToolVmSshLease {
	const leaseId = parseToolVmLeaseId(`01890f00-0000-7000-8000-${leaseLabel.padStart(12, '0')}`);
	return {
		agentId: 'main',
		idleTtlMs: 6_000_000,
		leaseId,
		ssh: {
			host: `tool-${leaseLabel}.vm.host`,
			identityPem: `pem-${leaseLabel}`,
			knownHostsLine: `known-hosts-${leaseLabel}`,
			port: 22,
			user: 'sandbox',
		},
		tcpSlot: Number.parseInt(leaseLabel, 10),
		transport: 'ssh-sandbox',
		workdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
	};
}

function createActiveUseLeaseClientMethods(): Pick<
	LeaseClient,
	'startActiveUse' | 'heartbeatActiveUse' | 'endActiveUse'
> {
	return {
		endActiveUse: vi.fn(async () => {}),
		heartbeatActiveUse: vi.fn(async () => ({
			expiresAt: 2_000,
			heartbeatAfterMs: 1_000,
		})),
		startActiveUse: vi.fn(async (_leaseId, request) => ({
			expiresAt: 2_000,
			heartbeatAfterMs: 1_000,
			useId: request.useId,
		})),
	};
}

interface BindingHarnessOptions {
	readonly buildExecSpec?: BuildExecSpec;
	readonly createFsBridgeBuilder?: CreateFsBridgeBuilder;
	readonly runRemoteShellScript?: RunRemoteShellScript;
}

interface BindingHarness {
	readonly activeUseMethods: Pick<
		LeaseClient,
		'startActiveUse' | 'heartbeatActiveUse' | 'endActiveUse'
	>;
	readonly buildExecSpec: BuildExecSpec;
	readonly createHandle: () => Promise<OpenClawSandboxBackendHandle>;
	readonly oldLease: ToolVmSshLease;
	readonly reacquireLease: LeaseClient['reacquireLease'];
	readonly releaseLease: LeaseClient['releaseLease'];
	readonly replacementLease: ToolVmSshLease;
	readonly requestLease: LeaseClient['requestLease'];
	readonly runRemoteShellScript: RunRemoteShellScript;
}

function createBindingHarness(options: BindingHarnessOptions = {}): BindingHarness {
	const oldLease = createLeaseResponse('1');
	const replacementLease = createLeaseResponse('2');
	const activeUseMethods = createActiveUseLeaseClientMethods();
	const requestLease = vi.fn(async () => oldLease);
	const reacquireLease = vi.fn(async () => replacementLease);
	const releaseLease = vi.fn(async () => {});
	const buildExecSpec =
		options.buildExecSpec ??
		vi.fn(async () => ({
			argv: ['ssh'],
			env: {},
			stdinMode: 'pipe-open' as const,
		}));
	const runRemoteShellScript =
		options.runRemoteShellScript ??
		vi.fn(async () => ({ code: 0, stderr: Buffer.alloc(0), stdout: Buffer.from('ok') }));
	const factory = createGondolinSandboxBackendFactory(
		{
			controllerUrl: 'http://controller.vm.host:18800',
			zoneId: 'shravan',
		},
		{
			buildExecSpec,
			...(options.createFsBridgeBuilder === undefined
				? {}
				: { createFsBridgeBuilder: options.createFsBridgeBuilder }),
			createLeaseClient: () => ({
				...activeUseMethods,
				peekLease: async () => ({
					agentId: 'main',
					createdAt: 1,
					idleTtlMs: 6_000_000,
					lastUsedAt: 1,
					leaseId: oldLease.leaseId,
					profileId: 'standard',
					ssh: { host: oldLease.ssh.host, port: 22, user: 'sandbox' },
					tcpSlot: oldLease.tcpSlot,
					transport: 'ssh-sandbox' as const,
					workdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
					zoneId: 'shravan',
				}),
				reacquireLease,
				releaseLease,
				renewLease: async (leaseId: string) =>
					leaseId === replacementLease.leaseId ? replacementLease : oldLease,
				requestLease,
			}),
			publishHealthEvent: vi.fn(async () => {}),
			runRemoteShellScript,
		},
	);
	return {
		activeUseMethods,
		buildExecSpec,
		createHandle: async () =>
			await factory({
				agentWorkspaceDir: '/zone/agents/main',
				cfg: {
					backend: 'gondolin',
					mode: 'all',
					scope: 'agent',
					workspaceAccess: 'rw',
				},
				scopeKey: 'agent:main',
				sessionKey: 'agent:main:session-reacquire',
				workspaceDir: '/work',
			}),
		oldLease,
		reacquireLease,
		releaseLease,
		replacementLease,
		requestLease,
		runRemoteShellScript,
	};
}

describe('Tool VM handle binding', () => {
	it('reacquires on the next same-handle operation after stale SSH evidence', async () => {
		const runRemoteShellScript = vi
			.fn()
			.mockRejectedValueOnce(new Error('kex reset'))
			.mockResolvedValue({ code: 0, stderr: Buffer.alloc(0), stdout: Buffer.from('ok') });
		const harness = createBindingHarness({ runRemoteShellScript });
		const handle = await harness.createHandle();

		await expect(handle.runShellCommand({ script: 'pwd' })).rejects.toThrow(/kex reset/u);
		expect(runRemoteShellScript).toHaveBeenCalledTimes(1);
		expect(harness.reacquireLease).not.toHaveBeenCalled();
		expect(harness.releaseLease).not.toHaveBeenCalled();

		await expect(handle.runShellCommand({ script: 'pwd' })).resolves.toEqual({
			code: 0,
			stderr: Buffer.alloc(0),
			stdout: Buffer.from('ok'),
		});

		expect(harness.reacquireLease).toHaveBeenCalledWith(harness.oldLease.leaseId, {
			observedAtMs: expect.any(Number),
			staleEvidence: {
				kind: 'tool-vm-ssh',
				operation: 'command',
			},
		});
		expect(harness.activeUseMethods.startActiveUse).toHaveBeenNthCalledWith(
			1,
			harness.oldLease.leaseId,
			expect.any(Object),
		);
		expect(harness.activeUseMethods.startActiveUse).toHaveBeenNthCalledWith(
			2,
			harness.replacementLease.leaseId,
			expect.any(Object),
		);
		expect(runRemoteShellScript).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ ssh: harness.oldLease.ssh }),
		);
		expect(runRemoteShellScript).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ ssh: harness.replacementLease.ssh }),
		);
		expect(harness.releaseLease).not.toHaveBeenCalled();
		expect(handle.runtimeId).toBe(harness.replacementLease.leaseId);
		expect(handle.runtimeLabel).toBe(harness.replacementLease.leaseId);
	});

	it('reacquires on the next same-handle file bridge operation after stale file evidence', async () => {
		let capturedLeaseContext: OpenClawFsBridgeLeaseContext | undefined;
		const createFsBridgeBuilder: CreateFsBridgeBuilder = (leaseContext) => {
			capturedLeaseContext = leaseContext;
			return vi.fn(() => ({
				mkdirp: vi.fn(async () => {}),
				readFile: vi.fn(async () => Buffer.from('')),
				remove: vi.fn(async () => {}),
				rename: vi.fn(async () => {}),
				resolvePath: vi.fn(() => ({
					containerPath: '/workspace/file.txt',
					relativePath: 'file.txt',
				})),
				stat: vi.fn(async () => null),
				writeFile: vi.fn(async () => {}),
			}));
		};
		const runRemoteShellScript = vi
			.fn()
			.mockRejectedValueOnce(new Error('file bridge reset'))
			.mockResolvedValue({ code: 0, stderr: Buffer.alloc(0), stdout: Buffer.from('ok') });
		const harness = createBindingHarness({ createFsBridgeBuilder, runRemoteShellScript });
		await harness.createHandle();
		if (capturedLeaseContext === undefined) {
			throw new Error('expected file bridge lease context');
		}

		await expect(
			capturedLeaseContext.runRemoteShellScript({ script: 'cat /workspace/file.txt' }),
		).rejects.toThrow(/file bridge reset/u);
		expect(harness.reacquireLease).not.toHaveBeenCalled();
		expect(harness.releaseLease).not.toHaveBeenCalled();

		await expect(
			capturedLeaseContext.runRemoteShellScript({ script: 'cat /workspace/file.txt' }),
		).resolves.toEqual({
			code: 0,
			stderr: Buffer.alloc(0),
			stdout: Buffer.from('ok'),
		});

		expect(harness.reacquireLease).toHaveBeenCalledWith(harness.oldLease.leaseId, {
			observedAtMs: expect.any(Number),
			staleEvidence: {
				kind: 'tool-vm-ssh',
				operation: 'file-bridge',
			},
		});
		expect(runRemoteShellScript).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ ssh: harness.oldLease.ssh }),
		);
		expect(runRemoteShellScript).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ ssh: harness.replacementLease.ssh }),
		);
		expect(harness.releaseLease).not.toHaveBeenCalled();
	});

	it('uses the replacement binding for buildExecSpec after earlier stale evidence', async () => {
		const runRemoteShellScript = vi
			.fn()
			.mockRejectedValueOnce(new Error('command reset'))
			.mockResolvedValue({ code: 0, stderr: Buffer.alloc(0), stdout: Buffer.from('ok') });
		const buildExecSpec = vi.fn(async () => ({
			argv: ['ssh'],
			env: {},
			stdinMode: 'pipe-open' as const,
		}));
		const harness = createBindingHarness({ buildExecSpec, runRemoteShellScript });
		const handle = await harness.createHandle();

		await expect(handle.runShellCommand({ script: 'pwd' })).rejects.toThrow(/command reset/u);
		await expect(
			handle.buildExecSpec({
				command: 'node -e "console.log(1)"',
				env: {},
				usePty: false,
			}),
		).resolves.toEqual({
			argv: ['ssh'],
			env: {},
			stdinMode: 'pipe-open',
			finalizeToken: expect.objectContaining({
				activeUseHandle: expect.any(Object),
				lease: harness.replacementLease,
			}),
		});

		expect(harness.reacquireLease).toHaveBeenCalledWith(harness.oldLease.leaseId, {
			observedAtMs: expect.any(Number),
			staleEvidence: {
				kind: 'tool-vm-ssh',
				operation: 'command',
			},
		});
		expect(buildExecSpec).toHaveBeenCalledWith({
			command: 'node -e "console.log(1)"',
			env: {},
			ssh: harness.replacementLease.ssh,
			usePty: false,
			workdir: '/work',
		});
	});

	it.each([
		{ reason: 'ownership_denied', status: 400, title: 'ownership denial' },
		{ reason: 'lease_authority_absent', status: 404, title: 'missing old-lease authority' },
		{ reason: 'lease_retired', status: 410, title: 'retired old lease' },
	] as const)(
		'terminalizes stale bindings after $title reacquire rejection',
		async ({ reason, status }) => {
			const oldLease = createLeaseResponse('1');
			const terminalError = new ControllerLeaseRequestError({
				bodyText: JSON.stringify({
					leaseRejectionReason: reason,
					message: 'terminal reacquire denial',
				}),
				context: 'Gateway control lease_reacquire',
				leaseRejectionReason: reason,
				responseBody: {
					leaseRejectionReason: reason,
					message: 'terminal reacquire denial',
				},
				status,
			});
			const reacquireLease = vi.fn(async () => {
				throw terminalError;
			});
			const binding = createToolVmHandleBinding({
				initialLease: oldLease,
				leaseClient: {
					getRetiredLeaseReacquireRequest: () => undefined,
					reacquireLease,
				},
				now: () => 42,
			});

			binding.markStale({
				lease: oldLease,
				operation: 'command',
				reason: 'ssh-command-failed',
			});
			await expect(binding.resolveCurrentLease()).rejects.toBe(terminalError);
			await expect(binding.resolveCurrentLease()).rejects.toBe(terminalError);

			expect(reacquireLease).toHaveBeenCalledTimes(1);
			expect(reacquireLease).toHaveBeenCalledWith(oldLease.leaseId, {
				observedAtMs: 42,
				staleEvidence: {
					kind: 'tool-vm-ssh',
					operation: 'command',
				},
			});
		},
	);

	it('does not terminalize refreshable session-mismatch reacquire errors', async () => {
		const oldLease = createLeaseResponse('1');
		const replacementLease = createLeaseResponse('2');
		const refreshableError = new ControllerLeaseRequestError({
			bodyText: JSON.stringify({
				leaseRejectionReason: 'caller_context_session_mismatch',
				message: 'session drift',
			}),
			context: 'Gateway control lease_reacquire',
			leaseRejectionReason: 'caller_context_session_mismatch',
			responseBody: {
				leaseRejectionReason: 'caller_context_session_mismatch',
				message: 'session drift',
			},
			status: 400,
		});
		const reacquireLease = vi
			.fn()
			.mockRejectedValueOnce(refreshableError)
			.mockResolvedValueOnce(replacementLease);
		const binding = createToolVmHandleBinding({
			initialLease: oldLease,
			leaseClient: {
				getRetiredLeaseReacquireRequest: () => undefined,
				reacquireLease,
			},
			now: () => 42,
		});

		binding.markStale({
			lease: oldLease,
			operation: 'command',
			reason: 'ssh-command-failed',
		});
		await expect(binding.resolveCurrentLease()).rejects.toBe(refreshableError);
		await expect(binding.resolveCurrentLease()).resolves.toEqual(replacementLease);

		expect(reacquireLease).toHaveBeenCalledTimes(2);
	});
});
