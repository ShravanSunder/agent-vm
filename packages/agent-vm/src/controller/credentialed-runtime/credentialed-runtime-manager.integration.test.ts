import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	encodeConfiguredCliPreparedImageIdentity,
	type EffectiveControllerExecutionOperation,
} from '@agent-vm/config-contracts';
import type {
	ManagedVm,
	ManagedVmCreateRequest,
	ManagedVmExecProcess,
	ManagedVmExecResult,
} from '@agent-vm/managed-vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	createCredentialedRuntimeManager,
	CredentialedRuntimeIdleTtlMs,
	type CredentialedRuntimeManager,
	type CredentialedRuntimeOwnerIdentity,
} from './credentialed-runtime-manager.js';
import { createCredentialedRuntimeRecordStore } from './credentialed-runtime-record.js';
import type { CredentialedRuntimeResolution } from './credentialed-runtime-registry.js';

type ConfiguredOperation = Extract<
	EffectiveControllerExecutionOperation,
	{ readonly kind: 'configured_cli' }
>;

interface FakeVmState {
	closed: boolean;
	finalized: boolean;
	hostProcessId: number | null;
	readonly id: string;
	readonly requests: readonly ManagedVmCreateRequest[];
	started: boolean;
}

interface ManagerFixture {
	readonly createManagedVm: ReturnType<typeof vi.fn>;
	readonly exactTerminate: ReturnType<typeof vi.fn>;
	readonly manager: ReturnType<typeof createCredentialedRuntimeManager>;
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

function createFixture(now: () => number): ManagerFixture {
	const states: FakeVmState[] = [];
	const createManagedVm = vi.fn(async (request: ManagedVmCreateRequest): Promise<ManagedVm> => {
		const ordinal = states.length + 1;
		const state: FakeVmState = {
			closed: false,
			finalized: false,
			hostProcessId: null,
			id: `credentialed-vm-${String(ordinal)}`,
			requests: [request],
			started: false,
		};
		states.push(state);
		const exec = vi.fn((_argv: readonly string[], _options: unknown): ManagedVmExecProcess => {
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
		});
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
	return {
		createManagedVm,
		exactTerminate,
		manager: createCredentialedRuntimeManager({
			controllerStateDir: testRoot,
			exactProcessTermination: { terminateRecordedHostProcess: exactTerminate },
			managedVmFactory: { createManagedVm },
			now,
			readProcessIdentity: async (hostProcessId) => ({
				command: `qemu credentialed ${String(hostProcessId)}`,
				lstart: `start-${String(hostProcessId)}`,
			}),
			secretResolver: { resolve: vi.fn(), resolveAll },
			sleep: async () => {},
		}),
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
