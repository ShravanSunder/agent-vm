type GatewayRuntimeLifecycleResult<TResult> = TResult | Promise<TResult>;

export const GATEWAY_RUNTIME_PRODUCTION_RETIREMENT_FAILURE_CODES = [
	'control-heartbeat-stop-failed',
	'uds-retirement-failed',
	'lease-binding-retirement-failed',
	'attachment-unsubscribe-failed',
	'readiness-evidence-flush-failed',
	'readiness-control-flush-failed',
	'control-heartbeat-flush-failed',
	'readiness-control-unsubscribe-failed',
	'control-retirement-failed',
	'provider-retirement-failed',
	'artifact-retirement-failed',
	'retirement-receipt-failed',
	'retirement-evidence-write-failed',
] as const;

export type GatewayRuntimeProductionRetirementFailureCode =
	(typeof GATEWAY_RUNTIME_PRODUCTION_RETIREMENT_FAILURE_CODES)[number];

export interface GatewayRuntimeProductionRetirementOptions {
	readonly drainTimeoutMs?: number;
}

export interface GatewayRuntimeProductionHeartbeatPublisherLifecycle {
	readonly flush: () => Promise<void>;
	readonly stop: () => GatewayRuntimeLifecycleResult<void>;
}

export interface GatewayRuntimeProductionReadinessLifecycle {
	readonly flushControlPublisher: () => Promise<void>;
	readonly flushEvidence: () => Promise<void>;
	readonly unsubscribeControlPublisher: () => GatewayRuntimeLifecycleResult<void>;
}

export interface GatewayRuntimeProductionLifecycleResources<TUdsRetirementReceipt extends object> {
	readonly artifactEpoch: {
		readonly retire: () => Promise<void>;
	};
	readonly attachmentPublisher: {
		readonly unsubscribe: () => GatewayRuntimeLifecycleResult<void>;
	};
	readonly bindingRuntime: {
		readonly retire: () => Promise<void>;
	};
	readonly controlEndpoint: {
		readonly close: (options?: GatewayRuntimeProductionRetirementOptions) => Promise<void>;
	};
	readonly heartbeatPublisher: GatewayRuntimeProductionHeartbeatPublisherLifecycle;
	readonly providerRuntime: {
		readonly close: () => Promise<void>;
	};
	readonly readinessLifecycle: GatewayRuntimeProductionReadinessLifecycle;
	readonly udsServer: {
		readonly retire: (
			options?: GatewayRuntimeProductionRetirementOptions,
		) => Promise<TUdsRetirementReceipt>;
	};
}

export type PartialGatewayRuntimeProductionLifecycleResources<
	TUdsRetirementReceipt extends object,
> = {
	readonly [TResourceName in keyof GatewayRuntimeProductionLifecycleResources<TUdsRetirementReceipt>]?: GatewayRuntimeProductionLifecycleResources<TUdsRetirementReceipt>[TResourceName];
};

export type GatewayRuntimeProductionTerminalOutcome<TRetirementReceipt> =
	| {
			readonly kind: 'retired';
			readonly receipt: TRetirementReceipt;
	  }
	| {
			readonly failureCodes: readonly GatewayRuntimeProductionRetirementFailureCode[];
			readonly kind: 'retirement-failed';
	  };

export interface GatewayRuntimeProductionTerminalEvidenceLifecycle<TRetirementReceipt> {
	readonly write: (
		outcome: GatewayRuntimeProductionTerminalOutcome<TRetirementReceipt>,
	) => Promise<void>;
}

interface GatewayRuntimeProductionLifecycleFailure {
	readonly cause: unknown;
	readonly code: GatewayRuntimeProductionRetirementFailureCode;
}

export class GatewayRuntimeProductionLifecycleError extends AggregateError {
	readonly failureCodes: readonly GatewayRuntimeProductionRetirementFailureCode[];

	constructor(failures: readonly GatewayRuntimeProductionLifecycleFailure[]) {
		super(
			failures.map((failure) => failure.cause),
			'Gateway runtime production lifecycle retirement failed.',
		);
		this.name = 'GatewayRuntimeProductionLifecycleError';
		this.failureCodes = Object.freeze(failures.map((failure) => failure.code));
	}
}

interface GatewayRuntimeProductionLifecycleRunResult<TUdsRetirementReceipt extends object> {
	readonly failures: GatewayRuntimeProductionLifecycleFailure[];
	readonly udsRetirementReceipt: TUdsRetirementReceipt | undefined;
}

async function attemptLifecycleStage<TResult>(props: {
	readonly failureCode: GatewayRuntimeProductionRetirementFailureCode;
	readonly failures: GatewayRuntimeProductionLifecycleFailure[];
	readonly operation: (() => GatewayRuntimeLifecycleResult<TResult>) | undefined;
}): Promise<TResult | undefined> {
	if (props.operation === undefined) return undefined;
	try {
		return await props.operation();
	} catch (error: unknown) {
		props.failures.push({ cause: error, code: props.failureCode });
		return undefined;
	}
}

function retirementOptions(
	drainTimeoutMs: number | undefined,
): GatewayRuntimeProductionRetirementOptions | undefined {
	return drainTimeoutMs === undefined ? undefined : { drainTimeoutMs };
}

