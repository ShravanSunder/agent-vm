import {
	deriveGatewayControlStablePrincipal,
	type GatewayControlLeaseRejectionReason,
	type GatewayControlLeaseUseSnapshot,
	type GatewayRuntimeTrustedInvocationContext,
} from '@agent-vm/gateway-control-contracts';
import { describe, expect, it, vi } from 'vitest';

import type { GatewayRuntimeSandboxProcessRegistry } from '../sandbox/sandbox-process-registry.js';
import type {
	StrictToolVmSshClient,
	StrictToolVmSshProcessChannelClient,
	StrictToolVmSshTransportFailure,
} from '../sandbox/strict-tool-vm-ssh-client.js';
import type { GatewayControlRegisteredCallerContext } from './gateway-control-caller-context-registration-client.js';
import type {
	GatewayRuntimeControlCommandClient,
	GatewayRuntimeControlCommandRequest,
	GatewayRuntimeControlCommandResponse,
} from './gateway-control-command-client.js';
import type {
	GatewayControlAcceptedSession,
	GatewayControlSessionStateObserver,
	GatewayControlService,
} from './gateway-control-endpoint-contracts.js';
import {
	createGatewayControlOperationActiveUseRuntime,
	type GatewayControlOperationActiveUseAcquisition,
	type GatewayControlOperationActiveUseScheduler,
} from './gateway-control-operation-active-use-runtime.js';
import type {
	GatewayControlPublishedBindingGeneration,
	GatewayControlPublishedBindingLookupResult,
} from './gateway-control-published-binding-runtime.js';

const sessionA = Object.freeze({
	attachmentGeneration: 1,
	bootId: 'boot-a',
	connectionId: '11111111-1111-4111-8111-111111111111',
	controllerEpoch: 'controller-a',
	gatewayEpoch: 'gateway-a',
	generationId: 'gateway-a',
	peerId: 'gateway-zone-a',
	processEpoch: 'process-a',
	sessionId: '22222222-2222-4222-8222-222222222222',
	zoneId: 'zone-a',
}) satisfies GatewayControlAcceptedSession;

const sessionB = Object.freeze({
	...sessionA,
	connectionId: '33333333-3333-4333-8333-333333333333',
	sessionId: '44444444-4444-4444-8444-444444444444',
}) satisfies GatewayControlAcceptedSession;

const trustedContextA = Object.freeze({
	correlation: { runId: 'run-a', toolCallId: 'tool-call-a' },
	principal: {
		agentId: 'agent-a',
		frameworkIdentity: { kind: 'hermes', profileName: 'hermes-agent-a' },
		profileAssignmentRevision: 'assignment-a-1',
		toolPortalProfileId: 'builder',
	},
}) satisfies GatewayRuntimeTrustedInvocationContext;

const stablePrincipalA = deriveGatewayControlStablePrincipal({
	principal: trustedContextA.principal,
});

const generationA = Object.freeze({
	agentId: trustedContextA.principal.agentId,
	leafGeneration: 'leaf-a-1',
	leaseId: 'lease-a-1',
	profileAssignmentRevision: trustedContextA.principal.profileAssignmentRevision,
	sshBindingId: 'ssh-a-1',
	stablePrincipal: stablePrincipalA,
	zoneId: sessionA.zoneId,
}) satisfies GatewayControlPublishedBindingGeneration;

const generationB = Object.freeze({
	...generationA,
	leafGeneration: 'leaf-a-2',
	leaseId: 'lease-a-2',
	sshBindingId: 'ssh-a-2',
}) satisfies GatewayControlPublishedBindingGeneration;

interface Deferred<TValue> {
	readonly promise: Promise<TValue>;
	readonly resolve: (value: TValue) => void;
}

function deferred<TValue>(): Deferred<TValue> {
	let resolvePromise: ((value: TValue) => void) | undefined;
	const promise = new Promise<TValue>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: (value) => resolvePromise?.(value) };
}

interface StrictSshFixture {
	readonly client: StrictToolVmSshClient & StrictToolVmSshProcessChannelClient;
	emitTransportFailure(failure: StrictToolVmSshTransportFailure): void;
	getObserverCount(): number;
}

function unsupportedUnitTestOperation(): never {
	throw new Error('Operation is outside this unit-test scope.');
}

async function unsupportedAsyncUnitTestOperation(): Promise<never> {
	return unsupportedUnitTestOperation();
}

