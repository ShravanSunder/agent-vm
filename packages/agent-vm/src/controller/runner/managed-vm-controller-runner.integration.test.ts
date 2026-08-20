import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, expectTypeOf, it, type Mock, vi } from 'vitest';

import type { ProcessIdentity } from '../../shared/managed-vm-process.js';
import {
	createControllerRunnerOperationLedger,
	type ControllerRunnerOperationAuthority,
	type ControllerRunnerOperationLedger,
	type CreateControllerRunnerOperationLedgerProps,
} from './controller-runner-operation-record.js';
import {
	createManagedVmControllerRunner,
	type ControllerRunnerAuthorizationSnapshot,
	type ControllerRunnerCurrentEpochContext,
	type ControllerRunnerDispatchRequest,
	type CreateManagedVmControllerRunnerOptions,
	type ManagedVmControllerRunnerFactory,
	type ManagedVmControllerRunnerExecRequest,
	type ManagedVmControllerRunnerExecResult,
	type ManagedVmControllerRunnerHandle,
} from './managed-vm-controller-runner.js';

const trustedAuthorization = {
	authorizationFingerprint: 'fingerprint-a',
	cancellation: { timeoutMs: 30_000 },
	cwd: { kind: 'fixed', path: '/work' },
	egress: { allowedHosts: ['registry.npmjs.org'] },
	environment: { AGENT_VM_OPERATION_ID: 'operation-a' },
	executablePath: '/usr/local/bin/npm',
	imageFingerprint: 'image-fingerprint-a',
	imageReference: '/images/runner-a',
	mandatoryArgvPrefix: ['view'],
	output: {
		modelVisibleStderr: 'fixed_safe_summary',
		overflow: 'truncate',
		stderrMaxBytes: 65_536,
		stdoutMaxBytes: 65_536,
	},
	target: { kind: 'ephemeral_managed_vm', zoneId: 'zone-a' },
} as const satisfies ControllerRunnerAuthorizationSnapshot;

const trustedAuthorityContext = {
	controllerEpoch: 'controller-epoch-b',
	gatewayEpoch: 'gateway-epoch-a',
	parentGatewayVmId: 'gateway-vm-a',
	runtimeEpoch: 'runtime-epoch-a',
	stablePrincipal: 'a'.repeat(64),
} as const;

const observedProcessIdentity = {
	command: 'qemu-system-aarch64 -name runner-a',
	lstart: 'Mon Jul 13 18:00:00 2026',
} as const satisfies ProcessIdentity;

const successfulExecutionResult = {
	exitCode: 0,
	stderrTruncated: false,
	stdout: 'runner-output',
	stdoutTruncated: false,
} as const satisfies ManagedVmControllerRunnerExecResult;

const testLedgerRuntime = {
	clock: { now: (): Date => new Date('2026-07-13T18:00:00.000Z') },
} satisfies CreateControllerRunnerOperationLedgerProps['runtime'];

function createDispatchRequest(
	overrides: Partial<ControllerRunnerDispatchRequest> = {},
): ControllerRunnerDispatchRequest {
	return {
		authorizationFingerprint: trustedAuthorization.authorizationFingerprint,
		input: { argv: ['@agent-vm/agent-vm', 'version'], reason: 'integration proof' },
		operationId: 'operation-a',
		...overrides,
	};
}

