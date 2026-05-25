import { v7 as uuidv7, validate as validateUuid, version as uuidVersion } from 'uuid';

export type ToolVmActiveUseOutcome =
	| 'abandoned'
	| 'cancelled'
	| 'completed'
	| 'failed'
	| 'timed-out';

export interface ToolVmActiveUseCorrelation {
	readonly agentId?: string | undefined;
	readonly sessionId?: string | undefined;
	readonly sessionKey?: string | undefined;
	readonly toolCallId?: string | undefined;
	readonly toolName?: string | undefined;
}

export type ToolVmSshOperationPhase =
	| 'completed'
	| 'failed'
	| 'probe-succeeded'
	| 'running'
	| 'starting';

export type ToolVmSshFailureKind =
	| 'active-use-refreshable-failure'
	| 'ssh-command-failed'
	| 'ssh-command-timed-out'
	| 'ssh-probe-failed';

export interface ToolVmSshFailureReport {
	readonly kind: ToolVmSshFailureKind;
	readonly message: string;
}

export interface ToolVmSshOperationReport {
	readonly failure?: ToolVmSshFailureReport | undefined;
	readonly probeSucceeded?: boolean | undefined;
}

export interface ToolVmActiveUseOperationReport {
	readonly observedAtMs: number;
	readonly phase: ToolVmSshOperationPhase;
	readonly ssh?: ToolVmSshOperationReport | undefined;
}

export interface StartToolVmActiveUseRequest {
	readonly correlation?: ToolVmActiveUseCorrelation | undefined;
	readonly report?: ToolVmActiveUseOperationReport | undefined;
	readonly useId: string;
}

export interface StartToolVmActiveUseResponse {
	readonly expiresAt: number;
	readonly heartbeatAfterMs: number;
	readonly useId: string;
}

export interface HeartbeatToolVmActiveUseResponse {
	readonly expiresAt: number;
	readonly heartbeatAfterMs: number;
}

export interface HeartbeatToolVmActiveUseRequest {
	readonly report?: ToolVmActiveUseOperationReport | undefined;
}

export interface EndToolVmActiveUseRequest {
	readonly outcome: ToolVmActiveUseOutcome;
	readonly report?: ToolVmActiveUseOperationReport | undefined;
}

export interface ToolVmActiveUseHandle {
	readonly useId: string;
	dispose(outcome?: ToolVmActiveUseOutcome): Promise<void>;
	end(outcome?: ToolVmActiveUseOutcome): Promise<void>;
	report(report: ToolVmActiveUseOperationReport): void;
}

export interface CreateToolVmActiveUseHandleOptions {
	readonly correlation?: ToolVmActiveUseCorrelation | undefined;
	readonly endActiveUse: (useId: string, request: EndToolVmActiveUseRequest) => Promise<void>;
	readonly heartbeatActiveUse: (
		useId: string,
		request: HeartbeatToolVmActiveUseRequest,
	) => Promise<HeartbeatToolVmActiveUseResponse>;
	readonly heartbeatJitterRatio?: number | undefined;
	readonly isEndErrorTolerable?: (error: unknown) => boolean;
	readonly isHeartbeatErrorRefreshable?: (error: unknown) => boolean;
	readonly logEndFailure?: (error: unknown) => void;
	readonly logHeartbeatFailure?: (error: unknown) => void;
	readonly maxHeartbeatDurationMs?: number | undefined;
	readonly nowImpl?: (() => number) | undefined;
	readonly onRefreshableHeartbeatFailure?: (error: unknown) => Promise<void>;
	readonly randomImpl?: (() => number) | undefined;
	readonly startActiveUse: (
		request: StartToolVmActiveUseRequest,
	) => Promise<StartToolVmActiveUseResponse>;
	readonly setTimeoutImpl?: typeof setTimeout | undefined;
	readonly clearTimeoutImpl?: typeof clearTimeout | undefined;
}

type HeartbeatTimer = ReturnType<typeof setTimeout>;

