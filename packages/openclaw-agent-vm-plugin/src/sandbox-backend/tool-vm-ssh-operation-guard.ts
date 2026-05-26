import type {
	AgentVmHealthEvent,
	ToolVmActiveUseOperationReport,
	ToolVmSshHealthOperation,
	ToolVmSshFailureKind,
} from '@agent-vm/gateway-interface';

export class ToolVmSshOperationStaleError extends Error {
	override readonly cause: unknown;
	readonly reason: ToolVmSshFailureKind;

	constructor(options: {
		readonly cause: unknown;
		readonly message: string;
		readonly reason: ToolVmSshFailureKind;
	}) {
		super(options.message);
		this.cause = options.cause;
		this.reason = options.reason;
	}
}

export interface ToolVmSshOperationGuardOptions<TResult> {
	readonly clearTimeoutImpl?: typeof clearTimeout | undefined;
	readonly healthEvent?: {
		readonly agentId: string;
		readonly leaseId: string;
		readonly operation: ToolVmSshHealthOperation;
		readonly publish: (event: AgentVmHealthEvent) => Promise<void>;
		readonly zoneId: string;
	};
	readonly now?: (() => number) | undefined;
	readonly operation: (signal: AbortSignal) => Promise<TResult>;
	readonly operationName: string;
	readonly report: (report: ToolVmActiveUseOperationReport) => void;
	readonly setTimeoutImpl?: typeof setTimeout | undefined;
	readonly timeoutMs: number;
	readonly writeLog?: (message: string) => void;
}

function formatUnknownError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function defaultWriteLog(message: string): void {
	process.stderr.write(`[tool-vm-ssh-operation-guard] ${message}\n`);
}

async function publishHealthEvent(options: {
	readonly elapsedMs: number;
	readonly errorCode?: string | undefined;
	readonly guardOptions: Pick<ToolVmSshOperationGuardOptions<unknown>, 'healthEvent' | 'writeLog'>;
	readonly observedAtMs: number;
	readonly result: 'failed' | 'ok';
}): Promise<void> {
	if (!options.guardOptions.healthEvent) {
		return;
	}
	const event = {
		agentId: options.guardOptions.healthEvent.agentId,
		elapsedMs: options.elapsedMs,
		...(options.errorCode === undefined ? {} : { errorCode: options.errorCode }),
		kind: 'tool-vm-ssh',
		leaseId: options.guardOptions.healthEvent.leaseId,
		observedAtMs: options.observedAtMs,
		operation: options.guardOptions.healthEvent.operation,
		result: options.result,
		zoneId: options.guardOptions.healthEvent.zoneId,
	} satisfies AgentVmHealthEvent;
	try {
		await options.guardOptions.healthEvent.publish(event);
	} catch (error) {
		(options.guardOptions.writeLog ?? defaultWriteLog)(
			`tool-vm-ssh health publish failed operation=${options.guardOptions.healthEvent.operation} elapsedMs=${String(options.elapsedMs)} error=${formatUnknownError(error)}`,
		);
	}
}

export async function runToolVmSshOperationWithGuard<TResult>(
	options: ToolVmSshOperationGuardOptions<TResult>,
): Promise<TResult> {
	const now = options.now ?? Date.now;
	const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
	const clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
	const abortController = new AbortController();
	const startedAtMs = now();
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

	options.report({
		observedAtMs: now(),
		phase: 'running',
	});

	const timeoutPromise = new Promise<never>((_resolve, reject) => {
		timeoutHandle = setTimeoutImpl(() => {
			abortController.abort();
			reject(
				new ToolVmSshOperationStaleError({
					cause: undefined,
					message: `${options.operationName} exceeded ${String(options.timeoutMs)}ms.`,
					reason: 'ssh-command-timed-out',
				}),
			);
		}, options.timeoutMs);
	});

	try {
		const result = await Promise.race([options.operation(abortController.signal), timeoutPromise]);
		options.report({
			observedAtMs: now(),
			phase: 'completed',
			ssh: { probeSucceeded: true },
		});
		const observedAtMs = now();
		await publishHealthEvent({
			elapsedMs: observedAtMs - startedAtMs,
			guardOptions: options,
			observedAtMs,
			result: 'ok',
		});
		return result;
	} catch (error) {
		const staleError =
			error instanceof ToolVmSshOperationStaleError
				? error
				: new ToolVmSshOperationStaleError({
						cause: error,
						message: formatUnknownError(error),
						reason: 'ssh-command-failed',
					});
		options.report({
			observedAtMs: now(),
			phase: 'failed',
			ssh: {
				failure: {
					kind: staleError.reason,
					message: staleError.message,
				},
			},
		});
		const observedAtMs = now();
		await publishHealthEvent({
			elapsedMs: observedAtMs - startedAtMs,
			errorCode: staleError.reason,
			guardOptions: options,
			observedAtMs,
			result: 'failed',
		});
		throw staleError;
	} finally {
		if (timeoutHandle !== undefined) {
			clearTimeoutImpl(timeoutHandle);
		}
	}
}