function createRunnerFactory(
	props: {
		readonly beforeExec?: (request: ManagedVmControllerRunnerExecRequest) => Promise<void>;
		readonly observedEvents?: string[];
	} = {},
): {
	readonly closeRunner: Mock<() => Promise<void>>;
	readonly createRunner: Mock<
		(
			_authorization: ControllerRunnerAuthorizationSnapshot,
		) => Promise<ManagedVmControllerRunnerHandle>
	>;
	readonly executeRunner: Mock<
		(request: ManagedVmControllerRunnerExecRequest) => Promise<ManagedVmControllerRunnerExecResult>
	>;
	readonly factory: ManagedVmControllerRunnerFactory;
	readonly handle: ManagedVmControllerRunnerHandle;
} {
	const observedEvents = props.observedEvents ?? [];
	const closeRunner = vi.fn(async (): Promise<void> => {
		observedEvents.push('runner-closed');
	});
	const executeRunner = vi.fn(async (request: ManagedVmControllerRunnerExecRequest) => {
		observedEvents.push('dispatch-started');
		await props.beforeExec?.(request);
		return successfulExecutionResult;
	});
	const handle = {
		close: closeRunner,
		exec: executeRunner,
		getHostProcessId: vi.fn((): number => 12_345),
		id: 'runner-vm-a',
		start: vi.fn(async (): Promise<void> => {
			observedEvents.push('runner-started');
		}),
	} satisfies ManagedVmControllerRunnerHandle;
	const createRunner = vi.fn(
		async (
			_authorization: ControllerRunnerAuthorizationSnapshot,
		): Promise<ManagedVmControllerRunnerHandle> => handle,
	);
	return {
		closeRunner,
		createRunner,
		executeRunner,
		factory: { create: createRunner },
		handle,
	};
}

function createRunnerOptions(props: {
	readonly currentEpochContext?: ControllerRunnerCurrentEpochContext;
	readonly operationLedger: ControllerRunnerOperationLedger;
	readonly runnerFactory: ManagedVmControllerRunnerFactory;
}): CreateManagedVmControllerRunnerOptions {
	return {
		createRunnerId: (request: ControllerRunnerDispatchRequest): string => {
			return `runner-${request.operationId}`;
		},
		initialAuthorization: trustedAuthorization,
		operationLedger: props.operationLedger,
		readCurrentEpochContext: async () => props.currentEpochContext ?? trustedAuthorityContext,
		readProcessIdentity: vi.fn(async (hostProcessId: number) => {
			expect(hostProcessId).toBe(12_345);
			return observedProcessIdentity;
		}),
		recomputeAuthorization: async (): Promise<ControllerRunnerAuthorizationSnapshot> =>
			trustedAuthorization,
		runnerFactory: props.runnerFactory,
		trustedAuthorityContext,
		validatePublicInput: (): boolean => true,
	};
}