const defaultMaxHeartbeatDurationMs = 12 * 60 * 60 * 1000;

function jitterDelayMs(params: {
	readonly delayMs: number;
	readonly jitterRatio: number;
	readonly random: () => number;
}): number {
	if (params.jitterRatio <= 0) {
		return params.delayMs;
	}
	const spreadMs = params.delayMs * params.jitterRatio;
	const minMs = params.delayMs - spreadMs;
	const jitteredMs = minMs + params.random() * spreadMs * 2;
	return Math.max(1, Math.round(jitteredMs));
}

export function createToolVmActiveUseId(): string {
	return uuidv7();
}

export function isToolVmActiveUseId(value: string): boolean {
	return validateUuid(value) && uuidVersion(value) === 7;
}

export async function createToolVmActiveUseHandle(
	options: CreateToolVmActiveUseHandleOptions,
): Promise<ToolVmActiveUseHandle> {
	const useId = createToolVmActiveUseId();
	const startedUse = await options.startActiveUse({
		...(options.correlation ? { correlation: options.correlation } : {}),
		useId,
	});
	const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
	const clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
	const now = options.nowImpl ?? Date.now;
	const startedAt = now();
	const maxHeartbeatDurationMs = options.maxHeartbeatDurationMs ?? defaultMaxHeartbeatDurationMs;
	const heartbeatJitterRatio = options.heartbeatJitterRatio ?? 0.1;
	const random = options.randomImpl ?? Math.random;
	let ended = false;
	let heartbeatTimer: HeartbeatTimer | undefined;
	let latestReport: ToolVmActiveUseOperationReport | undefined;

	const clearHeartbeatTimer = (): void => {
		if (heartbeatTimer) {
			clearTimeoutImpl(heartbeatTimer);
			heartbeatTimer = undefined;
		}
	};

	const scheduleHeartbeat = (delayMs: number): void => {
		if (now() - startedAt >= maxHeartbeatDurationMs) {
			return;
		}
		clearHeartbeatTimer();
		heartbeatTimer = setTimeoutImpl(() => {
			if (now() - startedAt >= maxHeartbeatDurationMs) {
				return;
			}
			const heartbeatRequest: HeartbeatToolVmActiveUseRequest =
				latestReport === undefined ? {} : { report: latestReport };
			void options
				.heartbeatActiveUse(startedUse.useId, heartbeatRequest)
				.then((heartbeat) => {
					if (!ended) {
						scheduleHeartbeat(heartbeat.heartbeatAfterMs);
					}
				})
				.catch((error: unknown) => {
					options.logHeartbeatFailure?.(error);
					if (
						options.isHeartbeatErrorRefreshable?.(error) === true &&
						options.onRefreshableHeartbeatFailure
					) {
						ended = true;
						clearHeartbeatTimer();
						void options.onRefreshableHeartbeatFailure(error).catch((staleError: unknown) => {
							options.logHeartbeatFailure?.(staleError);
						});
						return;
					}
					if (!ended) {
						scheduleHeartbeat(startedUse.heartbeatAfterMs);
					}
				});
		}, jitterDelayMs({ delayMs, jitterRatio: heartbeatJitterRatio, random }));
	};

	scheduleHeartbeat(startedUse.heartbeatAfterMs);

	const end = async (outcome: ToolVmActiveUseOutcome = 'completed'): Promise<void> => {
		if (ended) {
			return;
		}
		ended = true;
		clearHeartbeatTimer();
		try {
			await options.endActiveUse(startedUse.useId, {
				outcome,
				...(latestReport === undefined ? {} : { report: latestReport }),
			});
		} catch (error) {
			if (options.isEndErrorTolerable?.(error) === true) {
				options.logEndFailure?.(error);
				return;
			}
			throw error;
		}
	};

	return {
		useId: startedUse.useId,
		dispose: end,
		end,
		report: (report): void => {
			latestReport = report;
		},
	};
}
