import { v7 as uuidv7, validate as validateUuid, version as uuidVersion } from 'uuid';

export type ToolVmActiveUseOutcome =
	| 'abandoned'
	| 'cancelled'
	| 'completed'
	| 'failed'
	| 'timed-out';

export interface ToolVmActiveUseCorrelation {
	readonly agentId?: string;
	readonly sessionId?: string;
	readonly sessionKey?: string;
	readonly toolCallId?: string;
	readonly toolName?: string;
}

export interface StartToolVmActiveUseRequest {
	readonly correlation?: ToolVmActiveUseCorrelation;
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

export interface EndToolVmActiveUseRequest {
	readonly outcome: ToolVmActiveUseOutcome;
}

export interface ToolVmActiveUseHandle {
	readonly useId: string;
	dispose(outcome?: ToolVmActiveUseOutcome): Promise<void>;
	end(outcome?: ToolVmActiveUseOutcome): Promise<void>;
}

export interface CreateToolVmActiveUseHandleOptions {
	readonly correlation?: ToolVmActiveUseCorrelation;
	readonly endActiveUse: (useId: string, request: EndToolVmActiveUseRequest) => Promise<void>;
	readonly heartbeatActiveUse: (useId: string) => Promise<HeartbeatToolVmActiveUseResponse>;
	readonly isEndErrorTolerable?: (error: unknown) => boolean;
	readonly logEndFailure?: (error: unknown) => void;
	readonly logHeartbeatFailure?: (error: unknown) => void;
	readonly maxHeartbeatDurationMs?: number;
	readonly nowImpl?: () => number;
	readonly startActiveUse: (
		request: StartToolVmActiveUseRequest,
	) => Promise<StartToolVmActiveUseResponse>;
	readonly setTimeoutImpl?: typeof setTimeout;
	readonly clearTimeoutImpl?: typeof clearTimeout;
}

type HeartbeatTimer = ReturnType<typeof setTimeout>;

const defaultMaxHeartbeatDurationMs = 12 * 60 * 60 * 1000;

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
	let ended = false;
	let heartbeatTimer: HeartbeatTimer | undefined;

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
			void options
				.heartbeatActiveUse(startedUse.useId)
				.then((heartbeat) => {
					if (!ended) {
						scheduleHeartbeat(heartbeat.heartbeatAfterMs);
					}
				})
				.catch((error: unknown) => {
					options.logHeartbeatFailure?.(error);
					if (!ended) {
						scheduleHeartbeat(startedUse.heartbeatAfterMs);
					}
				});
		}, delayMs);
	};

	scheduleHeartbeat(startedUse.heartbeatAfterMs);

	const end = async (outcome: ToolVmActiveUseOutcome = 'completed'): Promise<void> => {
		if (ended) {
			return;
		}
		ended = true;
		clearHeartbeatTimer();
		try {
			await options.endActiveUse(startedUse.useId, { outcome });
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
	};
}
