import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	encodeConfiguredCliPreparedImageIdentity,
	type EffectiveControllerExecutionOperation,
} from '@agent-vm/config-contracts';
import type {
	ManagedVm,
	ManagedVmCreateRequest,
	ManagedVmExecOptions,
	ManagedVmExecProcess,
	ManagedVmExecResult,
} from '@agent-vm/managed-vm';
import { formatMessage, parseSync } from '@optique/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultCliDependencies, type CliIo } from '../../cli/agent-vm-cli-support.js';
import { dispatchAgentVmCommand } from '../../cli/agent-vm-command-dispatcher.js';
import { agentVmRootParser } from '../../cli/agent-vm-command-parser.js';
import type { LoadedSystemConfig } from '../../config/system-config.js';
import { createControllerRuntimeOperations } from '../controller-runtime-operations.js';
import { createControllerClient } from '../http/controller-client.js';
import { createControllerApp } from '../http/controller-http-routes.js';
import { startControllerHttpServer } from '../http/controller-http-server.js';
import {
	createCredentialedRuntimeManager,
	CredentialedRuntimeIdleTtlMs,
	type CredentialedRuntimeManager,
	type CredentialedRuntimeOwnerIdentity,
} from './credentialed-runtime-manager.js';
import {
	createCredentialedRuntimeRecordWriter,
	type CredentialedRuntimeRecordWriter,
} from './credentialed-runtime-record-writer.js';
import {
	createCredentialedRuntimeRecordStore,
	type CredentialedRuntimeRecord,
} from './credentialed-runtime-record.js';
import type { CredentialedRuntimeResolution } from './credentialed-runtime-registry.js';

type ConfiguredOperation = Extract<
	EffectiveControllerExecutionOperation,
	{ readonly kind: 'configured_cli' }
>;

interface FakeVmState {
	closed: boolean;
	execCallCount: number;
	finalized: boolean;
	hostProcessId: number | null;
	readonly id: string;
	lastExecSignal: AbortSignal | undefined;
	readonly requests: readonly ManagedVmCreateRequest[];
	started: boolean;
}

interface ManagerFixture {
	readonly createManagedVm: ReturnType<typeof vi.fn>;
	readonly exactTerminate: ReturnType<typeof vi.fn>;
	readonly manager: ReturnType<typeof createCredentialedRuntimeManager>;
	readonly readProcessIdentity: ReturnType<typeof vi.fn>;
	readonly resolveAll: ReturnType<typeof vi.fn>;
	readonly states: FakeVmState[];
}

const ownerIdentity: CredentialedRuntimeOwnerIdentity = {
	controllerEpoch: 'controller-a',
	gatewayEpoch: 'gateway-a',
	parentGatewayVmId: 'gateway-vm-a',
	runtimeEpoch: 'runtime-a',
	stablePrincipal: 'a'.repeat(64),
};

let testRoot: string;

beforeEach(async () => {
	testRoot = await mkdtemp(path.join(tmpdir(), 'credentialed-runtime-manager-'));
});

afterEach(async () => {
	await rm(testRoot, { force: true, recursive: true });
});

function operation(): ConfiguredOperation {
	return {
		calls: { deny: [], requiresApproval: [], withoutApproval: 'remaining_admitted' },
		commands: [{ flagRules: [], path: ['calendar', 'list'] }],
		deniedPatterns: [],
		executablePath: '/usr/local/bin/gog',
		executionTarget: {
			allowedHosts: ['www.googleapis.com'],
			credentialBinding: 'google',
			credentialEnvironment: { GOG_DATA_DIR: { kind: 'credential_root' } },
			credentialFiles: [{ path: 'sa-c3VuQGV4YW1wbGUuY29t.json', source: 'service-account' }],
			environment: { kind: 'empty' },
			guestCwd: '/work',
			imageReference: encodeConfiguredCliPreparedImageIdentity({
				fingerprint: 'sha256:gog-image',
				imageReference: '/images/gog',
				schemaVersion: 1,
			}),
			kind: 'ephemeral_managed_vm',
			runtimeId: 'google-workspace',
		},
		kind: 'configured_cli',
		mandatoryArgvPrefix: [],
		output: {
			modelVisibleStderr: 'none',
			overflow: 'truncate',
			stderrMaxBytes: 1024,
			stdoutMaxBytes: 1024,
		},
		safeHelp: 'List calendar events.',
		stdin: { kind: 'none' },
		timeout: { kind: 'quick' },
	};
}

