import { describe, expect, expectTypeOf, it, type Mock, vi } from 'vitest';

import { ConfiguredControllerExecutionError } from './configured-controller-execution-error.js';
import type { ControllerRunnerOperationLedger } from './controller-runner-operation-record.js';
import {
	createManagedVmControllerRunner,
	type ControllerRunnerAuthorizationSnapshot,
	type ControllerRunnerDispatchRequest,
	type CreateManagedVmControllerRunnerOptions,
	type ManagedVmControllerRunner,
	type ManagedVmControllerRunnerExecRequest,
	type ManagedVmControllerRunnerExecResult,
	type ManagedVmControllerRunnerFactory,
	type ManagedVmControllerRunnerHandle,
} from './managed-vm-controller-runner.js';

const trustedAuthorization = {
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
	authorizationFingerprint: 'fingerprint-a',
} satisfies ControllerRunnerAuthorizationSnapshot;

function validateTestInput(input: ControllerRunnerDispatchRequest['input']): boolean {
	return !input.argv.some(
		(argument) =>
			/[;&|`\n\r]/u.test(argument) ||
			argument.includes('$(') ||
			argument.startsWith('@attacker') ||
			argument.includes('../') ||
			/^--(?:script-shell|userconfig|registry|plugin|host)/iu.test(argument) ||
			/_authToken/iu.test(argument),
	);
}

function createDispatchRequest(): ControllerRunnerDispatchRequest {
	return {
		authorizationFingerprint: 'fingerprint-a',
		input: { argv: ['@agent-vm/agent-vm', 'version'], reason: 'unit proof' },
		operationId: 'operation-a',
	};
}

function createRunnerFactory(observedEvents: string[] = []): {
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
	readonly readHostProcessId: Mock<() => number>;
} {
	const closeRunner = vi.fn(async (): Promise<void> => undefined);
	const executeRunner = vi.fn(async (_request: ManagedVmControllerRunnerExecRequest) => {
		observedEvents.push('side-effect');
		return {
			exitCode: 0,
			stderrTruncated: false,
			stdout: 'runner-output',
			stdoutTruncated: false,
		};
	});
	const readHostProcessId = vi.fn((): number => 12_345);
	const handle = {
		close: closeRunner,
		exec: executeRunner,
		getHostProcessId: readHostProcessId,
		id: 'runner-vm-a',
		start: vi.fn(async (): Promise<void> => {
			observedEvents.push('runner-started');
		}),
	} satisfies ManagedVmControllerRunnerHandle;
	const createRunner = vi.fn(
		async (
			_authorization: ControllerRunnerAuthorizationSnapshot,
		): Promise<ManagedVmControllerRunnerHandle> => {
			observedEvents.push('managed-vm-created');
			return handle;
		},
	);
	return {
		closeRunner,
		createRunner,
		executeRunner,
		factory: { create: createRunner },
		handle,
		readHostProcessId,
	};
}

function createOperationLedger(observedEvents: string[] = []): ControllerRunnerOperationLedger {
	return {
		admitSuccessor: vi.fn(async () => ({ kind: 'admitted' as const })),
		load: vi.fn(async () => null),
		publishIdentity: vi.fn(async () => {
			observedEvents.push('identity-published');
		}),
		recordAdmissionValidated: vi.fn(async () => {
			observedEvents.push('admission-recorded');
		}),
		recordContained: vi.fn(async () => {
			observedEvents.push('runner-contained');
		}),
		recordContainmentStarted: vi.fn(async () => {
			observedEvents.push('containment-started');
		}),
		recordCreationStarted: vi.fn(async () => {
			observedEvents.push('creation-started');
		}),
		recordDispatchArmed: vi.fn(async () => {
			observedEvents.push('dispatch-armed');
		}),
		recordGatewayRetired: vi.fn(async () => undefined),
		recordResult: vi.fn(async () => {
			observedEvents.push('result-recorded');
		}),
		recordResultStreaming: vi.fn(async () => {
			observedEvents.push('result-streaming');
		}),
		recordRunning: vi.fn(async () => {
			observedEvents.push('running');
		}),
		recordVmCreated: vi.fn(async () => {
			observedEvents.push('runner-created');
		}),
		recover: vi.fn(async () => ({
			adoptedRunnerCount: 0 as const,
			predecessorOperations: [],
			redispatchedOperationCount: 0 as const,
		})),
		reserve: vi.fn(async () => {
			observedEvents.push('reservation-recorded');
			return { kind: 'reserved' as const };
		}),
	};
}

function createRunnerOptions(
	runnerFactory: ManagedVmControllerRunnerFactory,
	observedEvents: string[] = [],
): CreateManagedVmControllerRunnerOptions {
	return {
		createRunnerId: () => 'runner-a',
		initialAuthorization: trustedAuthorization,
		operationLedger: createOperationLedger(observedEvents),
		readCurrentEpochContext: async () => ({
			controllerEpoch: 'controller-epoch-a',
			gatewayEpoch: 'gateway-epoch-a',
			parentGatewayVmId: 'gateway-vm-a',
			runtimeEpoch: 'runtime-epoch-a',
		}),
		readProcessIdentity: async () => ({
			command: 'qemu-system-aarch64 -name runner-a',
			lstart: 'Mon Jul 13 18:00:00 2026',
		}),
		recomputeAuthorization: async (): Promise<ControllerRunnerAuthorizationSnapshot> => {
			observedEvents.push('authorization-recomputed');
			return trustedAuthorization;
		},
		runnerFactory,
		trustedAuthorityContext: {
			controllerEpoch: 'controller-epoch-a',
			gatewayEpoch: 'gateway-epoch-a',
			parentGatewayVmId: 'gateway-vm-a',
			runtimeEpoch: 'runtime-epoch-a',
			stablePrincipal: 'a'.repeat(64),
		},
		validatePublicInput: validateTestInput,
	};
}

describe('managed VM controller runner authorization', () => {
	it('keeps unknown input at the public boundary and typed requests inside composition', () => {
		expectTypeOf<Parameters<ManagedVmControllerRunner['execute']>[0]>().toEqualTypeOf<unknown>();
		expectTypeOf<
			Parameters<CreateManagedVmControllerRunnerOptions['createRunnerId']>[0]
		>().toEqualTypeOf<ControllerRunnerDispatchRequest>();
		expectTypeOf<
			Parameters<CreateManagedVmControllerRunnerOptions['recomputeAuthorization']>[0]
		>().toEqualTypeOf<ControllerRunnerDispatchRequest>();
	});

	it.each([
		['null request', null],
		['array request', []],
		['missing required fields', { input: { argv: ['version'], reason: 'missing fields' } }],
		['empty arguments', { ...createDispatchRequest(), input: { argv: [], reason: 'empty' } }],
		['non-string argument', { ...createDispatchRequest(), input: { argv: [42], reason: 'bad' } }],
		[
			'oversized argument',
			{ ...createDispatchRequest(), input: { argv: ['a'.repeat(4097)], reason: 'bad' } },
		],
		[
			'empty authorization fingerprint',
			{ ...createDispatchRequest(), authorizationFingerprint: '' },
		],
		[
			'oversized authorization fingerprint',
			{ ...createDispatchRequest(), authorizationFingerprint: 'a'.repeat(513) },
		],
		['empty operation id', { ...createDispatchRequest(), operationId: '' }],
		['unsafe operation id', { ...createDispatchRequest(), operationId: '../operation' }],
		['oversized operation id', { ...createDispatchRequest(), operationId: 'a'.repeat(129) }],
		['empty public stable principal', { ...createDispatchRequest(), stablePrincipal: '' }],
		[
			'oversized public stable principal',
			{ ...createDispatchRequest(), stablePrincipal: 'a'.repeat(257) },
		],
		['unknown field', { ...createDispatchRequest(), attackerAuthority: 'host-root' }],
	])('rejects the malformed %s at the strict request boundary', async (_name, request) => {
		const runnerVm = createRunnerFactory();
		const runner = createManagedVmControllerRunner(createRunnerOptions(runnerVm.factory));

		await expect(runner.execute(request)).resolves.toEqual({
			certainty: 'proven',
			diagnostics: [],
			error: {
				code: 'validation_failed',
				message: 'Controller runner request did not pass strict public validation.',
			},
			kind: 'not-dispatched',
			reason: 'public-authority-or-policy-override',
			retryClass: 'safe-before-dispatch',
		});
		expect(runnerVm.createRunner).not.toHaveBeenCalled();
		expect(runnerVm.executeRunner).not.toHaveBeenCalled();
	});

	it('recomputes every authority field and revalidates the fingerprint immediately before dispatch-armed', async () => {
		const observedEvents: string[] = [];
		const runnerVm = createRunnerFactory(observedEvents);
		const runner = createManagedVmControllerRunner(
			createRunnerOptions(runnerVm.factory, observedEvents),
		);

		await expect(runner.execute(createDispatchRequest())).resolves.toEqual({
			binding: { fingerprint: 'fingerprint-a', operationId: 'operation-a' },
			certainty: 'proven',
			completion: 'succeeded',
			diagnostics: [],
			kind: 'completed',
			retryClass: 'forbidden',
			value: {
				exitCode: 0,
				stderrTruncated: false,
				stdout: 'runner-output',
				stdoutTruncated: false,
			},
		});

		expect(observedEvents).toEqual([
			'reservation-recorded',
			'creation-started',
			'managed-vm-created',
			'runner-created',
			'runner-started',
			'identity-published',
			'admission-recorded',
			'authorization-recomputed',
			'dispatch-armed',
			'running',
			'side-effect',
			'result-streaming',
			'result-recorded',
			'containment-started',
			'runner-contained',
		]);
		expect(runnerVm.readHostProcessId).toHaveBeenCalledOnce();
		expect(runnerVm.executeRunner).toHaveBeenCalledWith({
			argv: ['/usr/local/bin/npm', 'view', '@agent-vm/agent-vm', 'version'],
			cwd: '/work',
			environment: { AGENT_VM_OPERATION_ID: 'operation-a' },
			output: trustedAuthorization.output,
			timeoutMs: 30_000,
		});
		expect(runnerVm.closeRunner).toHaveBeenCalledOnce();
		expect(Object.keys(runnerVm.handle).toSorted()).toEqual([
			'close',
			'exec',
			'getHostProcessId',
			'id',
			'start',
		]);
	});

	it('rejects stale epoch authority before dispatch and contains the prepared runner', async () => {
		const observedEvents: string[] = [];
		const runnerVm = createRunnerFactory(observedEvents);
		const runnerOptions = {
			...createRunnerOptions(runnerVm.factory, observedEvents),
			readCurrentEpochContext: async () => ({
				controllerEpoch: 'controller-epoch-a',
				gatewayEpoch: 'gateway-epoch-b',
				parentGatewayVmId: 'gateway-vm-b',
				runtimeEpoch: 'runtime-epoch-b',
			}),
		};
		const runner = createManagedVmControllerRunner(runnerOptions);

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
		expect(observedEvents).not.toContain('dispatch-armed');
		expect(observedEvents).not.toContain('side-effect');
	});

	it('preserves proven not-dispatched truth when runner creation fails', async () => {
		const createRunner = vi.fn(async (): Promise<ManagedVmControllerRunnerHandle> => {
			throw new Error('runner creation failed');
		});
		const runner = createManagedVmControllerRunner(createRunnerOptions({ create: createRunner }));

		await expect(runner.execute(createDispatchRequest())).resolves.toEqual({
			binding: { fingerprint: 'fingerprint-a', operationId: 'operation-a' },
			certainty: 'proven',
			diagnostics: [],
			error: {
				code: 'execution_failed',
				message: 'Controller runner setup failed before dispatch.',
			},
			kind: 'not-dispatched',
			reason: 'runner-setup-failed',
			retryClass: 'safe-before-dispatch',
		});
		expect(createRunner).toHaveBeenCalledOnce();
	});

	it('does not create a runner when the controller-owned call signal is already aborted', async () => {
		const runnerVm = createRunnerFactory();
		const runner = createManagedVmControllerRunner(createRunnerOptions(runnerVm.factory));
		const cancellation = new AbortController();
		cancellation.abort(
			new ConfiguredControllerExecutionError('timeout', 'Controller execution window expired.'),
		);

		await expect(
			runner.execute(createDispatchRequest(), { signal: cancellation.signal }),
		).resolves.toMatchObject({
			kind: 'not-dispatched',
			reason: 'runner-setup-failed',
		});
		expect(runnerVm.createRunner).not.toHaveBeenCalled();
		expect(runnerVm.executeRunner).not.toHaveBeenCalled();
	});

	it('forbids replay when execution fails after dispatch is armed', async () => {
		const runnerVm = createRunnerFactory();
		runnerVm.executeRunner.mockRejectedValueOnce(new Error('execution transport failed'));
		const runner = createManagedVmControllerRunner(createRunnerOptions(runnerVm.factory));

		await expect(runner.execute(createDispatchRequest())).resolves.toEqual({
			binding: { fingerprint: 'fingerprint-a', operationId: 'operation-a' },
			certainty: 'side-effects-and-termination-unknown',
			diagnostics: [],
			error: {
				code: 'execution_failed',
				message: 'Controller runner dispatch state is unknown after dispatch was armed.',
			},
			kind: 'ambiguous',
			reason: 'dispatch-armed',
			retryClass: 'forbidden',
		});
		expect(runnerVm.closeRunner).toHaveBeenCalledOnce();
	});

	it('preserves timeout classification after dispatch and still proves containment', async () => {
		const runnerVm = createRunnerFactory();
		runnerVm.executeRunner.mockRejectedValueOnce(
			new ConfiguredControllerExecutionError('timeout', 'command timed out'),
		);
		const runner = createManagedVmControllerRunner(createRunnerOptions(runnerVm.factory));

		await expect(runner.execute(createDispatchRequest())).resolves.toMatchObject({
			certainty: 'side-effects-and-termination-unknown',
			error: { code: 'timeout' },
			kind: 'ambiguous',
			reason: 'dispatch-armed',
			retryClass: 'forbidden',
		});
		expect(runnerVm.closeRunner).toHaveBeenCalledOnce();
	});

	it('forbids replay when runner containment cannot be proven', async () => {
		const runnerVm = createRunnerFactory();
		runnerVm.closeRunner.mockRejectedValueOnce(new Error('runner close failed'));
		const runner = createManagedVmControllerRunner(createRunnerOptions(runnerVm.factory));

		await expect(runner.execute(createDispatchRequest())).resolves.toEqual({
			binding: { fingerprint: 'fingerprint-a', operationId: 'operation-a' },
			certainty: 'side-effects-and-termination-unknown',
			diagnostics: [],
			error: {
				code: 'execution_failed',
				message: 'Controller runner containment could not be proven.',
			},
			kind: 'ambiguous',
			reason: 'containment-unproven',
			retryClass: 'forbidden',
		});
	});

	it('rejects caller-supplied stable principal authority before reservation or dispatch', async () => {
		const runnerVm = createRunnerFactory();
		const runner = createManagedVmControllerRunner(createRunnerOptions(runnerVm.factory));

		await expect(
			runner.execute({ ...createDispatchRequest(), stablePrincipal: 'b'.repeat(64) }),
		).resolves.toEqual({
			certainty: 'proven',
			diagnostics: [],
			error: {
				code: 'validation_failed',
				message: 'Controller runner request did not pass strict public validation.',
			},
			kind: 'not-dispatched',
			reason: 'public-authority-or-policy-override',
			retryClass: 'safe-before-dispatch',
		});
		expect(runnerVm.createRunner).not.toHaveBeenCalled();
		expect(runnerVm.executeRunner).not.toHaveBeenCalled();
	});

	it.each([
		[
			'shell token',
			{ input: { argv: ['@agent-vm/agent-vm', ';', 'curl', 'attacker.test'], reason: 'bad' } },
		],
		['command substitution', { input: { argv: ['@agent-vm/agent-vm', '$(id)'], reason: 'bad' } }],
		['response file', { input: { argv: ['@attacker/arguments'], reason: 'bad' } }],
		['launcher', { input: { argv: ['--script-shell=/bin/sh'], reason: 'bad' } }],
		['config override', { input: { argv: ['--userconfig=/tmp/attacker-npmrc'], reason: 'bad' } }],
		[
			'credential override',
			{ input: { argv: ['--//registry.npmjs.org/:_authToken=stolen'], reason: 'bad' } },
		],
		['endpoint override', { input: { argv: ['--registry=https://attacker.test'], reason: 'bad' } }],
		['plugin override', { input: { argv: ['--plugin=/tmp/attacker-plugin.js'], reason: 'bad' } }],
		['host override', { input: { argv: ['--host=attacker.test'], reason: 'bad' } }],
		['path escape', { input: { argv: ['../../etc/shadow'], reason: 'bad' } }],
	] as const)('rejects the public %s attack before dispatch', async (_name, requestOverride) => {
		const runnerVm = createRunnerFactory();
		const runner = createManagedVmControllerRunner(createRunnerOptions(runnerVm.factory));

		await expect(
			runner.execute({ ...createDispatchRequest(), ...requestOverride }),
		).resolves.toMatchObject({
			certainty: 'proven',
			kind: 'not-dispatched',
			reason: 'public-authority-or-policy-override',
			retryClass: 'safe-before-dispatch',
		});
		expect(runnerVm.createRunner).not.toHaveBeenCalled();
		expect(runnerVm.executeRunner).not.toHaveBeenCalled();
	});

	it.each([
		'executablePath',
		'mandatoryArgvPrefix',
		'cwd',
		'environment',
		'egress',
		'imageFingerprint',
		'imageReference',
		'output',
		'cancellation',
		'target',
	] as const)('rejects a public %s authority field before dispatch', async (authorityField) => {
		const runnerVm = createRunnerFactory();
		const runner = createManagedVmControllerRunner(createRunnerOptions(runnerVm.factory));
		const requestWithPublicAuthority = {
			...createDispatchRequest(),
			[authorityField]: 'attacker-choice',
		};

		await expect(runner.execute(requestWithPublicAuthority)).resolves.toMatchObject({
			certainty: 'proven',
			kind: 'not-dispatched',
			reason: 'public-authority-or-policy-override',
			retryClass: 'safe-before-dispatch',
		});
		expect(runnerVm.createRunner).not.toHaveBeenCalled();
		expect(runnerVm.executeRunner).not.toHaveBeenCalled();
	});
});
