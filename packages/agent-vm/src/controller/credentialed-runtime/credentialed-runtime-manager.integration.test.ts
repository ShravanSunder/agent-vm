import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import { createControllerRuntimeOperations } from '../controller-runtime-operations.js';
import { createControllerClient } from '../http/controller-client.js';
import { createControllerApp } from '../http/controller-http-routes.js';
import { startControllerHttpServer } from '../http/controller-http-server.js';
import {
	createCredentialedRuntimeRetirementTestSystemConfig,
	createUnavailableCredentialedRuntimeTestGateway,
	findAvailableCredentialedRuntimeTestPort,
} from './credentialed-runtime-manager-integration-test-support.js';
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
			credentialProjection: {
				credentialBinding: 'google',
				credentialEnvironment: { GOG_DATA_DIR: { kind: 'credential_root' } },
				credentialFiles: [{ path: 'sa-c3VuQGV4YW1wbGUuY29t.json', source: 'service-account' }],
				kind: 'file_binding',
			},
			environment: { kind: 'empty' },
			guestCwd: '/work',
			imageReference: encodeConfiguredCliPreparedImageIdentity({
				fingerprint: 'sha256:gog-image',
				imageReference: '/images/gog',
				schemaVersion: 1,
			}),
			kind: 'ephemeral_managed_vm',
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
		readonly agentRuntimeRevision?: string;
		readonly operationName?: string;
		readonly zoneId?: string;
	} = {},
): CredentialedRuntimeResolution {
	const agentId = options.agentId ?? 'sun';
	return {
		agentRuntimeRevision: options.agentRuntimeRevision ?? `sha256:group-${agentId}`,
		agentId,
		cohortRevision: 'binding:current',
		projection: {
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
			kind: 'file_binding',
		},
		namespaceId: 'google',
		operation: operation(),
		operationName: options.operationName ?? 'calendar_list',
		profileId: 'google-enabled',
		zoneId: options.zoneId ?? 'zone-a',
	};
}

function mediatedResolution(): CredentialedRuntimeResolution {
	const fileResolution = resolution();
	const configuredOperation = structuredClone(fileResolution.operation);
	if (configuredOperation.executionTarget.kind !== 'ephemeral_managed_vm') {
		throw new Error('Expected Managed VM target.');
	}
	configuredOperation.executionTarget.credentialProjection = {
		environment: {
			GOOGLE_PLACES_API_KEY: {
				hosts: ['places.googleapis.com'],
				secret: { name: 'GOOGLE_PLACES_API_KEY', source: 'environment' },
			},
		},
		kind: 'http_mediation',
	};
	return {
		...fileResolution,
		agentRuntimeRevision: 'sha256:mediated-agent-runtime',
		operation: configuredOperation,
		projection: {
			environment: {
				GOOGLE_PLACES_API_KEY: {
					hosts: ['places.googleapis.com'],
					secret: { ref: 'GOOGLE_PLACES_API_KEY', source: 'environment' },
				},
			},
			kind: 'http_mediation',
		},
	};
}

function oauthResolution(agentRuntimeRevision: string): CredentialedRuntimeResolution {
	const fileResolution = resolution({ agentRuntimeRevision });
	const configuredOperation = structuredClone(fileResolution.operation);
	if (configuredOperation.executionTarget.kind !== 'ephemeral_managed_vm') {
		throw new Error('Expected Managed VM target.');
	}
	configuredOperation.executionTarget.allowedHosts = ['gmail.googleapis.com'];
	configuredOperation.executionTarget.credentialProjection = {
		environment: { GOG_ACCESS_TOKEN: { kind: 'oauth_access_token' } },
		kind: 'http_mediation',
	};
	return {
		...fileResolution,
		agentRuntimeRevision,
		operation: configuredOperation,
		projection: {
			environmentName: 'GOG_ACCESS_TOKEN',
			kind: 'oauth_http_mediation',
		},
	};
}

