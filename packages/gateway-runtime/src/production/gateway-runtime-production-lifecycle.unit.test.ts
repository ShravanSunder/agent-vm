import { describe, expect, it } from 'vitest';

import {
	cleanupPartiallyStartedGatewayRuntimeProductionLifecycle,
	createGatewayRuntimeProductionLifecycle,
	GatewayRuntimeProductionLifecycleError,
	type GatewayRuntimeProductionLifecycle,
	type GatewayRuntimeProductionLifecycleResources,
	type GatewayRuntimeProductionRetirementFailureCode,
} from './gateway-runtime-production-lifecycle.js';

interface TestUdsReceipt {
	readonly kind: 'uds-retired';
}

interface TestRetirementReceipt {
	readonly kind: 'retired';
	readonly uds: TestUdsReceipt;
}

interface Deferred<TValue> {
	readonly promise: Promise<TValue>;
	readonly reject: (error: Error) => void;
	readonly resolve: (value: TValue) => void;
}

type MutableLifecycleResources<TUdsRetirementReceipt extends object> = {
	-readonly [TResourceName in keyof GatewayRuntimeProductionLifecycleResources<TUdsRetirementReceipt>]: {
		-readonly [TMemberName in keyof GatewayRuntimeProductionLifecycleResources<TUdsRetirementReceipt>[TResourceName]]: GatewayRuntimeProductionLifecycleResources<TUdsRetirementReceipt>[TResourceName][TMemberName];
	};
};

function createDeferred<TValue>(): Deferred<TValue> {
	let rejectPromise: ((error: Error) => void) | undefined;
	let resolvePromise: ((value: TValue) => void) | undefined;
	const promise = new Promise<TValue>((resolve, reject) => {
		rejectPromise = reject;
		resolvePromise = resolve;
	});
	return {
		promise,
		reject: (error): void => rejectPromise?.(error),
		resolve: (value): void => resolvePromise?.(value),
	};
}

const successfulUdsReceipt = Object.freeze({ kind: 'uds-retired' }) satisfies TestUdsReceipt;

function createSuccessfulResources(events: string[]): MutableLifecycleResources<TestUdsReceipt> {
	return {
		artifactEpoch: {
			retire: async (): Promise<void> => {
				events.push('artifact-retire');
			},
		},
		attachmentPublisher: {
			unsubscribe: (): void => {
				events.push('attachment-unsubscribe');
			},
		},
		bindingRuntime: {
			retire: async (): Promise<void> => {
				events.push('binding-retire');
			},
		},
		controlEndpoint: {
			close: async (): Promise<void> => {
				events.push('control-close');
			},
		},
		heartbeatPublisher: {
			flush: async (): Promise<void> => {
				events.push('heartbeat-flush');
			},
			stop: (): void => {
				events.push('heartbeat-stop');
			},
		},
		providerRuntime: {
			close: async (): Promise<void> => {
				events.push('provider-close');
			},
		},
		readinessLifecycle: {
			flushControlPublisher: async (): Promise<void> => {
				events.push('readiness-control-flush');
			},
			flushEvidence: async (): Promise<void> => {
				events.push('readiness-evidence-flush');
			},
			unsubscribeControlPublisher: (): void => {
				events.push('readiness-control-unsubscribe');
			},
		},
		udsServer: {
			retire: async (): Promise<TestUdsReceipt> => {
				events.push('uds-retire');
				return successfulUdsReceipt;
			},
		},
	};
}

function createLifecycle(props: {
	readonly events: string[];
	readonly resources?: GatewayRuntimeProductionLifecycleResources<TestUdsReceipt>;
}): GatewayRuntimeProductionLifecycle<TestRetirementReceipt> {
	return createGatewayRuntimeProductionLifecycle<TestUdsReceipt, TestRetirementReceipt>({
		createRetirementReceipt: ({ udsRetirementReceipt }): TestRetirementReceipt => {
			props.events.push('receipt-create');
			return Object.freeze({ kind: 'retired', uds: udsRetirementReceipt });
		},
		resources: props.resources ?? createSuccessfulResources(props.events),
		terminalEvidence: {
			write: async (): Promise<void> => {
				props.events.push('terminal-evidence');
			},
		},
	});
}

