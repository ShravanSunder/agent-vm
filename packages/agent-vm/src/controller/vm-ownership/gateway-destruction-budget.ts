export const GATEWAY_DESTRUCTION_TARGET_TIMEOUT_MS = 60_000;
export const GATEWAY_SUBTREE_DESTRUCTION_TIMEOUT_MS = 300_000;

export type GatewayDestructionTimeoutCode =
	| 'GATEWAY_DESTRUCTION_TARGET_TIMEOUT'
	| 'GATEWAY_SUBTREE_DESTRUCTION_TIMEOUT';

export class GatewayDestructionTimeoutError extends Error {
	public constructor(
		public readonly code: GatewayDestructionTimeoutCode,
		public readonly target: string,
		public readonly timeoutMs: number,
	) {
		super(`Gateway destruction ${target} timed out after ${timeoutMs}ms`);
		this.name = 'GatewayDestructionTimeoutError';
	}
}

export interface GatewayDestructionBudgetClock {
	clearTimeout(timer: NodeJS.Timeout): void;
	setTimeout(callback: () => void, delayMs: number): NodeJS.Timeout;
}

export interface GatewaySubtreeDestructionAttempt {
	readonly signal: AbortSignal;
	runSubtree<TResult>(operation: (signal: AbortSignal) => Promise<TResult>): Promise<TResult>;
	runTarget<TResult>(target: string, operation: () => Promise<TResult>): Promise<TResult>;
	throwIfExpired(stage: string): void;
}

export interface GatewayDestructionBudget {
	createSubtreeAttempt(): GatewaySubtreeDestructionAttempt;
	runTarget<TResult>(target: string, operation: () => Promise<TResult>): Promise<TResult>;
}

const defaultGatewayDestructionBudgetClock: GatewayDestructionBudgetClock = {
	clearTimeout: (timer): void => clearTimeout(timer),
	setTimeout: (callback, delayMs): NodeJS.Timeout => {
		const timer = setTimeout(callback, delayMs);
		timer.unref?.();
		return timer;
	},
};

async function runWithDeadline<TResult>(options: {
	readonly clock: GatewayDestructionBudgetClock;
	readonly code: GatewayDestructionTimeoutCode;
	readonly onTimeout?: () => void;
	readonly operation: () => Promise<TResult>;
	readonly target: string;
	readonly timeoutMs: number;
}): Promise<TResult> {
	let timeout: NodeJS.Timeout | undefined;
	const timeoutError = new GatewayDestructionTimeoutError(
		options.code,
		options.target,
		options.timeoutMs,
	);
	const timeoutPromise = new Promise<never>((_resolve, reject) => {
		timeout = options.clock.setTimeout(() => {
			options.onTimeout?.();
			reject(timeoutError);
		}, options.timeoutMs);
	});
	const operationPromise = Promise.resolve().then(options.operation);
	try {
		return await Promise.race([operationPromise, timeoutPromise]);
	} finally {
		if (timeout !== undefined) {
			options.clock.clearTimeout(timeout);
		}
	}
}

export function createGatewayDestructionBudget(
	options: {
		readonly clock?: GatewayDestructionBudgetClock;
		readonly subtreeTimeoutMs?: number;
		readonly targetTimeoutMs?: number;
	} = {},
): GatewayDestructionBudget {
	const clock = options.clock ?? defaultGatewayDestructionBudgetClock;
	const subtreeTimeoutMs = options.subtreeTimeoutMs ?? GATEWAY_SUBTREE_DESTRUCTION_TIMEOUT_MS;
	const targetTimeoutMs = options.targetTimeoutMs ?? GATEWAY_DESTRUCTION_TARGET_TIMEOUT_MS;
	const runTarget = async <TResult>(
		target: string,
		operation: () => Promise<TResult>,
	): Promise<TResult> =>
		await runWithDeadline({
			clock,
			code: 'GATEWAY_DESTRUCTION_TARGET_TIMEOUT',
			operation,
			target,
			timeoutMs: targetTimeoutMs,
		});

	return {
		createSubtreeAttempt(): GatewaySubtreeDestructionAttempt {
			const abortController = new AbortController();
			let subtreeTimeoutError: GatewayDestructionTimeoutError | undefined;
			let started = false;
			return {
				signal: abortController.signal,
				async runSubtree<TResult>(
					operation: (signal: AbortSignal) => Promise<TResult>,
				): Promise<TResult> {
					if (started) {
						throw new Error('Gateway subtree destruction attempt has already started.');
					}
					started = true;
					return await runWithDeadline({
						clock,
						code: 'GATEWAY_SUBTREE_DESTRUCTION_TIMEOUT',
						onTimeout: () => {
							subtreeTimeoutError = new GatewayDestructionTimeoutError(
								'GATEWAY_SUBTREE_DESTRUCTION_TIMEOUT',
								'Gateway subtree',
								subtreeTimeoutMs,
							);
							abortController.abort(subtreeTimeoutError);
						},
						operation: async () => await operation(abortController.signal),
						target: 'Gateway subtree',
						timeoutMs: subtreeTimeoutMs,
					});
				},
				async runTarget<TResult>(
					target: string,
					operation: () => Promise<TResult>,
				): Promise<TResult> {
					return await runTarget(target, operation);
				},
				throwIfExpired(stage): void {
					if (subtreeTimeoutError !== undefined || abortController.signal.aborted) {
						throw (
							subtreeTimeoutError ??
							new GatewayDestructionTimeoutError(
								'GATEWAY_SUBTREE_DESTRUCTION_TIMEOUT',
								stage,
								subtreeTimeoutMs,
							)
						);
					}
				},
			};
		},
		runTarget,
	};
}