function createStrictSshFixture(): StrictSshFixture {
	const observers = new Set<(failure: StrictToolVmSshTransportFailure) => void>();
	const client = {
		close: vi.fn(),
		connect: vi.fn(async () => undefined),
		execute: unsupportedAsyncUnitTestOperation,
		guestListDirectory: unsupportedAsyncUnitTestOperation,
		guestMkdir: unsupportedAsyncUnitTestOperation,
		guestReadFile: unsupportedAsyncUnitTestOperation,
		guestRemove: unsupportedAsyncUnitTestOperation,
		guestRename: unsupportedAsyncUnitTestOperation,
		guestStat: unsupportedAsyncUnitTestOperation,
		guestWriteFile: unsupportedAsyncUnitTestOperation,
		listDirectory: unsupportedAsyncUnitTestOperation,
		mkdir: unsupportedAsyncUnitTestOperation,
		observeTransportFailure: (observer: (failure: StrictToolVmSshTransportFailure) => void) => {
			observers.add(observer);
			return { unsubscribe: () => observers.delete(observer) };
		},
		openProcessChannel: unsupportedAsyncUnitTestOperation,
		openShellProcessChannel: unsupportedAsyncUnitTestOperation,
		readFile: unsupportedAsyncUnitTestOperation,
		remove: unsupportedAsyncUnitTestOperation,
		rename: unsupportedAsyncUnitTestOperation,
		stat: unsupportedAsyncUnitTestOperation,
		writeFile: unsupportedAsyncUnitTestOperation,
	} satisfies StrictToolVmSshClient & StrictToolVmSshProcessChannelClient;
	return {
		client,
		emitTransportFailure: (failure) => {
			for (const observer of observers) observer(failure);
		},
		getObserverCount: () => observers.size,
	};
}

interface ProcessRegistryFixture {
	readonly registry: GatewayRuntimeSandboxProcessRegistry;
	readonly retire: ReturnType<typeof vi.fn>;
}

function createProcessRegistryFixture(): ProcessRegistryFixture {
	const retire = vi.fn(async () => undefined);
	return {
		registry: {
			cancel: unsupportedUnitTestOperation,
			closeStream: unsupportedUnitTestOperation,
			logs: unsupportedUnitTestOperation,
			read: unsupportedUnitTestOperation,
			resizeTerminal: unsupportedUnitTestOperation,
			retire,
			start: unsupportedAsyncUnitTestOperation,
			startShell: unsupportedAsyncUnitTestOperation,
			status: unsupportedUnitTestOperation,
			terminalExitCode: unsupportedUnitTestOperation,
			wait: unsupportedAsyncUnitTestOperation,
			write: unsupportedAsyncUnitTestOperation,
		},
		retire,
	};
}

interface SchedulerFixture {
	readonly scheduler: GatewayControlOperationActiveUseScheduler;
	getActiveTaskCount(): number;
	runNext(): void;
}

function createSchedulerFixture(): SchedulerFixture {
	const tasks: Array<{ active: boolean; readonly callback: () => void }> = [];
	return {
		getActiveTaskCount: () => tasks.filter((task) => task.active).length,
		runNext: () => {
			const task = tasks.find((candidate) => candidate.active);
			if (task === undefined) throw new Error('No scheduled task is active.');
			task.active = false;
			task.callback();
		},
		scheduler: {
			schedule: (callback): { readonly cancel: () => void } => {
				const task = { active: true, callback };
				tasks.push(task);
				return { cancel: () => (task.active = false) };
			},
		},
	};
}

interface ControlServiceFixture {
	readonly service: Pick<
		GatewayControlService,
		'getCurrentAcceptedSession' | 'observeSessionState'
	>;
	setSession(session: GatewayControlAcceptedSession | undefined): void;
}

function createControlServiceFixture(): ControlServiceFixture {
	let currentSession: GatewayControlAcceptedSession | undefined = sessionA;
	const observers = new Set<GatewayControlSessionStateObserver>();
	return {
		service: {
			getCurrentAcceptedSession: () => currentSession,
			observeSessionState: (observer) => {
				observers.add(observer);
				return { unsubscribe: () => observers.delete(observer) };
			},
		},
		setSession: (session) => {
			currentSession = session;
			for (const observer of observers) observer(session);
		},
	};
}

interface CommandFixtureOptions {
	readonly failFirstLeaseUseEnd?: boolean;
	readonly failLeaseUseEnd?: boolean;
	readonly rejectFirstLeaseUseStartWith?: GatewayControlLeaseRejectionReason;
	readonly rejectLeaseUseEndWith?: GatewayControlLeaseRejectionReason;
	readonly responseLeaseId?: string;
	readonly responseSession?: GatewayControlAcceptedSession;
}

interface CommandFixture {
	readonly client: GatewayRuntimeControlCommandClient;
	readonly requests: readonly GatewayRuntimeControlCommandRequest[];
}

