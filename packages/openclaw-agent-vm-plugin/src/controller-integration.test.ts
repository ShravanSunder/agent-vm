import { Readable } from 'node:stream';

import {
	isToolVmLeaseId,
	parseToolVmLeaseId,
	type ToolVmLeaseId,
	type ToolVmLeasePeek,
	type ToolVmSshLease,
} from '@agent-vm/gateway-interface';
import type {
	ManagedExecProcess,
	ManagedExecResult,
	ManagedVmFs,
} from '@agent-vm/gondolin-adapter';
import { describe, expect, it, vi } from 'vitest';

import { createControllerApp } from '../../agent-vm/src/controller/http/controller-http-routes.js';
import { createLeaseClient } from './controller-lease-client.js';
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

/* oxlint-disable typescript/no-unnecessary-type-parameters, typescript/no-unsafe-type-assertion, typescript-eslint/no-unsafe-type-assertion, unicorn/no-thenable -- Controller integration test doubles only need
   Gondolin's promise/stream surface used by the controller route. */
function createManagedExecProcessStub(): ManagedExecProcess {
	const execResult = {
		exitCode: 0,
		stderr: '',
		stdout: '',
		stderrBuffer: Buffer.from(''),
		stdoutBuffer: Buffer.from(''),
		ok: true,
		json<TValue = unknown>(): TValue {
			return JSON.parse(this.stdout) as TValue;
		},
		lines(): string[] {
			return this.stdout.split(/\r?\n/u);
		},
		toString(): string {
			return this.stdout;
		},
	} as ManagedExecResult;
	const resultPromise = Promise.resolve(execResult);
	return {
		[Symbol.asyncIterator]: async function* (): AsyncIterator<string> {
			yield '';
		},
		catch: resultPromise.catch.bind(resultPromise),
		finally: resultPromise.finally.bind(resultPromise),
		stderr: Readable.from(['']),
		stdout: Readable.from(['']),
		then: resultPromise.then.bind(resultPromise),
	} as ManagedExecProcess;
}
/* oxlint-enable typescript/no-unnecessary-type-parameters, typescript/no-unsafe-type-assertion, typescript-eslint/no-unsafe-type-assertion, unicorn/no-thenable */

async function readManagedVmFsStubFile(
	_filePath: string,
	options?: { readonly encoding?: BufferEncoding | null },
): Promise<Buffer | string> {
	return options?.encoding ? '' : Buffer.from('');
}

function createManagedVmFsStub(): ManagedVmFs {
	return {
		access: async () => {},
		deleteFile: async () => {},
		listDir: async () => [],
		mkdir: async () => {},
		/* oxlint-disable-next-line typescript/no-unsafe-type-assertion -- VmFs.readFile overload
		   is represented by one stub that covers text and buffer modes. */
		readFile: readManagedVmFsStubFile as unknown as ManagedVmFs['readFile'],
		readFileStream: async () => Readable.from([]),
		rename: async () => {},
		stat: async () => {
			throw new Error('stat not implemented in ManagedVm test stub');
		},
		writeFile: async () => {},
	};
}

describe('gondolin controller integration', () => {
	it('requests a lease through the controller app and builds an exec spec from the returned ssh lease', async () => {
		const lease = {
			agentId: 'main',
			agentWorkspaceDir: '/zone',
			createdAt: 1,
			effectiveIdleTtlMs: 300_000,
			id: testToolVmLeaseId('lease-123'),
			lastUsedAt: 1,
			profileId: 'standard',
			runtimeRecordId: testToolVmLeaseId('lease-123'),
			guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
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
				exec: vi.fn(() => createManagedExecProcessStub()),
				fs: createManagedVmFsStub(),
				id: 'tool-vm-1',
				setIngressRoutes: vi.fn(),
				getHostPid: () => null,
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
				renewLease: vi.fn(),
				peekLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
				startActiveUse: vi.fn((_leaseId, request) => ({
					expiresAt: 3_000,
					heartbeatAfterMs: 1_000,
					useId: request.useId,
				})),
				heartbeatActiveUse: vi.fn(() => ({
					expiresAt: 3_000,
					heartbeatAfterMs: 1_000,
				})),
				endActiveUse: vi.fn(),
			},
			resolveLeaseWorkMountDir: async ({ workMountDir }) => ({
				guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
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
				...gondolinSandboxConfig(),
				docker: {
					env: {
						OPENCLAW_LOG_LEVEL: 'debug',
					},
				},
			},
			scopeKey: 'agent:main',
			sessionKey: 'agent:main:session-abc',
			workspaceDir: '/home/openclaw/.openclaw/state/sandboxes/work',
		});
		const execSpec = await backend.buildExecSpec({
			command: 'ls -la',
			env: {
				TEST_ENV: '1',
			},
			usePty: false,
			workdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
		});

		expect(execSpec.argv).toEqual(['ssh', 'tool-0.vm.host', 'ls -la']);
		expect(execSpec.stdinMode).toBe('pipe-open');
		expect(backend.runtimeId).toBe(testToolVmLeaseId('lease-123'));
		expect(backend.configLabel).toBe('http://controller.vm.host:18800 (shravan)');
		expect(backend.configLabelKind).toBe('VM');
		await backend.finalizeExec?.({
			status: 'completed',
			exitCode: 0,
			timedOut: false,
			token: execSpec.finalizeToken,
		});
	});

	it('reuses one controller lease for same-agent subagent scopes while sending no scopeKey', async () => {
		const requestBodies: unknown[] = [];
		const leaseClient = createLeaseClient({
			controllerUrl: 'http://controller.vm.host:18800',
			fetchImpl: async (_input, init) => {
				if (typeof init?.body === 'string') {
					requestBodies.push(JSON.parse(init.body));
				}
				return new Response(JSON.stringify(createLeaseResponse('subagent-lease')), {
					headers: { 'content-type': 'application/json' },
					status: 200,
				});
			},
		});
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

		expect(secondHandle).toBe(firstHandle);
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
			sessionKey: 'session-1',
			workspaceDir: '/home/openclaw/work',
		});
		const second = await gpuFactory({
			agentWorkspaceDir: '/home/openclaw/work',
			cfg: gondolinSandboxConfig(),
			scopeKey: 'agent:main',
			sessionKey: 'session-1',
			workspaceDir: '/home/openclaw/work',
		});

		expect(first.runtimeId).toBe(testToolVmLeaseId('lease-1'));
		expect(second.runtimeId).toBe(testToolVmLeaseId('lease-2'));
		expect(requestLease).toHaveBeenCalledTimes(2);
	});
});
