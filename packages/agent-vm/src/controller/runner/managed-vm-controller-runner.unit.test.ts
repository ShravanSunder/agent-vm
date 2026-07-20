import { describe, expect, expectTypeOf, it, type Mock, vi } from 'vitest';

import type { ControllerRunnerOperationLedger } from './controller-runner-operation-record.js';
import {
	createManagedVmControllerRunner,
	type ControllerRunnerAuthorizationSnapshot,
	type ControllerRunnerDispatchRequest,
	type CreateManagedVmControllerRunnerOptions,
	type ManagedVmControllerRunner,
	type ManagedVmControllerRunnerExecRequest,
	type ManagedVmControllerRunnerFactory,
	type ManagedVmControllerRunnerHandle,
} from './managed-vm-controller-runner.js';

const trustedAuthorization = {
	artifacts: { allowedArtifactIds: ['result-json'], maxBytes: 4096 },
	cancellation: { deadlineMs: 30_000, mode: 'controller-safety-cancel' },
	credentials: [{ credentialId: 'registry-read', injection: 'http-mediation' }],
	cwd: { kind: 'fixed', path: '/work' },
	egress: { allowedHosts: ['registry.npmjs.org'] },
	environment: { AGENT_VM_OPERATION_ID: 'operation-a' },
	executablePath: '/usr/local/bin/npm',
	mandatoryArgvPrefix: ['view'],
	output: { stderr: 'stream', stdout: 'stream', windowBytes: 65_536 },
	target: { kind: 'new-runner-vm', zoneId: 'zone-a' },
	authorizationFingerprint: 'fingerprint-a',
} satisfies ControllerRunnerAuthorizationSnapshot;

function validateTestArguments(argumentsToValidate: readonly string[]): boolean {
	return !argumentsToValidate.some(
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
		arguments: ['@agent-vm/agent-vm', 'version'],
		authorizationFingerprint: 'fingerprint-a',
		operationId: 'operation-a',
	};
}

function createRunnerFactory(observedEvents: string[] = []): {
	readonly closeRunner: Mock<() => Promise<void>>;
	readonly createRunner: Mock<() => Promise<ManagedVmControllerRunnerHandle>>;
	readonly executeRunner: Mock<
		(request: ManagedVmControllerRunnerExecRequest) => Promise<{ readonly exitCode: 0 }>
	>;
	readonly factory: ManagedVmControllerRunnerFactory;
	readonly handle: ManagedVmControllerRunnerHandle;
	readonly readHostProcessId: Mock<() => number>;
} {
	const closeRunner = vi.fn(async (): Promise<void> => undefined);
	const executeRunner = vi.fn(
		async (_request: ManagedVmControllerRunnerExecRequest): Promise<{ readonly exitCode: 0 }> => {
			observedEvents.push('side-effect');
			return { exitCode: 0 };
		},
	);
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
	const createRunner = vi.fn(async (): Promise<ManagedVmControllerRunnerHandle> => {
		observedEvents.push('managed-vm-created');
		return handle;
	});
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
		validatePublicArguments: validateTestArguments,
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
		['missing required fields', { arguments: ['version'] }],
		['empty arguments', { ...createDispatchRequest(), arguments: [] }],
		['non-string argument', { ...createDispatchRequest(), arguments: [42] }],
		['oversized argument', { ...createDispatchRequest(), arguments: ['a'.repeat(4097)] }],
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
			value: { exitCode: 0 },
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
			authorization: trustedAuthorization,
			operationId: 'operation-a',
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
		['shell token', { arguments: ['@agent-vm/agent-vm', ';', 'curl', 'attacker.test'] }],
		['command substitution', { arguments: ['@agent-vm/agent-vm', '$(id)'] }],
		['response file', { arguments: ['@attacker/arguments'] }],
		['launcher', { arguments: ['--script-shell=/bin/sh'] }],
		['config override', { arguments: ['--userconfig=/tmp/attacker-npmrc'] }],
		['credential override', { arguments: ['--//registry.npmjs.org/:_authToken=stolen'] }],
		['endpoint override', { arguments: ['--registry=https://attacker.test'] }],
		['plugin override', { arguments: ['--plugin=/tmp/attacker-plugin.js'] }],
		['host override', { arguments: ['--host=attacker.test'] }],
		['path escape', { arguments: ['../../etc/shadow'] }],
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
		'credentials',
		'cwd',
		'environment',
		'egress',
		'output',
		'artifacts',
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