function createCommandFixture(
	options: CommandFixtureOptions = {},
	resolveCurrentSession: () => GatewayControlAcceptedSession | undefined = () => sessionA,
): CommandFixture {
	const requests: GatewayRuntimeControlCommandRequest[] = [];
	let leaseUseEndCount = 0;
	let leaseUseStartCount = 0;
	const client = {
		sendCommand: vi.fn(
			async (
				request: GatewayRuntimeControlCommandRequest,
			): Promise<GatewayRuntimeControlCommandResponse> => {
				requests.push(request);
				const operation = request.message.operation;
				const messageId = `message-${String(requests.length)}`;
				const responseSession = options.responseSession ?? resolveCurrentSession() ?? sessionA;
				if (operation === 'tool_vm_binding_request') {
					return {
						acceptedSession: responseSession,
						messageId,
						response: {
							kind: 'command_result',
							operation,
							payload: {
								bindingRequest: {
									agentId: trustedContextA.principal.agentId,
									stablePrincipal: stablePrincipalA,
									status: 'publication_pending',
								},
								responseToMessageId: messageId,
								result: 'ok',
							},
						},
					};
				}
				if (operation === 'lease_reacquire') {
					return {
						acceptedSession: responseSession,
						messageId,
						response: {
							kind: 'command_result',
							operation,
							payload: {
								lease: {
									agentId: trustedContextA.principal.agentId,
									idleTtlMs: 60_000,
									leafGeneration: generationB.leafGeneration,
									leaseId: generationB.leaseId,
									ssh: {
										host: 'tool-vm.internal',
										identityPem: 'identity-pem',
										knownHostsLine: 'tool-vm.internal ssh-ed25519 public-key',
										port: 22,
										user: 'root',
									},
									sshBindingId: generationB.sshBindingId,
									state: 'idle',
									tcpSlot: 0,
									transport: 'ssh-sandbox',
									workdir: '/work',
									zoneId: sessionA.zoneId,
								},
								responseToMessageId: messageId,
								result: 'ok',
							},
						},
					};
				}
				if (
					operation !== 'lease_use_start' &&
					operation !== 'lease_use_heartbeat' &&
					operation !== 'lease_use_end'
				) {
					throw new Error(`Unexpected operation ${operation}.`);
				}
				if (operation === 'lease_use_start') {
					leaseUseStartCount += 1;
					if (leaseUseStartCount === 1 && options.rejectFirstLeaseUseStartWith !== undefined) {
						return {
							acceptedSession: responseSession,
							messageId,
							response: {
								kind: 'command_result',
								operation,
								payload: {
									leaseRejectionReason: options.rejectFirstLeaseUseStartWith,
									responseToMessageId: messageId,
									result: 'rejected',
								},
							},
						};
					}
				}
				if (operation === 'lease_use_end') leaseUseEndCount += 1;
				if (
					operation === 'lease_use_end' &&
					(options.failLeaseUseEnd === true ||
						(options.failFirstLeaseUseEnd === true && leaseUseEndCount === 1))
				) {
					return {
						acceptedSession: responseSession,
						messageId,
						response: {
							kind: 'command_result',
							operation,
							payload: {
								error: {
									errorClass: 'gateway_control_handler_failed',
									retryable: true,
									safeMessage: 'Lease-use end failed.',
								},
								responseToMessageId: messageId,
								result: 'failed',
							},
						},
					};
				}
				if (operation === 'lease_use_end' && options.rejectLeaseUseEndWith !== undefined) {
					return {
						acceptedSession: responseSession,
						messageId,
						response: {
							kind: 'command_result',
							operation,
							payload: {
								leaseRejectionReason: options.rejectLeaseUseEndWith,
								responseToMessageId: messageId,
								result: 'rejected',
							},
						},
					};
				}
				const leaseUse = {
					heartbeatAfterMs: operation === 'lease_use_end' ? undefined : 1_000,
					leaseId: options.responseLeaseId ?? request.message.payload.leaseId,
					state: operation === 'lease_use_end' ? ('ended' as const) : ('active' as const),
					useId: request.message.payload.useId,
				} satisfies GatewayControlLeaseUseSnapshot;
				return {
					acceptedSession: responseSession,
					messageId,
					response: {
						kind: 'command_result',
						operation,
						payload: { leaseUse, responseToMessageId: messageId, result: 'ok' },
					},
				};
			},
		),
	} satisfies GatewayRuntimeControlCommandClient;
	return { client, requests };
}

interface RuntimeFixtureOptions extends CommandFixtureOptions {
	readonly bindingBecomesReadyAfterRequest?: boolean;
	readonly callerRegistration?: () => Promise<GatewayControlRegisteredCallerContext>;
	readonly degradedBindingBecomesReadyAfterReacquire?: boolean;
	readonly readyBindingBecomesReplacementAfterRequest?: boolean;
	readonly readyBindingChangesAfterLeaseUseStart?: boolean;
	readonly ready?: boolean;
	readonly useIds?: readonly string[];
}

interface RuntimeFixture {
	readonly callerRegister: ReturnType<typeof vi.fn>;
	readonly command: CommandFixture;
	readonly control: ControlServiceFixture;
	readonly processRegistries: readonly ProcessRegistryFixture[];
	readonly runtime: ReturnType<typeof createGatewayControlOperationActiveUseRuntime>;
	readonly scheduler: SchedulerFixture;
	readonly ssh: StrictSshFixture;
}