describe('managed VM controller runner durable integration', () => {
	it('publishes real host process identity before dispatch and records terminal containment durably', async () => {
		await using temporaryRuntime = await createTemporaryRuntimeDirectory();
		const operationLedger = createControllerRunnerOperationLedger({
			containPredecessor: async () => ({ kind: 'contained' }),
			controllerEpoch: trustedAuthorityContext.controllerEpoch,
			recordsDirectoryPath: temporaryRuntime.path,
			runtime: testLedgerRuntime,
		});
		const runnerVm = createRunnerFactory({
			beforeExec: async (request: ManagedVmControllerRunnerExecRequest): Promise<void> => {
				expect(request.argv).toEqual([
					trustedAuthorization.executablePath,
					...trustedAuthorization.mandatoryArgvPrefix,
					'@agent-vm/agent-vm',
					'version',
				]);
				await expect(operationLedger.load('operation-a')).resolves.toMatchObject({
					executionFingerprint: trustedAuthorization.authorizationFingerprint,
					identity: {
						command: observedProcessIdentity.command,
						hostProcessId: 12_345,
						processStartIdentity: observedProcessIdentity.lstart,
						vmId: 'runner-vm-a',
					},
					kind: 'running',
					parentGatewayVmId: trustedAuthorityContext.parentGatewayVmId,
					stablePrincipal: trustedAuthorityContext.stablePrincipal,
				});
			},
		});
		const runnerOptions = createRunnerOptions({
			operationLedger,
			runnerFactory: runnerVm.factory,
		});
		const runner = createManagedVmControllerRunner(runnerOptions);

		await expect(runner.execute(createDispatchRequest())).resolves.toEqual({
			binding: { fingerprint: 'fingerprint-a', operationId: 'operation-a' },
			certainty: 'proven',
			completion: 'succeeded',
			diagnostics: [],
			kind: 'completed',
			retryClass: 'forbidden',
			value: successfulExecutionResult,
		});
		await expect(operationLedger.load('operation-a')).resolves.toMatchObject({
			containment: 'proven',
			identity: {
				command: observedProcessIdentity.command,
				hostProcessId: 12_345,
				processStartIdentity: observedProcessIdentity.lstart,
				vmId: 'runner-vm-a',
			},
			kind: 'contained-terminal',
			vmId: 'runner-vm-a',
		});
	});

	it('blocks a same-scope successor after pre-identity work becomes owner-unsafe', async () => {
		await using temporaryRuntime = await createTemporaryRuntimeDirectory();
		const predecessorLedger = createControllerRunnerOperationLedger({
			containPredecessor: async () => ({
				kind: 'owner-unsafe',
				reason: 'identity-not-published',
			}),
			controllerEpoch: 'controller-epoch-a',
			recordsDirectoryPath: temporaryRuntime.path,
			runtime: testLedgerRuntime,
		});
		await recordPreIdentityPredecessor(predecessorLedger);
		const successorLedger = createControllerRunnerOperationLedger({
			containPredecessor: async () => ({
				kind: 'owner-unsafe',
				reason: 'identity-not-published',
			}),
			controllerEpoch: trustedAuthorityContext.controllerEpoch,
			recordsDirectoryPath: temporaryRuntime.path,
			runtime: testLedgerRuntime,
		});
		await successorLedger.recover();
		const runnerVm = createRunnerFactory();
		const runner = createManagedVmControllerRunner(
			createRunnerOptions({
				operationLedger: successorLedger,
				runnerFactory: runnerVm.factory,
			}),
		);

		await expect(
			runner.execute(
				createDispatchRequest({
					operationId: 'operation-successor',
				}),
			),
		).resolves.toEqual({
			binding: { fingerprint: 'fingerprint-a', operationId: 'operation-successor' },
			certainty: 'proven',
			diagnostics: [],
			error: {
				code: 'not_authorized',
				message: 'Controller runner predecessor containment is not proven.',
			},
			kind: 'not-dispatched',
			reason: 'predecessor-owner-unsafe',
			retryClass: 'safe-before-dispatch',
		});
		expect(runnerVm.createRunner).not.toHaveBeenCalled();
		await expect(successorLedger.load('operation-successor')).resolves.toBeNull();
	});

	it('rejects duplicate operation replay before creating another runner VM', async () => {
		await using temporaryRuntime = await createTemporaryRuntimeDirectory();
		const operationLedger = createControllerRunnerOperationLedger({
			containPredecessor: async () => ({ kind: 'contained' }),
			controllerEpoch: trustedAuthorityContext.controllerEpoch,
			recordsDirectoryPath: temporaryRuntime.path,
			runtime: testLedgerRuntime,
		});
		const runnerVm = createRunnerFactory();
		const runner = createManagedVmControllerRunner(
			createRunnerOptions({ operationLedger, runnerFactory: runnerVm.factory }),
		);

		await expect(runner.execute(createDispatchRequest())).resolves.toEqual({
			binding: { fingerprint: 'fingerprint-a', operationId: 'operation-a' },
			certainty: 'proven',
			completion: 'succeeded',
			diagnostics: [],
			kind: 'completed',
			retryClass: 'forbidden',
			value: successfulExecutionResult,
		});
		await expect(runner.execute(createDispatchRequest())).resolves.toEqual({
			binding: { fingerprint: 'fingerprint-a', operationId: 'operation-a' },
			certainty: 'proven',
			diagnostics: [],
			error: {
				code: 'not_authorized',
				message: 'Controller runner operation is already reserved.',
			},
			kind: 'not-dispatched',
			reason: 'duplicate-operation',
			retryClass: 'safe-before-dispatch',
		});
		expect(runnerVm.createRunner).toHaveBeenCalledOnce();
	});

	it('contains a prepared runner without dispatch when its originating epochs are no longer current', async () => {
		await using temporaryRuntime = await createTemporaryRuntimeDirectory();
		const operationLedger = createControllerRunnerOperationLedger({
			containPredecessor: async () => ({ kind: 'contained' }),
			controllerEpoch: trustedAuthorityContext.controllerEpoch,
			recordsDirectoryPath: temporaryRuntime.path,
			runtime: testLedgerRuntime,
		});
		const runnerVm = createRunnerFactory();
		const runner = createManagedVmControllerRunner(
			createRunnerOptions({
				currentEpochContext: {
					...trustedAuthorityContext,
					gatewayEpoch: 'gateway-epoch-b',
					parentGatewayVmId: 'gateway-vm-b',
					runtimeEpoch: 'runtime-epoch-b',
				},
				operationLedger,
				runnerFactory: runnerVm.factory,
			}),
		);

		await expect(runner.execute(createDispatchRequest())).resolves.toEqual({
			binding: { fingerprint: 'fingerprint-a', operationId: 'operation-a' },
			certainty: 'proven',
			diagnostics: [],
			error: {
				code: 'not_authorized',
				message: 'Controller runner authority is no longer current.',
			},
			kind: 'not-dispatched',
			reason: 'current-epoch-changed',
			retryClass: 'safe-before-dispatch',
		});
		expect(runnerVm.executeRunner).not.toHaveBeenCalled();
		expect(runnerVm.closeRunner).toHaveBeenCalledOnce();
		await expect(operationLedger.load('operation-a')).resolves.toMatchObject({
			containment: 'proven',
			kind: 'contained-terminal',
		});
	});

	it('does not expose callback-only durable transitions as a runner composition seam', () => {
		expectTypeOf<CreateManagedVmControllerRunnerOptions>().not.toHaveProperty(
			'onDurableTransition',
		);
		expectTypeOf<CreateManagedVmControllerRunnerOptions>().toHaveProperty('operationLedger');
		expectTypeOf<CreateManagedVmControllerRunnerOptions>().toHaveProperty('readProcessIdentity');
	});
});