describe('gateway runtime production lifecycle', () => {
	it('retires every owned responsibility in the required success order', async () => {
		// Arrange
		const events: string[] = [];
		const lifecycle = createLifecycle({ events });

		// Act
		const receipt = await lifecycle.retire({ drainTimeoutMs: 37 });

		// Assert
		expect(receipt).toEqual({ kind: 'retired', uds: successfulUdsReceipt });
		expect(events).toEqual([
			'heartbeat-stop',
			'uds-retire',
			'binding-retire',
			'attachment-unsubscribe',
			'readiness-evidence-flush',
			'readiness-control-flush',
			'heartbeat-flush',
			'readiness-control-unsubscribe',
			'control-close',
			'provider-close',
			'artifact-retire',
			'receipt-create',
			'terminal-evidence',
		]);
	});

	it('does not cross the binding-before-control ordering barriers early', async () => {
		// Arrange
		const events: string[] = [];
		const udsRetirement = createDeferred<TestUdsReceipt>();
		const udsRetirementStarted = createDeferred<void>();
		const bindingRetirement = createDeferred<void>();
		const bindingRetirementStarted = createDeferred<void>();
		const resources = createSuccessfulResources(events);
		resources.udsServer.retire = (): Promise<TestUdsReceipt> => {
			events.push('uds-retire');
			udsRetirementStarted.resolve(undefined);
			return udsRetirement.promise;
		};
		resources.bindingRuntime.retire = (): Promise<void> => {
			events.push('binding-retire');
			bindingRetirementStarted.resolve(undefined);
			return bindingRetirement.promise;
		};
		const retirement = createLifecycle({ events, resources }).retire();

		// Act + Assert: binding cannot start until UDS admission/drain has completed.
		await udsRetirementStarted.promise;
		expect(events).toEqual(['heartbeat-stop', 'uds-retire']);
		udsRetirement.resolve(successfulUdsReceipt);
		await bindingRetirementStarted.promise;
		expect(events).toEqual(['heartbeat-stop', 'uds-retire', 'binding-retire']);

		// Act + Assert: control cannot close until the binding runtime has retired.
		bindingRetirement.resolve(undefined);
		await retirement;
		expect(events.indexOf('binding-retire')).toBeLessThan(events.indexOf('control-close'));
	});

	const failingStages = [
		{
			code: 'control-heartbeat-stop-failed',
			install: (resources: MutableLifecycleResources<TestUdsReceipt>) => {
				resources.heartbeatPublisher.stop = (): never => {
					throw new Error('heartbeat stop failed');
				};
			},
		},
		{
			code: 'uds-retirement-failed',
			install: (resources: MutableLifecycleResources<TestUdsReceipt>) => {
				resources.udsServer.retire = async (): Promise<TestUdsReceipt> =>
					await Promise.reject(new Error('UDS failed'));
			},
		},
		{
			code: 'lease-binding-retirement-failed',
			install: (resources: MutableLifecycleResources<TestUdsReceipt>) => {
				resources.bindingRuntime.retire = async (): Promise<void> =>
					await Promise.reject(new Error('binding failed'));
			},
		},
		{
			code: 'attachment-unsubscribe-failed',
			install: (resources: MutableLifecycleResources<TestUdsReceipt>) => {
				resources.attachmentPublisher.unsubscribe = (): never => {
					throw new Error('attachment unsubscribe failed');
				};
			},
		},
		{
			code: 'readiness-evidence-flush-failed',
			install: (resources: MutableLifecycleResources<TestUdsReceipt>) => {
				resources.readinessLifecycle.flushEvidence = async (): Promise<void> =>
					await Promise.reject(new Error('readiness evidence failed'));
			},
		},
		{
			code: 'readiness-control-flush-failed',
			install: (resources: MutableLifecycleResources<TestUdsReceipt>) => {
				resources.readinessLifecycle.flushControlPublisher = async (): Promise<void> =>
					await Promise.reject(new Error('readiness publication failed'));
			},
		},
		{
			code: 'control-heartbeat-flush-failed',
			install: (resources: MutableLifecycleResources<TestUdsReceipt>) => {
				resources.heartbeatPublisher.flush = async (): Promise<void> =>
					await Promise.reject(new Error('heartbeat flush failed'));
			},
		},
		{
			code: 'readiness-control-unsubscribe-failed',
			install: (resources: MutableLifecycleResources<TestUdsReceipt>) => {
				resources.readinessLifecycle.unsubscribeControlPublisher = (): never => {
					throw new Error('readiness unsubscribe failed');
				};
			},
		},
		{
			code: 'control-retirement-failed',
			install: (resources: MutableLifecycleResources<TestUdsReceipt>) => {
				resources.controlEndpoint.close = async (): Promise<void> =>
					await Promise.reject(new Error('control failed'));
			},
		},
		{
			code: 'provider-retirement-failed',
			install: (resources: MutableLifecycleResources<TestUdsReceipt>) => {
				resources.providerRuntime.close = async (): Promise<void> =>
					await Promise.reject(new Error('provider failed'));
			},
		},
		{
			code: 'artifact-retirement-failed',
			install: (resources: MutableLifecycleResources<TestUdsReceipt>) => {
				resources.artifactEpoch.retire = async (): Promise<void> =>
					await Promise.reject(new Error('artifact failed'));
			},
		},
	] satisfies readonly {
		readonly code: GatewayRuntimeProductionRetirementFailureCode;
		readonly install: (resources: MutableLifecycleResources<TestUdsReceipt>) => void;
	}[];

	for (const failingStage of failingStages) {
		it(`continues through terminal evidence after ${failingStage.code}`, async () => {
			// Arrange
			const events: string[] = [];
			const resources = createSuccessfulResources(events);
			failingStage.install(resources);
			const lifecycle = createLifecycle({ events, resources });

			// Act
			const failure = await lifecycle.retire().catch((error: unknown) => error);

			// Assert
			expect(failure).toBeInstanceOf(GatewayRuntimeProductionLifecycleError);
			expect(failure).toMatchObject({ failureCodes: [failingStage.code] });
			expect(events.at(-1)).toBe('terminal-evidence');
		});
	}

	it('aggregates ordered stage failures and records the complete failure code cohort', async () => {
		// Arrange
		const events: string[] = [];
		const evidenceOutcomes: unknown[] = [];
		const resources = createSuccessfulResources(events);
		resources.udsServer.retire = async (): Promise<TestUdsReceipt> =>
			await Promise.reject(new Error('UDS failed'));
		resources.bindingRuntime.retire = async (): Promise<void> =>
			await Promise.reject(new Error('binding failed'));
		resources.controlEndpoint.close = async (): Promise<void> =>
			await Promise.reject(new Error('control failed'));
		const lifecycle = createGatewayRuntimeProductionLifecycle<
			TestUdsReceipt,
			TestRetirementReceipt
		>({
			createRetirementReceipt: ({ udsRetirementReceipt }) => ({
				kind: 'retired',
				uds: udsRetirementReceipt,
			}),
			resources,
			terminalEvidence: {
				write: async (outcome): Promise<void> => {
					evidenceOutcomes.push(outcome);
				},
			},
		});

		// Act
		const failure = await lifecycle.retire().catch((error: unknown) => error);

		// Assert
		expect(failure).toMatchObject({
			failureCodes: [
				'uds-retirement-failed',
				'lease-binding-retirement-failed',
				'control-retirement-failed',
			],
		});
		expect(evidenceOutcomes).toEqual([
			{
				failureCodes: [
					'uds-retirement-failed',
					'lease-binding-retirement-failed',
					'control-retirement-failed',
				],
				kind: 'retirement-failed',
			},
		]);
	});

	it('includes terminal evidence failure without replaying retirement', async () => {
		// Arrange
		const events: string[] = [];
		const lifecycle = createGatewayRuntimeProductionLifecycle<
			TestUdsReceipt,
			TestRetirementReceipt
		>({
			createRetirementReceipt: ({ udsRetirementReceipt }) => ({
				kind: 'retired',
				uds: udsRetirementReceipt,
			}),
			resources: createSuccessfulResources(events),
			terminalEvidence: {
				write: async (): Promise<void> => {
					throw new Error('terminal evidence failed');
				},
			},
		});

		// Act
		const firstRetirement = lifecycle.retire();
		const secondRetirement = lifecycle.retire();
		const failure = await firstRetirement.catch((error: unknown) => error);

		// Assert
		expect(secondRetirement).toBe(firstRetirement);
		expect(failure).toMatchObject({ failureCodes: ['retirement-evidence-write-failed'] });
		expect(events.filter((event) => event === 'uds-retire')).toHaveLength(1);
	});

	it('uses one concurrent retirement promise and the first drain options', async () => {
		// Arrange
		const events: string[] = [];
		const observedDrainTimeouts: (number | undefined)[] = [];
		const resources = createSuccessfulResources(events);
		resources.udsServer.retire = async (options): Promise<TestUdsReceipt> => {
			observedDrainTimeouts.push(options?.drainTimeoutMs);
			return successfulUdsReceipt;
		};
		resources.controlEndpoint.close = async (options): Promise<void> => {
			observedDrainTimeouts.push(options?.drainTimeoutMs);
		};
		const lifecycle = createLifecycle({ events, resources });

		// Act
		const firstRetirement = lifecycle.retire({ drainTimeoutMs: 13 });
		const secondRetirement = lifecycle.retire({ drainTimeoutMs: 99 });
		await firstRetirement;

		// Assert
		expect(secondRetirement).toBe(firstRetirement);
		expect(observedDrainTimeouts).toEqual([13, 13]);
	});

	it('cleans a partial startup in lifecycle order with binding retirement before control close', async () => {
		// Arrange
		const events: string[] = [];
		const resources = createSuccessfulResources(events);

		// Act
		await cleanupPartiallyStartedGatewayRuntimeProductionLifecycle({
			resources: {
				artifactEpoch: resources.artifactEpoch,
				bindingRuntime: resources.bindingRuntime,
				controlEndpoint: resources.controlEndpoint,
				providerRuntime: resources.providerRuntime,
				udsServer: resources.udsServer,
			},
		});

		// Assert
		expect(events).toEqual([
			'uds-retire',
			'binding-retire',
			'control-close',
			'provider-close',
			'artifact-retire',
		]);
	});
});