function createRuntimeFixture(options: RuntimeFixtureOptions = {}): RuntimeFixture {
	const control = createControlServiceFixture();
	const command = createCommandFixture(options, control.service.getCurrentAcceptedSession);
	const scheduler = createSchedulerFixture();
	const ssh = createStrictSshFixture();
	const processRegistries: ProcessRegistryFixture[] = [];
	const callerRegister = vi.fn(
		options.callerRegistration ??
			(async () => ({
				admissionPrincipal: stablePrincipalA,
				callerContextId: '55555555-5555-4555-8555-555555555555',
			})),
	);
	const readyResult = {
		connection: ssh.client,
		generation: generationA,
		kind: 'ready',
	} satisfies GatewayControlPublishedBindingLookupResult;
	const unavailableResult = {
		kind: 'unavailable',
		state: { kind: 'unbound', stablePrincipal: stablePrincipalA },
	} satisfies GatewayControlPublishedBindingLookupResult;
	const degradedResult = {
		kind: 'unavailable',
		state: {
			degradedAtMs: 90,
			generation: generationA,
			kind: 'degraded',
			publicationObservedAtMs: 80,
			reason: 'transport_failed',
		},
	} satisfies GatewayControlPublishedBindingLookupResult;
	const replacementReadyResult = {
		connection: ssh.client,
		generation: generationB,
		kind: 'ready',
	} satisfies GatewayControlPublishedBindingLookupResult;
	let useIdIndex = 0;
	let commandIdIndex = 0;
	const useIds = options.useIds ?? [
		'66666666-6666-4666-8666-666666666666',
		'77777777-7777-4777-8777-777777777777',
	];
	let bindingLookupCount = 0;
	const runtime = createGatewayControlOperationActiveUseRuntime({
		callerContextRegistrationClient: {
			close: vi.fn(async () => undefined),
			register: callerRegister,
		},
		controlCommandClient: command.client,
		controlService: control.service,
		createCommandId: () => {
			commandIdIndex += 1;
			return `88888888-8888-4888-8888-${String(commandIdIndex).padStart(12, '0')}`;
		},
		createProcessRegistry: () => {
			const processRegistry = createProcessRegistryFixture();
			processRegistries.push(processRegistry);
			return processRegistry.registry;
		},
		createUseId: () => {
			const useId = useIds[useIdIndex++];
			if (useId === undefined) throw new Error('Missing configured use ID.');
			return useId;
		},
		now: () => 100,
		publishedBindingRuntime: {
			lookupReadyConnection: () => {
				bindingLookupCount += 1;
				if (options.readyBindingChangesAfterLeaseUseStart === true) {
					return command.requests.some((request) => request.message.operation === 'lease_use_start')
						? replacementReadyResult
						: readyResult;
				}
				if (options.readyBindingBecomesReplacementAfterRequest === true) {
					return command.requests.some(
						(request) => request.message.operation === 'tool_vm_binding_request',
					)
						? replacementReadyResult
						: readyResult;
				}
				if (options.degradedBindingBecomesReadyAfterReacquire === true) {
					return command.requests.some(
						(request) => request.message.operation === 'tool_vm_binding_request',
					)
						? replacementReadyResult
						: degradedResult;
				}
				if (options.ready !== false) return readyResult;
				return options.bindingBecomesReadyAfterRequest === true && bindingLookupCount > 1
					? readyResult
					: unavailableResult;
			},
		},
		scheduler: scheduler.scheduler,
	});
	return { callerRegister, command, control, processRegistries, runtime, scheduler, ssh };
}

function requireBound(
	result: Awaited<ReturnType<RuntimeFixture['runtime']['acquisitionPort']['acquire']>>,
): GatewayControlOperationActiveUseAcquisition {
	if (result.kind !== 'bound') throw new Error('Expected a bound active-use acquisition.');
	return result;
}