async function recordPreIdentityPredecessor(
	operationLedger: ControllerRunnerOperationLedger,
): Promise<void> {
	const predecessorAuthority = {
		controllerEpoch: 'controller-epoch-a',
		executionFingerprint: trustedAuthorization.authorizationFingerprint,
		gatewayEpoch: trustedAuthorityContext.gatewayEpoch,
		operationId: 'operation-predecessor',
		parentGatewayVmId: trustedAuthorityContext.parentGatewayVmId,
		runnerId: 'runner-predecessor',
		runtimeEpoch: trustedAuthorityContext.runtimeEpoch,
		stablePrincipal: trustedAuthorityContext.stablePrincipal,
	} as const satisfies ControllerRunnerOperationAuthority;
	await operationLedger.reserve(predecessorAuthority);
	await operationLedger.recordCreationStarted({ operationId: predecessorAuthority.operationId });
	await operationLedger.recordVmCreated({
		operationId: predecessorAuthority.operationId,
		vmId: 'runner-vm-predecessor',
	});
}

async function createTemporaryRuntimeDirectory(): Promise<
	AsyncDisposable & { readonly path: string }
> {
	const temporaryDirectoryPath = await mkdtemp(
		path.join(os.tmpdir(), 'agent-vm-controller-runner-integration-'),
	);
	return {
		path: temporaryDirectoryPath,
		[Symbol.asyncDispose]: async (): Promise<void> => {
			await rm(temporaryDirectoryPath, { force: true, recursive: true });
		},
	};
}