function resolution(
	options: {
		readonly agentId?: string;
		readonly groupRevision?: string;
		readonly operationName?: string;
		readonly zoneId?: string;
	} = {},
): CredentialedRuntimeResolution {
	const agentId = options.agentId ?? 'sun';
	return {
		agentId,
		cohortRevision: 'binding:current',
		credentialBinding: {
			files: {
				'service-account': {
					ref: `op://agent-vm-testing/google/${agentId}`,
					source: '1password',
				},
			},
		},
		credentialEnvironment: { GOG_DATA_DIR: { kind: 'credential_root' } },
		fileMappings: [{ path: 'sa-c3VuQGV4YW1wbGUuY29t.json', source: 'service-account' }],
		groupRevision: options.groupRevision ?? `sha256:group-${agentId}`,
		namespaceId: 'google',
		operation: operation(),
		operationName: options.operationName ?? 'calendar_list',
		profileId: 'google-enabled',
		runtimeId: 'google-workspace',
		zoneId: options.zoneId ?? 'zone-a',
	};
}

function createFixture(
	now: () => number,
	options: {
		readonly beforeManagedVmCreate?: () => Promise<void>;
		readonly failingRecordKinds?: readonly CredentialedRuntimeRecord['kind'][];
	} = {},
): ManagerFixture {
	const states: FakeVmState[] = [];
	const createManagedVm = vi.fn(async (request: ManagedVmCreateRequest): Promise<ManagedVm> => {
		await options.beforeManagedVmCreate?.();
		const ordinal = states.length + 1;
		const state: FakeVmState = {
			closed: false,
			execCallCount: 0,
			finalized: false,
			hostProcessId: null,
			id: `credentialed-vm-${String(ordinal)}`,
			lastExecSignal: undefined,
			requests: [request],
			started: false,
		};
		states.push(state);
		const exec = vi.fn(
			(_argv: readonly string[], execOptions: ManagedVmExecOptions = {}): ManagedVmExecProcess => {
				state.execCallCount += 1;
				state.lastExecSignal = execOptions.signal;
				const stdoutBuffer = Buffer.from(`vm:${state.id}`);
				const result: ManagedVmExecResult = {
					exitCode: 0,
					json: <TValue>(): TValue => JSON.parse(stdoutBuffer.toString('utf8')) as TValue,
					lines: () => [stdoutBuffer.toString('utf8')],
					ok: true,
					stderr: '',
					stderrBuffer: Buffer.alloc(0),
					stdout: stdoutBuffer.toString('utf8'),
					stdoutBuffer,
					toString: () => stdoutBuffer.toString('utf8'),
				};
				const resultPromise = Promise.resolve(result);
				return Object.assign(resultPromise, {
					[Symbol.asyncIterator]: async function* () {},
					end: vi.fn(),
					lines: async function* () {},
					output: async function* () {
						yield {
							data: stdoutBuffer,
							stream: 'stdout' as const,
							text: stdoutBuffer.toString('utf8'),
						};
					},
					resize: vi.fn(),
					result: resultPromise,
					write: vi.fn(),
				});
			},
		);
		return {
			close: async () => {
				state.closed = true;
				state.hostProcessId = null;
			},
			exec,
			finalizeMemoryMount: async () => {
				state.finalized = true;
			},
			getHostProcessId: () => state.hostProcessId,
			id: state.id,
			start: async () => {
				state.started = true;
				state.hostProcessId = 20_000 + ordinal;
			},
		} as unknown as ManagedVm;
	});
	const exactTerminate = vi.fn(
		async ({ identity }: { readonly identity: { readonly vmId: string } }) => {
			const state = states.find((candidate) => candidate.id === identity.vmId);
			if (state !== undefined) state.hostProcessId = null;
			return { hostProcessId: 20_000, kind: 'terminated' as const };
		},
	);
	const resolveAll = vi.fn(async () => ({ 'service-account': '{"type":"service_account"}' }));
	const readProcessIdentity = vi.fn<
		(hostProcessId: number) => Promise<{ readonly command: string; readonly lstart: string } | null>
	>(async (hostProcessId) => ({
		command: `qemu credentialed ${String(hostProcessId)}`,
		lstart: `start-${String(hostProcessId)}`,
	}));
	const delegateRecordWriter = createCredentialedRuntimeRecordWriter({
		controllerStateDir: testRoot,
	});
	const failingRecordKinds = new Set(options.failingRecordKinds ?? []);
	const recordWriter: CredentialedRuntimeRecordWriter = {
		delete: async (zoneId, recordId): Promise<void> =>
			await delegateRecordWriter.delete(zoneId, recordId),
		recordsDirectoryPath: (zoneId): string => delegateRecordWriter.recordsDirectoryPath(zoneId),
		write: async (
			...writeArguments: Parameters<typeof delegateRecordWriter.write>
		): Promise<void> => {
			const [context, build] = writeArguments;
			await delegateRecordWriter.write(context, (base) => {
				const record = build(base);
				if (failingRecordKinds.delete(record.kind)) {
					throw new Error(`forced ${record.kind} record failure`);
				}
				return record;
			});
		},
	};
	return {
		createManagedVm,
		exactTerminate,
		manager: createCredentialedRuntimeManager({
			controllerStateDir: testRoot,
			exactProcessTermination: { terminateRecordedHostProcess: exactTerminate },
			managedVmFactory: { createManagedVm },
			now,
			readProcessIdentity,
			recordWriter,
			secretResolver: { resolve: vi.fn(), resolveAll },
			sleep: async () => {},
		}),
		readProcessIdentity,
		resolveAll,
		states,
	};
}