describe('Gateway control operation active-use runtime', () => {
	it('continues the first acquisition after the requested binding is published', async () => {
		// Arrange
		const fixture = createRuntimeFixture({ bindingBecomesReadyAfterRequest: true, ready: false });

		// Act
		const result = await fixture.runtime.acquisitionPort.acquire({
			trustedContext: trustedContextA,
		});

		// Assert
		expect(result).toMatchObject({ kind: 'bound' });
		expect(fixture.command.requests.map((request) => request.message.operation)).toEqual([
			'tool_vm_binding_request',
			'lease_use_start',
		]);
		expect(fixture.command.requests[1]).toMatchObject({ commandId: expect.any(String) });
		expect(fixture.processRegistries).toHaveLength(1);
		expect(fixture.scheduler.getActiveTaskCount()).toBe(1);
	});

	it('requests a published binding while unbound without starting active use', async () => {
		// Arrange
		const fixture = createRuntimeFixture({ ready: false });

		// Act
		const result = await fixture.runtime.acquisitionPort.acquire({
			trustedContext: trustedContextA,
		});

		// Assert
		expect(result).toMatchObject({ kind: 'not-bound', reason: 'unavailable' });
		expect(fixture.callerRegister).toHaveBeenCalledOnce();
		expect(fixture.command.requests.map((request) => request.message.operation)).toEqual([
			'tool_vm_binding_request',
		]);
		expect(fixture.processRegistries).toHaveLength(0);
		expect(fixture.scheduler.getActiveTaskCount()).toBe(0);
	});

	it('reacquires a degraded binding before starting active use on the replacement', async () => {
		// Arrange
		const fixture = createRuntimeFixture({ degradedBindingBecomesReadyAfterReacquire: true });

		// Act
		const result = await fixture.runtime.acquisitionPort.acquire({
			trustedContext: trustedContextA,
		});

		// Assert
		expect(result).toMatchObject({
			kind: 'bound',
			operationContext: { leaseId: generationB.leaseId },
		});
		expect(fixture.command.requests.map((request) => request.message.operation)).toEqual([
			'lease_reacquire',
			'tool_vm_binding_request',
			'lease_use_start',
		]);
		expect(fixture.command.requests[0]?.message).toMatchObject({
			operation: 'lease_reacquire',
			payload: {
				oldLeaseId: generationA.leaseId,
				staleEvidence: {
					kind: 'tool-vm-ssh',
					operation: 'command',
				},
			},
		});
	});

	it('requests a successor when controller authority rejects a still-ready published binding', async () => {
		// Arrange
		const fixture = createRuntimeFixture({
			readyBindingBecomesReplacementAfterRequest: true,
			rejectFirstLeaseUseStartWith: 'lease_retired',
		});

		// Act
		const result = await fixture.runtime.acquisitionPort.acquire({
			trustedContext: trustedContextA,
		});

		// Assert
		expect(result).toMatchObject({
			kind: 'bound',
			operationContext: { leaseId: generationB.leaseId },
		});
		expect(fixture.command.requests.map((request) => request.message.operation)).toEqual([
			'lease_use_start',
			'tool_vm_binding_request',
			'lease_use_start',
		]);
		expect(
			fixture.command.requests.filter(
				(request) => request.message.operation === 'tool_vm_binding_request',
			),
		).toHaveLength(1);
	});

	it('remains unavailable when the binding request fails', async () => {
		// Arrange
		const fixture = createRuntimeFixture({
			callerRegistration: () => Promise.reject(new Error('registration failed')),
			ready: false,
		});

		// Act
		const result = await fixture.runtime.acquisitionPort.acquire({
			trustedContext: trustedContextA,
		});

		// Assert
		expect(result).toMatchObject({ kind: 'not-bound', reason: 'unavailable' });
		expect(fixture.callerRegister).toHaveBeenCalledOnce();
		expect(fixture.command.requests).toHaveLength(0);
		expect(fixture.processRegistries).toHaveLength(0);
		expect(fixture.scheduler.getActiveTaskCount()).toBe(0);
	});

	it('coalesces concurrent unbound requests for the same complete principal', async () => {
		// Arrange
		const registration = deferred<GatewayControlRegisteredCallerContext>();
		const fixture = createRuntimeFixture({
			callerRegistration: async () => await registration.promise,
			ready: false,
		});

		// Act
		const first = fixture.runtime.acquisitionPort.acquire({ trustedContext: trustedContextA });
		const second = fixture.runtime.acquisitionPort.acquire({ trustedContext: trustedContextA });
		await vi.waitFor(() => expect(fixture.callerRegister).toHaveBeenCalledOnce());
		registration.resolve({
			admissionPrincipal: stablePrincipalA,
			callerContextId: '55555555-5555-4555-8555-555555555555',
		});
		const results = await Promise.all([first, second]);

		// Assert
		expect(results).toEqual([
			expect.objectContaining({ kind: 'not-bound' }),
			expect.objectContaining({ kind: 'not-bound' }),
		]);
		expect(fixture.callerRegister).toHaveBeenCalledOnce();
		expect(fixture.command.requests).toHaveLength(1);
	});

	it('does not reuse a pending binding request across accepted control sessions', async () => {
		// Arrange
		const firstRegistrationStarted = deferred<void>();
		const firstRegistration = deferred<GatewayControlRegisteredCallerContext>();
		const secondRegistration = deferred<GatewayControlRegisteredCallerContext>();
		let registrationIndex = 0;
		const fixture = createRuntimeFixture({
			callerRegistration: async () => {
				const isFirstRegistration = registrationIndex++ === 0;
				if (isFirstRegistration) firstRegistrationStarted.resolve(undefined);
				const registration = isFirstRegistration ? firstRegistration : secondRegistration;
				return await registration.promise;
			},
			ready: false,
			responseSession: sessionB,
		});
		const registeredContext: GatewayControlRegisteredCallerContext = {
			admissionPrincipal: stablePrincipalA,
			callerContextId: '55555555-5555-4555-8555-555555555555',
		};

		// Act
		const first = fixture.runtime.acquisitionPort.acquire({ trustedContext: trustedContextA });
		await firstRegistrationStarted.promise;
		fixture.control.setSession(sessionB);
		const second = fixture.runtime.acquisitionPort.acquire({ trustedContext: trustedContextA });
		firstRegistration.resolve(registeredContext);
		secondRegistration.resolve(registeredContext);
		const results = await Promise.all([first, second]);

		// Assert
		expect(results).toEqual([
			expect.objectContaining({ kind: 'not-bound' }),
			expect.objectContaining({ kind: 'not-bound' }),
		]);
		expect(fixture.callerRegister).toHaveBeenCalledTimes(2);
		expect(fixture.command.requests).toHaveLength(1);
		expect(fixture.command.requests[0]?.message.operation).toBe('tool_vm_binding_request');
	});

	it('ends active use while preserving terminal registry and operation authority', async () => {
		// Arrange
		const fixture = createRuntimeFixture();
		const acquisition = requireBound(
			await fixture.runtime.acquisitionPort.acquire({ trustedContext: trustedContextA }),
		);

		// Act
		fixture.scheduler.runNext();
		await vi.waitFor(() =>
			expect(fixture.command.requests.map((request) => request.message.operation)).toContain(
				'lease_use_heartbeat',
			),
		);
		await acquisition.endActiveUse('completed');

		// Assert
		expect(fixture.command.requests.map((request) => request.message.operation)).toEqual([
			'lease_use_start',
			'lease_use_heartbeat',
			'lease_use_end',
		]);
		expect(fixture.processRegistries[0]?.retire).not.toHaveBeenCalled();
		expect(fixture.scheduler.getActiveTaskCount()).toBe(0);
		expect(acquisition.operationAuthority.authorize(acquisition.operationContext)).toEqual({
			kind: 'authorized',
		});
	});

	it('retires a retained operation group by fencing authority and registry', async () => {
		// Arrange
		const fixture = createRuntimeFixture();
		const acquisition = requireBound(
			await fixture.runtime.acquisitionPort.acquire({ trustedContext: trustedContextA }),
		);
		await acquisition.endActiveUse('completed');

		// Act
		await acquisition.retireGroup('completed');

		// Assert
		expect(fixture.processRegistries[0]?.retire).toHaveBeenCalledOnce();
		expect(acquisition.operationAuthority.authorize(acquisition.operationContext)).toEqual({
			kind: 'stale-operation-authority',
		});
		expect(
			fixture.command.requests.filter((request) => request.message.operation === 'lease_use_end'),
		).toHaveLength(1);
	});

	it('gives two groups distinct active uses and registries over one maintained connection', async () => {
		// Arrange
		const fixture = createRuntimeFixture();

		// Act
		const first = requireBound(
			await fixture.runtime.acquisitionPort.acquire({ trustedContext: trustedContextA }),
		);
		const second = requireBound(
			await fixture.runtime.acquisitionPort.acquire({ trustedContext: trustedContextA }),
		);

		// Assert
		expect(first.strictSshClient).toBe(fixture.ssh.client);
		expect(second.strictSshClient).toBe(fixture.ssh.client);
		expect(first.operationContext.activeUseId).not.toBe(second.operationContext.activeUseId);
		expect(first.operationAuthority).not.toBe(second.operationAuthority);
		expect(first.processRegistry).not.toBe(second.processRegistry);
		expect(
			fixture.command.requests.filter((request) => request.message.operation === 'lease_use_start'),
		).toHaveLength(2);
	});

	it('rejects a lease-use response that does not match the published lease', async () => {
		// Arrange
		const fixture = createRuntimeFixture({ responseLeaseId: 'lease-wrong' });

		// Act
		const result = await fixture.runtime.acquisitionPort.acquire({
			trustedContext: trustedContextA,
		});

		// Assert
		expect(result).toMatchObject({ kind: 'not-bound', reason: 'unavailable' });
		expect(fixture.processRegistries).toHaveLength(0);
		expect(fixture.command.requests.map((request) => request.message.operation)).toEqual([
			'lease_use_start',
			'lease_use_end',
		]);
	});

	it('rejects an active use that crosses accepted control sessions', async () => {
		// Arrange
		const fixture = createRuntimeFixture({ responseSession: sessionB });

		// Act
		const result = await fixture.runtime.acquisitionPort.acquire({
			trustedContext: trustedContextA,
		});

		// Assert
		expect(result).toMatchObject({ kind: 'not-bound', reason: 'unavailable' });
		expect(fixture.processRegistries).toHaveLength(0);
		expect(fixture.scheduler.getActiveTaskCount()).toBe(0);
	});

	it('fences active use on transport or session retirement', async () => {
		// Arrange
		const transportFixture = createRuntimeFixture();
		const transportAcquisition = requireBound(
			await transportFixture.runtime.acquisitionPort.acquire({ trustedContext: trustedContextA }),
		);
		const sessionFixture = createRuntimeFixture();
		const sessionAcquisition = requireBound(
			await sessionFixture.runtime.acquisitionPort.acquire({ trustedContext: trustedContextA }),
		);

		// Act
		transportFixture.ssh.emitTransportFailure({ kind: 'transport-close' });
		sessionFixture.control.setSession(undefined);
		await vi.waitFor(() => {
			expect(transportFixture.processRegistries[0]?.retire).toHaveBeenCalledOnce();
			expect(sessionFixture.processRegistries[0]?.retire).toHaveBeenCalledOnce();
		});

		// Assert
		expect(
			transportAcquisition.operationAuthority.authorize(transportAcquisition.operationContext),
		).toEqual({
			kind: 'stale-operation-authority',
		});
		expect(
			sessionAcquisition.operationAuthority.authorize(sessionAcquisition.operationContext),
		).toEqual({
			kind: 'stale-operation-authority',
		});
		expect(transportFixture.ssh.getObserverCount()).toBe(0);
		expect(sessionFixture.ssh.getObserverCount()).toBe(0);
		expect(transportFixture.command.requests.map((request) => request.message.operation)).toContain(
			'lease_use_end',
		);
	});

	it('ends the retired-session use before the first replacement-session active use', async () => {
		// Arrange
		const fixture = createRuntimeFixture();
		const predecessor = requireBound(
			await fixture.runtime.acquisitionPort.acquire({ trustedContext: trustedContextA }),
		);

		// Act
		fixture.control.setSession(undefined);
		await vi.waitFor(() => expect(fixture.processRegistries[0]?.retire).toHaveBeenCalledOnce());
		fixture.control.setSession(sessionB);
		const successor = requireBound(
			await fixture.runtime.acquisitionPort.acquire({ trustedContext: trustedContextA }),
		);

		// Assert
		expect(predecessor.operationAuthority.authorize(predecessor.operationContext)).toEqual({
			kind: 'stale-operation-authority',
		});
		expect(successor.operationContext.leaseId).toBe(generationA.leaseId);
		expect(fixture.command.requests.map((request) => request.message.operation)).toEqual([
			'lease_use_start',
			'lease_use_end',
			'lease_use_start',
		]);
	});

	it('retains the predecessor synchronously when session retirement overlaps acquisition', async () => {
		// Arrange
		const fixture = createRuntimeFixture();
		const predecessor = requireBound(
			await fixture.runtime.acquisitionPort.acquire({ trustedContext: trustedContextA }),
		);

		// Act
		fixture.control.setSession(undefined);
		fixture.control.setSession(sessionB);
		const successor = requireBound(
			await fixture.runtime.acquisitionPort.acquire({ trustedContext: trustedContextA }),
		);

		// Assert
		expect(predecessor.operationAuthority.authorize(predecessor.operationContext)).toEqual({
			kind: 'stale-operation-authority',
		});
		expect(successor.operationContext.leaseId).toBe(generationA.leaseId);
		expect(fixture.command.requests.map((request) => request.message.operation)).toEqual([
			'lease_use_start',
			'lease_use_end',
			'lease_use_start',
		]);
	});

	it('retries a failed current-session use end before the first replacement-session active use', async () => {
		// Arrange
		const fixture = createRuntimeFixture({ failFirstLeaseUseEnd: true });
		const predecessor = requireBound(
			await fixture.runtime.acquisitionPort.acquire({ trustedContext: trustedContextA }),
		);

		// Act
		fixture.ssh.emitTransportFailure({ kind: 'transport-close' });
		await predecessor.retireGroup('failed');
		fixture.control.setSession(sessionB);
		const successor = requireBound(
			await fixture.runtime.acquisitionPort.acquire({ trustedContext: trustedContextA }),
		);

		// Assert
		expect(predecessor.operationAuthority.authorize(predecessor.operationContext)).toEqual({
			kind: 'stale-operation-authority',
		});
		expect(successor.operationContext.leaseId).toBe(generationA.leaseId);
		expect(fixture.command.requests.map((request) => request.message.operation)).toEqual([
			'lease_use_start',
			'lease_use_end',
			'lease_use_end',
			'lease_use_start',
		]);
	});

	it('retains a potentially committed acquisition use when immediate cleanup fails', async () => {
		// Arrange
		const fixture = createRuntimeFixture({
			failFirstLeaseUseEnd: true,
			readyBindingChangesAfterLeaseUseStart: true,
		});

		// Act
		const failedAcquisition = await fixture.runtime.acquisitionPort.acquire({
			trustedContext: trustedContextA,
		});
		fixture.control.setSession(sessionB);
		const successor = requireBound(
			await fixture.runtime.acquisitionPort.acquire({ trustedContext: trustedContextA }),
		);

		// Assert
		expect(failedAcquisition).toMatchObject({ kind: 'not-bound', reason: 'unavailable' });
		expect(successor.operationContext.leaseId).toBe(generationB.leaseId);
		expect(fixture.command.requests.map((request) => request.message.operation)).toEqual([
			'lease_use_start',
			'lease_use_end',
			'lease_use_end',
			'lease_use_start',
		]);
		expect(fixture.command.requests[2]?.message).toMatchObject({
			operation: 'lease_use_end',
			payload: {
				leaseId: generationA.leaseId,
				useId: '66666666-6666-4666-8666-666666666666',
			},
		});
	});

	it('keeps replacement-session acquisition unavailable when orphan cleanup fails', async () => {
		// Arrange
		const fixture = createRuntimeFixture({ failLeaseUseEnd: true });
		const predecessor = requireBound(
			await fixture.runtime.acquisitionPort.acquire({ trustedContext: trustedContextA }),
		);

		// Act
		fixture.control.setSession(undefined);
		await vi.waitFor(() => expect(fixture.processRegistries[0]?.retire).toHaveBeenCalledOnce());
		fixture.control.setSession(sessionB);
		const result = await fixture.runtime.acquisitionPort.acquire({
			trustedContext: trustedContextA,
		});

		// Assert
		expect(result).toMatchObject({ kind: 'not-bound', reason: 'unavailable' });
		expect(predecessor.operationAuthority.authorize(predecessor.operationContext)).toEqual({
			kind: 'stale-operation-authority',
		});
		expect(fixture.command.requests.map((request) => request.message.operation)).toEqual([
			'lease_use_start',
			'lease_use_end',
		]);
	});

	it('continues replacement-session acquisition when the retired lease is already absent', async () => {
		// Arrange
		const fixture = createRuntimeFixture({ rejectLeaseUseEndWith: 'lease_absent' });
		const predecessor = requireBound(
			await fixture.runtime.acquisitionPort.acquire({ trustedContext: trustedContextA }),
		);

		// Act
		fixture.control.setSession(undefined);
		await vi.waitFor(() => expect(fixture.processRegistries[0]?.retire).toHaveBeenCalledOnce());
		fixture.control.setSession(sessionB);
		const successor = requireBound(
			await fixture.runtime.acquisitionPort.acquire({ trustedContext: trustedContextA }),
		);

		// Assert
		expect(predecessor.operationAuthority.authorize(predecessor.operationContext)).toEqual({
			kind: 'stale-operation-authority',
		});
		expect(successor.kind).toBe('bound');
		expect(fixture.command.requests.map((request) => request.message.operation)).toEqual([
			'lease_use_start',
			'lease_use_end',
			'lease_use_start',
		]);
	});

	it.each([
		['caller_context_absent', false],
		['caller_context_session_mismatch', false],
		['caller_context_stale', false],
		['lease_absent', true],
		['lease_authority_absent', true],
		['lease_force_released', true],
		['lease_generation_stale', false],
		['lease_reacquire_required', false],
		['lease_releasing', false],
		['lease_retired', true],
		['lease_use_tombstoned', true],
		['ownership_denied', false],
		['runtime_not_ready', false],
	] satisfies readonly (readonly [GatewayControlLeaseRejectionReason, boolean])[])(
		'classifies replacement-session lease-use cleanup rejection %s as terminally absent=%s',
		async (rejectionReason, terminallyAbsent) => {
			// Arrange
			const fixture = createRuntimeFixture({ rejectLeaseUseEndWith: rejectionReason });
			requireBound(
				await fixture.runtime.acquisitionPort.acquire({ trustedContext: trustedContextA }),
			);

			// Act
			fixture.control.setSession(undefined);
			await vi.waitFor(() => expect(fixture.processRegistries[0]?.retire).toHaveBeenCalledOnce());
			fixture.control.setSession(sessionB);
			const result = await fixture.runtime.acquisitionPort.acquire({
				trustedContext: trustedContextA,
			});

			// Assert
			expect(result.kind === 'bound').toBe(terminallyAbsent);
			expect(
				fixture.command.requests.filter((request) => request.message.operation === 'lease_use_end'),
			).toHaveLength(1);
		},
	);

	it('makes active-use end, group retirement, and runtime retirement idempotent', async () => {
		// Arrange
		const fixture = createRuntimeFixture();
		const acquisition = requireBound(
			await fixture.runtime.acquisitionPort.acquire({ trustedContext: trustedContextA }),
		);

		// Act
		await Promise.all([acquisition.endActiveUse('completed'), acquisition.endActiveUse('failed')]);
		await Promise.all([acquisition.retireGroup('completed'), acquisition.retireGroup('failed')]);
		await Promise.all([fixture.runtime.retire(), fixture.runtime.retire()]);

		// Assert
		expect(fixture.processRegistries[0]?.retire).toHaveBeenCalledOnce();
		expect(
			fixture.command.requests.filter((request) => request.message.operation === 'lease_use_end'),
		).toHaveLength(1);
		expect(fixture.scheduler.getActiveTaskCount()).toBe(0);
	});
});