function createFixture(
	now: () => number,
	options: {
		readonly afterRecordWrite?: (kind: CredentialedRuntimeRecord['kind']) => Promise<void>;
		readonly beforeManagedVmCreate?: () => Promise<void>;
		readonly beforeResolveAll?: () => Promise<void>;
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
	const resolveAll = vi.fn(async (refs: Readonly<Record<string, unknown>>) => {
		await options.beforeResolveAll?.();
		return Object.fromEntries(
			Object.keys(refs).map((name) => [
				name,
				name === 'service-account' ? '{"type":"service_account"}' : `secret:${name}`,
			]),
		);
	});
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
			let writtenKind: CredentialedRuntimeRecord['kind'] | undefined;
			await delegateRecordWriter.write(context, (base) => {
				const record = build(base);
				writtenKind = record.kind;
				if (failingRecordKinds.delete(record.kind)) {
					throw new Error(`forced ${record.kind} record failure`);
				}
				return record;
			});
			if (writtenKind !== undefined) await options.afterRecordWrite?.(writtenKind);
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

describe('credentialed runtime manager', () => {
	it('reserves the agent slot before dynamic OAuth materialization and clears the supplied bytes', async () => {
		const fixture = createFixture(() => 1_000);
		const accessTokenBytes = new TextEncoder().encode('oauth-access-token-marker');
		const materializeResolution = vi.fn(async () => ({
			dynamicHttpMediation: {
				allowedHosts: ['gmail.googleapis.com'],
				credentialId: 'credential-a',
				environmentName: 'GOG_ACCESS_TOKEN',
				kind: 'dynamic_http_mediation' as const,
				materialRevision: 'sha256:material-a',
				placeholderValue: 'GONDOLIN_SECRET_TEST_PLACEHOLDER',
				secretValue: accessTokenBytes,
			},
			resolution: oauthResolution('sha256:oauth-runtime-a'),
		}));

		const first = await fixture.manager.acquireCommand({
			finalAuthorization: async () => true,
			materializeResolution,
			operationId: 'oauth-operation-a',
			ownerIdentity,
			runtimeIdentity: { agentId: 'sun', zoneId: 'zone-a' },
		});
		if (first.kind !== 'acquired') throw new Error('Expected OAuth acquisition.');
		expect(materializeResolution).toHaveBeenCalledOnce();
		expect(fixture.states[0]?.requests[0]).toMatchObject({
			environment: { GOG_ACCESS_TOKEN: 'GONDOLIN_SECRET_TEST_PLACEHOLDER' },
			mediatedSecrets: [
				{
					allowedHosts: ['gmail.googleapis.com'],
					environmentVariable: 'GOG_ACCESS_TOKEN',
					guestPlaceholder: 'GONDOLIN_SECRET_TEST_PLACEHOLDER',
				},
			],
		});
		expect([...accessTokenBytes]).toEqual(
			Array.from({ length: accessTokenBytes.byteLength }, () => 0),
		);

		const materializeWhileBusy = vi.fn(async () => ({
			resolution: oauthResolution('sha256:oauth-runtime-b'),
		}));
		await expect(
			fixture.manager.acquireCommand({
				finalAuthorization: async () => true,
				materializeResolution: materializeWhileBusy,
				operationId: 'oauth-operation-b',
				ownerIdentity,
				runtimeIdentity: { agentId: 'sun', zoneId: 'zone-a' },
			}),
		).resolves.toEqual({ kind: 'busy', retryable: true });
		expect(materializeWhileBusy).not.toHaveBeenCalled();
		await first.command.complete({ kind: 'completed' });
	});

	it('retires the prior agent runtime before admitting changed OAuth material', async () => {
		const fixture = createFixture(() => 1_000);
		const acquireOAuthMaterial = async (
			revision: string,
		): Promise<Awaited<ReturnType<CredentialedRuntimeManager['acquireCommand']>>> => {
			const secretValue = new TextEncoder().encode(`access-token-${revision}`);
			return await fixture.manager.acquireCommand({
				finalAuthorization: async () => true,
				materializeResolution: async () => ({
					dynamicHttpMediation: {
						allowedHosts: ['gmail.googleapis.com'],
						credentialId: 'credential-a',
						environmentName: 'GOG_ACCESS_TOKEN',
						kind: 'dynamic_http_mediation',
						materialRevision: revision,
						placeholderValue: `placeholder-${revision}`,
						secretValue,
					},
					resolution: oauthResolution(`sha256:oauth-runtime-${revision}`),
				}),
				operationId: `operation-${revision}`,
				ownerIdentity,
				runtimeIdentity: { agentId: 'sun', zoneId: 'zone-a' },
			});
		};

		const first = await acquireOAuthMaterial('material-a');
		if (first.kind !== 'acquired') throw new Error('Expected first OAuth acquisition.');
		await first.command.complete({ kind: 'completed' });
		const second = await acquireOAuthMaterial('material-b');
		if (second.kind !== 'acquired') throw new Error('Expected replacement OAuth acquisition.');

		expect(fixture.createManagedVm).toHaveBeenCalledTimes(2);
		expect(fixture.states[0]?.closed).toBe(true);
		expect(fixture.states[1]?.started).toBe(true);
		await second.command.complete({ kind: 'completed' });
	});

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

	it('returns busy during credential resolution without a second resolution or VM effect', async () => {
		let releaseResolution: (() => void) | undefined;
		const resolutionGate = new Promise<void>((resolve) => {
			releaseResolution = resolve;
		});
		const fixture = createFixture(() => 1_000, {
			beforeResolveAll: async () => await resolutionGate,
		});
		const provisioning = acquire(fixture, mediatedResolution());
		await vi.waitFor(() => expect(fixture.resolveAll).toHaveBeenCalledOnce());
		await expect(acquire(fixture)).resolves.toEqual({ kind: 'busy', retryable: true });
		expect(fixture.resolveAll).toHaveBeenCalledOnce();
		expect(fixture.createManagedVm).not.toHaveBeenCalled();
		releaseResolution?.();
		const acquired = await provisioning;
		if (acquired.kind !== 'acquired') throw new Error('Expected acquisition after resolution.');
		await acquired.command.complete({ kind: 'completed' });
	});

	it('projects HTTP-mediated credentials as placeholders without a credential mount', async () => {
		const fixture = createFixture(() => 1_000);
		const acquired = await acquire(fixture, mediatedResolution());
		if (acquired.kind !== 'acquired') throw new Error('Expected mediated acquisition.');
		const request = fixture.createManagedVm.mock.calls[0]?.[0] as
			| ManagedVmCreateRequest
			| undefined;
		expect(request?.mounts).toEqual({});
		expect(request?.environment.GOOGLE_PLACES_API_KEY).toMatch(/^GONDOLIN_SECRET_[0-9a-f]{48}$/u);
		expect(request?.mediatedSecrets).toEqual([
			expect.objectContaining({
				allowedHosts: ['places.googleapis.com'],
				environmentVariable: 'GOOGLE_PLACES_API_KEY',
				value: 'secret:GOOGLE_PLACES_API_KEY',
			}),
		]);
		expect(request?.mediatedSecrets[0]?.guestPlaceholder).toBe(
			request?.environment.GOOGLE_PLACES_API_KEY,
		);
		expect(fixture.states[0]?.finalized).toBe(false);
		await acquired.command.complete({ kind: 'completed' });
	});

	it('separates agents even when they share one profile', async () => {
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
		const second = await acquire(fixture, resolution({ agentRuntimeRevision: 'sha256:changed' }));
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

	it.each([
		['new', 'cancel'],
		['reused', 'cancel'],
		['new', 'close'],
		['reused', 'close'],
	] as const)(
		'contains a %s runtime when %s invalidates admission during active publication',
		async (runtimeState, invalidation) => {
			let pauseActivePublication = false;
			let markActivePublicationStarted: (() => void) | undefined;
			let releaseActivePublication: (() => void) | undefined;
			const activePublicationStarted = new Promise<void>((resolve) => {
				markActivePublicationStarted = resolve;
			});
			const activePublicationGate = new Promise<void>((resolve) => {
				releaseActivePublication = resolve;
			});
			const fixture = createFixture(() => 1_000, {
				afterRecordWrite: async (kind) => {
					if (!pauseActivePublication || kind !== 'current-active') return;
					markActivePublicationStarted?.();
					await activePublicationGate;
				},
			});
			if (runtimeState === 'reused') {
				const initial = await acquire(fixture);
				if (initial.kind !== 'acquired') throw new Error('Expected initial acquisition.');
				await initial.command.complete({ kind: 'completed' });
			}
			pauseActivePublication = true;
			const admissionController = new AbortController();
			const acquiring = fixture.manager.acquireCommand({
				admissionSignal: admissionController.signal,
				finalAuthorization: async () => true,
				operationId: `active-publication-${runtimeState}-${invalidation}`,
				ownerIdentity,
				resolution: resolution(),
			});
			await activePublicationStarted;
			const closing =
				invalidation === 'close' ? fixture.manager.closeZone('zone-a') : Promise.resolve();
			if (invalidation === 'cancel') admissionController.abort(new Error('call expired'));
			releaseActivePublication?.();

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
				zoneId: 'zone-a',
			}),
		).toEqual({ kind: 'active', retryable: true });
		await active.command.complete({ kind: 'completed' });
		expect(
			await fixture.manager.retire({
				agentId: 'sun',
				force: false,
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
			zoneId: 'zone-a',
		});
		await Promise.resolve();
		await active.command.complete({ kind: 'retire', reason: 'operator force retirement' });
		await expect(retirement).resolves.toEqual({ kind: 'retired' });
		expect(fixture.states[0]?.closed).toBe(true);
	});

	it('composes CLI, authenticated HTTP, and manager retirement results', async () => {
		const fixture = createFixture(() => 1_000);
		const port = await findAvailableCredentialedRuntimeTestPort();
		const adminToken = 'credential-runtime-admin-token';
		const systemConfig = createCredentialedRuntimeRetirementTestSystemConfig({
			adminToken,
			port,
			testRoot,
		});
		const unavailableGatewayRuntime = createUnavailableCredentialedRuntimeTestGateway();
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
				controllerClient.retireCredentialedRuntime?.('zone-a', {
					agentId: 'sun',
					force: false,
				}),
			).rejects.toThrow('HTTP 401');
			await expect(
				controllerClient.retireCredentialedRuntime?.('zone-a', {
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
				agentRuntimeRevision: 'sha256:old',
				parentGatewayVmId: 'gateway-vm-old',
				recordId: `record-${kind}`,
				recordVersion: 2 as const,
				runtimeEpoch: 'runtime-old',
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

	it('contains exact-base version 1 records without restoring runtime-id authority', async () => {
		const zoneId = 'zone-legacy-v1';
		const fixture = createFixture(() => 5_000);
		const recordsDirectoryPath = path.join(testRoot, 'zones', zoneId, 'credentialed-runtimes');
		await mkdir(recordsDirectoryPath, { recursive: true });
		await writeFile(
			path.join(recordsDirectoryPath, 'legacy-v1.json'),
			JSON.stringify({
				agentId: 'sun',
				controllerEpoch: 'controller-old',
				gatewayEpoch: 'gateway-old',
				generation: 1,
				groupRevision: 'sha256:legacy-group',
				identity: {
					command: 'qemu legacy credentialed recovery',
					hostProcessId: 42_001,
					processStartIdentity: 'legacy-recovery-start',
					vmId: 'legacy-recovery-vm',
				},
				kind: 'identity-published',
				parentGatewayVmId: 'gateway-vm-old',
				recordId: 'legacy-v1',
				recordVersion: 1,
				runtimeEpoch: 'runtime-old',
				runtimeId: 'legacy-runtime-id',
				stablePrincipal: 'a'.repeat(64),
				updatedAtMs: 4_000,
				vmId: 'legacy-recovery-vm',
				zoneId,
			}),
			'utf8',
		);

		await fixture.manager.recoverZone(zoneId);
		expect(fixture.exactTerminate).toHaveBeenCalledOnce();
		expect(fixture.createManagedVm).not.toHaveBeenCalled();
		expect(
			await createCredentialedRuntimeRecordStore({ recordsDirectoryPath }).listRecords(),
		).toEqual([]);
	});

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
				agentRuntimeRevision: 'sha256:group-sun',
				kind: 'vm-created',
				parentGatewayVmId: 'gateway-vm-old',
				recordId: 'record-owner-unsafe',
				recordVersion: 2,
				runtimeEpoch: 'runtime-old',
				stablePrincipal: 'a'.repeat(64),
				updatedAtMs: 4_000,
				vmId: 'unknown-live-vm',
				zoneId,
			},
			result: undefined,
		}));

		await fixture.manager.recoverZone(zoneId);
		expect(fixture.exactTerminate).not.toHaveBeenCalled();
		expect(await store.listRecords()).toEqual([
			expect.objectContaining({
				containment: 'unproven',
				kind: 'owner-unsafe',
				reason: 'startup process identity was unavailable',
			}),
		]);
		await expect(fixture.manager.closeZone(zoneId)).rejects.toThrow('owner-unsafe');
		expect(await acquire(fixture, resolution({ agentId: 'sun', zoneId }))).toMatchObject({
			kind: 'not-dispatched',
			reason: 'credentialed runtime zone is stopping',
		});
		expect(fixture.createManagedVm).not.toHaveBeenCalled();

		const restartedFixture = createFixture(() => 6_000);
		await restartedFixture.manager.recoverZone(zoneId);
		expect(restartedFixture.exactTerminate).not.toHaveBeenCalled();
		expect(await acquire(restartedFixture, resolution({ agentId: 'sun', zoneId }))).toMatchObject({
			kind: 'owner-unsafe',
		});
	});

	it('contains every live runtime before reporting a recovered owner-unsafe fence', async () => {
		const zoneId = 'zone-partially-owner-unsafe';
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
				agentRuntimeRevision: 'sha256:group-sun',
				kind: 'vm-created',
				parentGatewayVmId: 'gateway-vm-old',
				recordId: 'record-owner-unsafe',
				recordVersion: 2,
				runtimeEpoch: 'runtime-old',
				stablePrincipal: 'a'.repeat(64),
				updatedAtMs: 4_000,
				vmId: 'unknown-live-vm',
				zoneId,
			},
			result: undefined,
		}));

		await fixture.manager.recoverZone(zoneId);
		const live = await acquire(fixture, resolution({ agentId: 'moon', zoneId }));
		if (live.kind !== 'acquired') throw new Error('Expected live runtime.');
		await live.command.complete({ kind: 'completed' });

		await expect(fixture.manager.closeZone(zoneId)).rejects.toThrow('owner-unsafe');
		expect(fixture.states).toEqual([expect.objectContaining({ closed: true })]);
	});
});