async function runGatewayRuntimeProductionLifecycle<TUdsRetirementReceipt extends object>(props: {
	readonly drainTimeoutMs?: number;
	readonly resources: PartialGatewayRuntimeProductionLifecycleResources<TUdsRetirementReceipt>;
}): Promise<GatewayRuntimeProductionLifecycleRunResult<TUdsRetirementReceipt>> {
	const failures: GatewayRuntimeProductionLifecycleFailure[] = [];
	const options = retirementOptions(props.drainTimeoutMs);
	const udsServer = props.resources.udsServer;
	const controlEndpoint = props.resources.controlEndpoint;

	await attemptLifecycleStage({
		failureCode: 'control-heartbeat-stop-failed',
		failures,
		operation: props.resources.heartbeatPublisher?.stop,
	});
	const udsRetirementReceipt = await attemptLifecycleStage({
		failureCode: 'uds-retirement-failed',
		failures,
		operation: udsServer === undefined ? undefined : async () => await udsServer.retire(options),
	});
	await attemptLifecycleStage({
		failureCode: 'lease-binding-retirement-failed',
		failures,
		operation: props.resources.bindingRuntime?.retire,
	});
	await attemptLifecycleStage({
		failureCode: 'attachment-unsubscribe-failed',
		failures,
		operation: props.resources.attachmentPublisher?.unsubscribe,
	});
	await attemptLifecycleStage({
		failureCode: 'readiness-evidence-flush-failed',
		failures,
		operation: props.resources.readinessLifecycle?.flushEvidence,
	});
	await attemptLifecycleStage({
		failureCode: 'readiness-control-flush-failed',
		failures,
		operation: props.resources.readinessLifecycle?.flushControlPublisher,
	});
	await attemptLifecycleStage({
		failureCode: 'control-heartbeat-flush-failed',
		failures,
		operation: props.resources.heartbeatPublisher?.flush,
	});
	await attemptLifecycleStage({
		failureCode: 'readiness-control-unsubscribe-failed',
		failures,
		operation: props.resources.readinessLifecycle?.unsubscribeControlPublisher,
	});
	await attemptLifecycleStage({
		failureCode: 'control-retirement-failed',
		failures,
		operation:
			controlEndpoint === undefined ? undefined : async () => await controlEndpoint.close(options),
	});
	await attemptLifecycleStage({
		failureCode: 'provider-retirement-failed',
		failures,
		operation: props.resources.providerRuntime?.close,
	});
	await attemptLifecycleStage({
		failureCode: 'artifact-retirement-failed',
		failures,
		operation: props.resources.artifactEpoch?.retire,
	});

	return { failures, udsRetirementReceipt };
}

export interface GatewayRuntimeProductionLifecycle<TRetirementReceipt> {
	readonly retire: (
		options?: GatewayRuntimeProductionRetirementOptions,
	) => Promise<TRetirementReceipt>;
}

export function createGatewayRuntimeProductionLifecycle<
	TUdsRetirementReceipt extends object,
	TRetirementReceipt,
>(props: {
	readonly createRetirementReceipt: (props: {
		readonly udsRetirementReceipt: TUdsRetirementReceipt;
	}) => TRetirementReceipt;
	readonly resources: GatewayRuntimeProductionLifecycleResources<TUdsRetirementReceipt>;
	readonly terminalEvidence: GatewayRuntimeProductionTerminalEvidenceLifecycle<TRetirementReceipt>;
}): GatewayRuntimeProductionLifecycle<TRetirementReceipt> {
	let retirementPromise: Promise<TRetirementReceipt> | undefined;

	const retire = (
		options: GatewayRuntimeProductionRetirementOptions = {},
	): Promise<TRetirementReceipt> => {
		retirementPromise ??= (async (): Promise<TRetirementReceipt> => {
			const runResult = await runGatewayRuntimeProductionLifecycle({
				...(options.drainTimeoutMs === undefined ? {} : { drainTimeoutMs: options.drainTimeoutMs }),
				resources: props.resources,
			});
			let receipt: TRetirementReceipt | undefined;
			if (runResult.failures.length === 0 && runResult.udsRetirementReceipt === undefined) {
				runResult.failures.push({
					cause: new Error('Gateway runtime UDS retirement receipt is unavailable.'),
					code: 'retirement-receipt-failed',
				});
			}
			if (runResult.failures.length === 0 && runResult.udsRetirementReceipt !== undefined) {
				try {
					receipt = props.createRetirementReceipt({
						udsRetirementReceipt: runResult.udsRetirementReceipt,
					});
				} catch (error: unknown) {
					runResult.failures.push({
						cause: error,
						code: 'retirement-receipt-failed',
					});
				}
			}

			const outcome =
				runResult.failures.length === 0 && receipt !== undefined
					? ({ kind: 'retired', receipt } as const)
					: ({
							failureCodes: Object.freeze(runResult.failures.map((failure) => failure.code)),
							kind: 'retirement-failed',
						} as const);
			try {
				await props.terminalEvidence.write(outcome);
			} catch (error: unknown) {
				runResult.failures.push({
					cause: error,
					code: 'retirement-evidence-write-failed',
				});
			}

			if (runResult.failures.length > 0 || receipt === undefined) {
				throw new GatewayRuntimeProductionLifecycleError(runResult.failures);
			}
			return receipt;
		})();
		return retirementPromise;
	};

	return { retire };
}

export async function cleanupPartiallyStartedGatewayRuntimeProductionLifecycle<
	TUdsRetirementReceipt extends object,
>(props: {
	readonly drainTimeoutMs?: number;
	readonly resources: PartialGatewayRuntimeProductionLifecycleResources<TUdsRetirementReceipt>;
}): Promise<void> {
	const runResult = await runGatewayRuntimeProductionLifecycle(props);
	if (runResult.failures.length > 0) {
		throw new GatewayRuntimeProductionLifecycleError(runResult.failures);
	}
}
