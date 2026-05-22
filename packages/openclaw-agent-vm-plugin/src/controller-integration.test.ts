import { Readable } from 'node:stream';

import type { ToolVmLeasePeek, ToolVmSshLease } from '@agent-vm/gateway-interface';
import type {
	ManagedExecProcess,
	ManagedExecResult,
	ManagedVmFs,
} from '@agent-vm/gondolin-adapter';
import { describe, expect, it, vi } from 'vitest';

import { createControllerApp } from '../../agent-vm/src/controller/http/controller-http-routes.js';
import { createLeaseClient } from './controller-lease-client.js';
import { createGondolinSandboxBackendFactory } from './sandbox-backend-factory.js';

function createLeaseResponse(leaseId: string): ToolVmSshLease {
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
		transport: 'ssh-sandbox' as const,
		workdir: '/work',
	};
}

function createLeasePeekResponse(leaseId: string): ToolVmLeasePeek {
	return {
		createdAt: 1,
		lastUsedAt: 1,
		leaseId,
		profileId: 'standard',
		scopeKey: 'agent:main',
		ssh: { host: 'tool-0.vm.host', port: 22, user: 'root' },
		tcpSlot: 0,
		transport: 'ssh-sandbox' as const,
		workdir: '/work',
		zoneId: 'shravan',
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
				createLease: vi.fn(async () => ({
					agentWorkspaceDir: '/zone',
					createdAt: 1,
					effectiveIdleTtlMs: 300_000,
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
						exec: vi.fn(() => createManagedExecProcessStub()),
						fs: createManagedVmFsStub(),
						id: 'tool-vm-1',
						setIngressRoutes: vi.fn(),
						getVmInstance: vi.fn(),
					},
					hostWorkMountDir: '/home/openclaw/.openclaw/state/sandboxes/work',
					zoneId: 'shravan',
				})),
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