async function acquire(
	fixture: ManagerFixture,
	runtimeResolution = resolution(),
): Promise<Awaited<ReturnType<CredentialedRuntimeManager['acquireCommand']>>> {
	return await fixture.manager.acquireCommand({
		finalAuthorization: async () => true,
		operationId: crypto.randomUUID(),
		ownerIdentity,
		resolution: runtimeResolution,
	});
}

async function findAvailablePort(): Promise<number> {
	const reservation = createServer();
	await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
	const address = reservation.address();
	if (address === null || typeof address === 'string') {
		throw new Error('Port reservation did not expose a TCP port.');
	}
	await new Promise<void>((resolve, reject) =>
		reservation.close((error) => (error ? reject(error) : resolve())),
	);
	return address.port;
}

describe('credentialed runtime manager', () => {
	it('reuses one runtime across independently acquired compatible operations', async () => {
		let nowMs = 1_000;
		const fixture = createFixture(() => nowMs);
		const first = await acquire(fixture);
		if (first.kind !== 'acquired') throw new Error('Expected first acquisition.');
		expect(await first.command.exec({ argv: ['calendar', 'list'], reason: 'first' })).toMatchObject(
			{
				stdout: 'vm:credentialed-vm-1',
			},
		);
		await first.command.complete({ kind: 'completed' });

		nowMs += 1_000;
		const second = await acquire(fixture, resolution({ operationName: 'gmail_search' }));
		if (second.kind !== 'acquired') throw new Error('Expected second acquisition.');
		expect(
			await second.command.exec({ argv: ['gmail', 'search'], reason: 'second' }),
		).toMatchObject({
			stdout: 'vm:credentialed-vm-1',
		});
		await second.command.complete({ kind: 'completed' });

		expect(fixture.createManagedVm).toHaveBeenCalledOnce();
		expect(fixture.resolveAll).toHaveBeenCalledOnce();
		expect(fixture.states[0]).toMatchObject({ finalized: true, started: true });
	});

	it('returns busy with no queue, renewal, creation, or late dispatch', async () => {
		const fixture = createFixture(() => 1_000);
		const first = await acquire(fixture);
		if (first.kind !== 'acquired') throw new Error('Expected first acquisition.');
		const busy = await acquire(fixture);
		expect(busy).toEqual({ kind: 'busy', retryable: true });
		expect(fixture.createManagedVm).toHaveBeenCalledOnce();
		await first.command.complete({ kind: 'completed' });
		await Promise.resolve();
		expect(fixture.createManagedVm).toHaveBeenCalledOnce();
	});

	it('separates agents even when profile and runtime id match', async () => {
		const fixture = createFixture(() => 1_000);
		const [sun, moon] = await Promise.all([
			acquire(fixture, resolution({ agentId: 'sun' })),
			acquire(fixture, resolution({ agentId: 'moon' })),
		]);
		expect(sun.kind).toBe('acquired');
		expect(moon.kind).toBe('acquired');
		expect(fixture.createManagedVm).toHaveBeenCalledTimes(2);
		if (sun.kind === 'acquired') await sun.command.complete({ kind: 'completed' });
		if (moon.kind === 'acquired') await moon.command.complete({ kind: 'completed' });
	});

	it('keeps active work through reaping and retires only after the fixed idle TTL', async () => {
		let nowMs = 10_000;
		const fixture = createFixture(() => nowMs);
		const active = await acquire(fixture);
		if (active.kind !== 'acquired') throw new Error('Expected active acquisition.');
		nowMs += CredentialedRuntimeIdleTtlMs * 2;
		await fixture.manager.reapExpired();
		expect(fixture.states[0]?.closed).toBe(false);
		await active.command.complete({ kind: 'completed' });
		nowMs += CredentialedRuntimeIdleTtlMs - 1;
		await fixture.manager.reapExpired();
		expect(fixture.states[0]?.closed).toBe(false);
		nowMs += 1;
		await fixture.manager.reapExpired();
		expect(fixture.states[0]?.closed).toBe(true);
		expect(fixture.exactTerminate).toHaveBeenCalledOnce();
	});

	it('retires an incompatible idle runtime before creating its successor', async () => {
		const fixture = createFixture(() => 1_000);
		const first = await acquire(fixture);
		if (first.kind !== 'acquired') throw new Error('Expected first acquisition.');
		await first.command.complete({ kind: 'completed' });
		const second = await acquire(fixture, resolution({ groupRevision: 'sha256:changed' }));
		expect(second.kind).toBe('acquired');
		expect(fixture.states[0]?.closed).toBe(true);
		expect(fixture.createManagedVm).toHaveBeenCalledTimes(2);
		if (second.kind === 'acquired') await second.command.complete({ kind: 'completed' });
	});

	it.each([
		['missing', null],
		['replaced', { command: 'unrelated process', lstart: 'different start' }],
	] as const)(
		'contains an idle runtime whose process identity is %s before reuse',
		async (_case, identity) => {
			const fixture = createFixture(() => 1_000);
			const first = await acquire(fixture);
			if (first.kind !== 'acquired') throw new Error('Expected first acquisition.');
			await first.command.complete({ kind: 'completed' });
			fixture.readProcessIdentity.mockResolvedValueOnce(identity);

			const second = await acquire(fixture);

			expect(second.kind).toBe('acquired');
			expect(fixture.states[0]?.closed).toBe(true);
			expect(fixture.createManagedVm).toHaveBeenCalledTimes(2);
			if (second.kind === 'acquired') await second.command.complete({ kind: 'completed' });
		},
	);

	it('fences acquisition before draining provisioning during zone close', async () => {
		let releaseProvisioning: (() => void) | undefined;
		const provisioningGate = new Promise<void>((resolve) => {
			releaseProvisioning = resolve;
		});
		const fixture = createFixture(() => 1_000, {
			beforeManagedVmCreate: async () => await provisioningGate,
		});
		const provisioning = acquire(fixture);
		await vi.waitFor(() => expect(fixture.createManagedVm).toHaveBeenCalledOnce());

		const closing = fixture.manager.closeZone('zone-a');
		await expect(acquire(fixture)).resolves.toMatchObject({ kind: 'not-dispatched' });
		releaseProvisioning?.();
		await expect(provisioning).resolves.toMatchObject({ kind: 'not-dispatched' });
		await expect(closing).resolves.toBeUndefined();
		expect(fixture.states[0]?.closed).toBe(true);

		fixture.manager.openZone('zone-a');
		const reopened = await acquire(fixture);
		expect(reopened.kind).toBe('acquired');
		if (reopened.kind === 'acquired') await reopened.command.complete({ kind: 'completed' });
	});

	it.each(['new', 'reused'] as const)(
		'rechecks the zone fence after final authorization for a %s runtime',
		async (runtimeState) => {
			let releaseFinalAuthorization: ((authorized: boolean) => void) | undefined;
			let markFinalAuthorizationStarted: (() => void) | undefined;
			const finalAuthorizationStarted = new Promise<void>((resolve) => {
				markFinalAuthorizationStarted = resolve;
			});
			const finalAuthorizationResult = new Promise<boolean>((resolve) => {
				releaseFinalAuthorization = resolve;
			});
			const fixture = createFixture(() => 1_000);
			if (runtimeState === 'reused') {
				const initial = await acquire(fixture);
				if (initial.kind !== 'acquired') throw new Error('Expected initial acquisition.');
				await initial.command.complete({ kind: 'completed' });
			}

			const acquiring = fixture.manager.acquireCommand({
				finalAuthorization: async () => {
					markFinalAuthorizationStarted?.();
					return await finalAuthorizationResult;
				},
				operationId: `closing-${runtimeState}-runtime`,
				ownerIdentity,
				resolution: resolution(),
			});
			await finalAuthorizationStarted;
			const closing = fixture.manager.closeZone('zone-a');
			releaseFinalAuthorization?.(true);
			const result = await acquiring;
			if (result.kind === 'acquired') {
				await result.command.complete({ kind: 'retire', reason: 'test cleanup' });
			}
			await expect(closing).resolves.toBeUndefined();

			expect(result).toMatchObject({ kind: 'not-dispatched' });
			expect(fixture.states[0]?.execCallCount).toBe(0);
			expect(fixture.states[0]?.closed).toBe(true);
		},
	);

	it('propagates owner-unsafe containment instead of completing zone close', async () => {
		const fixture = createFixture(() => 1_000);
		const acquired = await acquire(fixture);
		if (acquired.kind !== 'acquired') throw new Error('Expected acquisition.');
		await acquired.command.complete({ kind: 'completed' });
		fixture.exactTerminate.mockRejectedValueOnce(new Error('forced exact termination failure'));

		await expect(fixture.manager.closeZone('zone-a')).rejects.toThrow('owner-unsafe');
		fixture.manager.openZone('zone-a');
		await expect(acquire(fixture)).resolves.toMatchObject({ kind: 'owner-unsafe' });
	});

	it.each(['vm-created', 'identity-published', 'current-active'] as const)(
		'contains the runtime when the %s durable transition fails',
		async (failingKind) => {
			const fixture = createFixture(() => 1_000, { failingRecordKinds: [failingKind] });

			const result = await acquire(fixture);

			expect(result.kind).toMatch(/not-dispatched|owner-unsafe/u);
			expect(fixture.states[0]?.closed).toBe(true);
			await expect(fixture.manager.closeZone('zone-a')).resolves.toBeUndefined();
		},
	);

	it('retires a completed runtime when current-idle publication fails', async () => {
		const fixture = createFixture(() => 1_000, { failingRecordKinds: ['current-idle'] });
		const acquired = await acquire(fixture);
		if (acquired.kind !== 'acquired') throw new Error('Expected acquisition.');

		await acquired.command.complete({ kind: 'completed' });

		expect(fixture.states[0]?.closed).toBe(true);
		const replacement = await acquire(fixture);
		expect(replacement.kind).toBe('acquired');
		if (replacement.kind === 'acquired') {
			await replacement.command.complete({ kind: 'completed' });
		}
	});

	it('continues exact containment when retiring publication fails', async () => {
		const fixture = createFixture(() => 1_000, { failingRecordKinds: ['retiring'] });
		const acquired = await acquire(fixture);
		if (acquired.kind !== 'acquired') throw new Error('Expected acquisition.');
		await acquired.command.complete({ kind: 'completed' });

		await expect(
			fixture.manager.retire({
				agentId: 'sun',
				force: false,
				runtimeId: 'google-workspace',
				zoneId: 'zone-a',
			}),
		).resolves.toEqual({ kind: 'retired' });
		expect(fixture.states[0]?.closed).toBe(true);
	});

	it('fences the key when terminal containment evidence cannot be persisted', async () => {
		const fixture = createFixture(() => 1_000, {
			failingRecordKinds: ['contained-terminal'],
		});
		const acquired = await acquire(fixture);
		if (acquired.kind !== 'acquired') throw new Error('Expected acquisition.');
		await acquired.command.complete({ kind: 'completed' });

		await expect(
			fixture.manager.retire({
				agentId: 'sun',
				force: false,
				runtimeId: 'google-workspace',
				zoneId: 'zone-a',
			}),
		).resolves.toEqual({ kind: 'owner-unsafe', retryable: false });
		expect(fixture.states[0]?.closed).toBe(true);
		await expect(acquire(fixture)).resolves.toMatchObject({ kind: 'owner-unsafe' });
	});

	it('retires a newly created runtime when final authorization changes before the slot', async () => {
		const fixture = createFixture(() => 1_000);
		const result = await fixture.manager.acquireCommand({
			finalAuthorization: async () => false,
			operationId: 'stale-operation',
			ownerIdentity,
			resolution: resolution(),
		});
		expect(result.kind).toBe('not-dispatched');
		expect(fixture.states[0]?.closed).toBe(true);
		expect(fixture.createManagedVm).toHaveBeenCalledOnce();
	});

	it('contains a started runtime when process identity inspection fails', async () => {
		const fixture = createFixture(() => 1_000);
		fixture.readProcessIdentity.mockRejectedValueOnce(new Error('forced identity read failure'));

		await expect(acquire(fixture)).resolves.toMatchObject({ kind: 'not-dispatched' });
		expect(fixture.states[0]?.closed).toBe(true);
	});

	it('returns active for ordinary operator retirement and retires when idle', async () => {
		const fixture = createFixture(() => 1_000);
		const active = await acquire(fixture);
		if (active.kind !== 'acquired') throw new Error('Expected active acquisition.');
		expect(
			await fixture.manager.retire({
				agentId: 'sun',
				force: false,
				runtimeId: 'google-workspace',
				zoneId: 'zone-a',
			}),
		).toEqual({ kind: 'active', retryable: true });
		await active.command.complete({ kind: 'completed' });
		expect(
			await fixture.manager.retire({
				agentId: 'sun',
				force: false,
				runtimeId: 'google-workspace',
				zoneId: 'zone-a',
			}),
		).toEqual({ kind: 'retired' });
	});

	it('force retirement cancels active ownership and waits for command disposition', async () => {
		const fixture = createFixture(() => 1_000);
		const active = await acquire(fixture);
		if (active.kind !== 'acquired') throw new Error('Expected active acquisition.');
		const retirement = fixture.manager.retire({
			agentId: 'sun',
			force: true,
			runtimeId: 'google-workspace',
			zoneId: 'zone-a',
		});
		await Promise.resolve();
		await active.command.complete({ kind: 'retire', reason: 'operator force retirement' });
		await expect(retirement).resolves.toEqual({ kind: 'retired' });
		expect(fixture.states[0]?.closed).toBe(true);
	});

	it('composes CLI, authenticated HTTP, and manager retirement results', async () => {
		const fixture = createFixture(() => 1_000);
		const port = await findAvailablePort();
		const adminToken = 'credential-runtime-admin-token';
		const systemConfig = {
			schemaVersion: 2,
			storageRootDir: testRoot,
			cacheDir: path.join(testRoot, 'cache'),
			controllerStateDir: path.join(testRoot, 'controller-state'),
			controllerRuntimeDir: path.join(testRoot, 'controller-runtime'),
			systemConfigPath: path.join(testRoot, 'config', 'system.json'),
			host: {
				controllerPort: port,
				projectNamespace: 'credential-runtime-integration',
			},
			imageProfiles: {
				gateways: {
					hermes: {
						type: 'hermes',
						buildConfig: './vm-images/gateways/hermes/build-config.json',
					},
				},
				toolVms: {},
			},
			zones: [
				{
					id: 'zone-a',
					adminAccess: {
						mode: 'secret',
						secret: { source: 'config', value: adminToken },
					},
					gateway: {
						type: 'hermes',
						imageProfile: 'hermes',
						memory: '2G',
						cpus: 2,
						port: 18_793,
						config: './config/hermes/config.yaml',
						profilesByAgent: {},
						profileSecretProjectionsByAgent: {},
						stateDir: path.join(testRoot, 'zone-a', 'state'),
						zoneFilesDir: path.join(testRoot, 'zone-a', 'zone-files'),
						zoneRuntimeDir: path.join(testRoot, 'zone-a', 'runtime'),
					},
					secrets: {},
					egressHosts: [{ host: 'www.googleapis.com', audience: 'gateway' }],
				},
			],
			toolVmProfiles: {},
			tcpPool: { basePort: 19_000, size: 2 },
		} satisfies LoadedSystemConfig;
		const unavailableGatewayRuntime = {
			destroy: async () => ({ ok: true as const, purged: false, zoneId: 'zone-a' }),
			enableSsh: async () => {
				throw new Error('not used');
			},
			exec: async () => {
				throw new Error('not used');
			},
			getHealth: async () => ({ ok: true, observation: 'not used', zoneId: 'zone-a' }),
			getLogs: async () => ({ output: '', zoneId: 'zone-a' }),
			getServiceHealth: async () => ({ ok: true, observation: 'not used', zoneId: 'zone-a' }),
			refreshCredentials: async () => ({ ok: true as const, zoneId: 'zone-a' }),
			upgrade: async () => ({ ok: true as const, zoneId: 'zone-a' }),
		};
		const operations = createControllerRuntimeOperations({
			destroyZoneRuntime: async () => ({ ok: true, purged: false, zoneId: 'zone-a' }),
			getActiveLeases: () => [],
			getManagedGatewayRuntime: () => unavailableGatewayRuntime,
			getRuntimeStatusByZone: () => ({}),
			retireCredentialedRuntime: async (request) => await fixture.manager.retire(request),
			secretResolver: {
				resolve: async (secret) =>
					secret.source === 'config'
						? secret.value
						: Promise.reject(new Error('unexpected secret')),
				resolveAll: async () => ({}),
			},
			systemConfig,
		});
		const app = createControllerApp({
			leaseManager: {
				createLease: async () => {
					throw new Error('not used');
				},
				listLeases: () => [],
				peekLease: () => undefined,
				releaseLease: async () => {},
				renewLease: async () => {
					throw new Error('not used');
				},
			},
			operations,
			toolVmProfiles: {},
			zoneIds: new Set(['zone-a']),
		});
		const server = await startControllerHttpServer({ app, port });
		const controllerClient = createControllerClient({
			baseUrl: `http://127.0.0.1:${String(port)}`,
		});
		const runCliRetirement = async (force: boolean): Promise<unknown> => {
			const parsed = parseSync(agentVmRootParser, [
				'controller',
				'credential-runtime',
				'retire',
				'--zone',
				'zone-a',
				'--agent',
				'sun',
				'--runtime',
				'google-workspace',
				...(force ? ['--force'] : []),
			]);
			if (!parsed.success) throw new Error(formatMessage(parsed.error));
			let stdout = '';
			const io: CliIo = {
				stderr: { write: () => true },
				stdout: {
					write: (chunk) => {
						stdout += String(chunk);
						return true;
					},
				},
			};
			await dispatchAgentVmCommand(parsed.value, io, {
				...defaultCliDependencies,
				createControllerClient,
				loadSystemConfig: async () => systemConfig,
			});
			return JSON.parse(stdout) as unknown;
		};

		try {
			await expect(
				controllerClient.retireCredentialedRuntime?.('zone-a', 'google-workspace', {
					agentId: 'sun',
					force: false,
				}),
			).rejects.toThrow('HTTP 401');
			await expect(
				controllerClient.retireCredentialedRuntime?.('zone-a', 'google-workspace', {
					adminToken: 'wrong-token',
					agentId: 'sun',
					force: false,
				}),
			).rejects.toThrow('HTTP 403');

			await expect(runCliRetirement(false)).resolves.toEqual({ kind: 'absent' });
			const active = await acquire(fixture);
			if (active.kind !== 'acquired') throw new Error('Expected active runtime.');
			await active.command.exec({ argv: ['calendar', 'list'], reason: 'observe cancellation' });
			const activeSignal = fixture.states[0]?.lastExecSignal;
			if (activeSignal === undefined) throw new Error('Expected active command signal.');
			await expect(runCliRetirement(false)).resolves.toEqual({ kind: 'active', retryable: true });
			const cancellationObserved = new Promise<void>((resolve) => {
				activeSignal.addEventListener('abort', () => resolve(), { once: true });
			});
			const forcedRetirement = runCliRetirement(true);
			await cancellationObserved;
			await active.command.complete({ kind: 'retire', reason: 'operator force retirement' });
			await expect(forcedRetirement).resolves.toEqual({ kind: 'retired' });

			const replacement = await acquire(fixture);
			if (replacement.kind !== 'acquired') throw new Error('Expected replacement runtime.');
			expect(fixture.createManagedVm).toHaveBeenCalledTimes(2);
			await replacement.command.complete({ kind: 'completed' });
			fixture.exactTerminate.mockRejectedValueOnce(new Error('forced containment failure'));
			await expect(runCliRetirement(false)).resolves.toEqual({
				kind: 'owner-unsafe',
				retryable: false,
			});
		} finally {
			await server.close();
		}
	});

	it.each(['identity-published', 'current-active', 'current-idle', 'retiring'] as const)(
		'recovers %s records by exact termination without VM adoption or command replay',
		async (kind) => {
			const zoneId = `zone-${kind}`;
			const fixture = createFixture(() => 5_000);
			const recordsDirectoryPath = path.join(testRoot, 'zones', zoneId, 'credentialed-runtimes');
			const store = createCredentialedRuntimeRecordStore({ recordsDirectoryPath });
			const identity = {
				command: 'qemu credentialed recovery',
				hostProcessId: 42_000,
				processStartIdentity: 'recovery-start',
				vmId: 'recovery-vm',
			};
			const common = {
				agentId: 'sun',
				controllerEpoch: 'controller-old',
				gatewayEpoch: 'gateway-old',
				generation: 1,
				groupRevision: 'sha256:old',
				parentGatewayVmId: 'gateway-vm-old',
				recordId: `record-${kind}`,
				recordVersion: 1 as const,
				runtimeEpoch: 'runtime-old',
				runtimeId: 'google-workspace',
				stablePrincipal: 'a'.repeat(64),
				updatedAtMs: 4_000,
				zoneId,
			};
			const record =
				kind === 'current-active'
					? {
							...common,
							activeOperationId: 'old-operation',
							identity,
							kind,
							startedAtMs: 3_000,
							vmId: identity.vmId,
						}
					: kind === 'current-idle'
						? {
								...common,
								identity,
								idleExpiresAtMs: 6_000,
								kind,
								lastUsedAtMs: 4_000,
								vmId: identity.vmId,
							}
						: kind === 'retiring'
							? {
									...common,
									identity,
									kind,
									reason: 'old shutdown',
									vmId: identity.vmId,
								}
							: { ...common, identity, kind, vmId: identity.vmId };
			await store.mutateRecord(common.recordId, () => ({ nextRecord: record, result: undefined }));

			await fixture.manager.recoverZone(zoneId);
			expect(fixture.exactTerminate).toHaveBeenCalledOnce();
			expect(await store.listRecords()).toEqual([]);
		},
	);

	it('fences a vm-created crash record without an exact process identity', async () => {
		const zoneId = 'zone-owner-unsafe';
		const fixture = createFixture(() => 5_000);
		const store = createCredentialedRuntimeRecordStore({
			recordsDirectoryPath: path.join(testRoot, 'zones', zoneId, 'credentialed-runtimes'),
		});
		await store.mutateRecord('record-owner-unsafe', () => ({
			nextRecord: {
				agentId: 'sun',
				controllerEpoch: 'controller-old',
				gatewayEpoch: 'gateway-old',
				generation: 1,
				groupRevision: 'sha256:group-sun',
				kind: 'vm-created',
				parentGatewayVmId: 'gateway-vm-old',
				recordId: 'record-owner-unsafe',
				recordVersion: 1,
				runtimeEpoch: 'runtime-old',
				runtimeId: 'google-workspace',
				stablePrincipal: 'a'.repeat(64),
				updatedAtMs: 4_000,
				vmId: 'unknown-live-vm',
				zoneId,
			},
			result: undefined,
		}));

		await fixture.manager.recoverZone(zoneId);
		expect(fixture.exactTerminate).not.toHaveBeenCalled();
		expect(await acquire(fixture, resolution({ agentId: 'sun', zoneId }))).toMatchObject({
			kind: 'owner-unsafe',
		});
		expect(fixture.createManagedVm).not.toHaveBeenCalled();
	});
});
