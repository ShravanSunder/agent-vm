const HEARTBEAT_CADENCE_MS_DEFAULT = 10_000;
const HEARTBEAT_REQUEST_TIMEOUT_MS = 5_000;

const TERMINAL_STATUS_CODES = new Set([404, 410]);

export interface HeartbeatSenderProps {
	readonly callerUrl: string;
	readonly cadenceMs?: number;
	readonly setIntervalImpl?: (
		callback: () => void | Promise<void>,
		delayMs: number,
	) => NodeJS.Timeout;
	readonly clearIntervalImpl?: (handle: NodeJS.Timeout) => void;
	readonly fetchImpl?: typeof fetch;
	readonly logWarning?: (message: string) => void;
}

export interface HeartbeatHandle {
	readonly stop: () => void;
}

function defaultLogWarning(message: string): void {
	process.stderr.write(`[heartbeat] ${message}\n`);
}

export function startHeartbeatSender(
	requestTaskId: string,
	props: HeartbeatSenderProps,
): HeartbeatHandle {
	const cadenceMs = props.cadenceMs ?? HEARTBEAT_CADENCE_MS_DEFAULT;
	const setIntervalFn = props.setIntervalImpl ?? setInterval;
	const clearIntervalFn = props.clearIntervalImpl ?? clearInterval;
	const fetchFn = props.fetchImpl ?? fetch;
	const logWarning = props.logWarning ?? defaultLogWarning;
	const url = `${props.callerUrl.replace(/\/$/, '')}/tasks/${encodeURIComponent(requestTaskId)}/heartbeat`;

	let stopped = false;
	const timer = setIntervalFn(() => void tick(), cadenceMs);
	let consecutiveFailureCount = 0;
	let inFlight = false;
	let activeAbort: AbortController | undefined;
	let activeTimeoutHandle: ReturnType<typeof setTimeout> | undefined;

	function stopTicker(): void {
		if (stopped) {
			return;
		}
		stopped = true;
		clearIntervalFn(timer);
		activeAbort?.abort();
		if (activeTimeoutHandle) {
			clearTimeout(activeTimeoutHandle);
		}
	}

	function recordHeartbeatFailure(message: string): void {
		consecutiveFailureCount += 1;
		if (consecutiveFailureCount === 1) {
			logWarning(message);
			return;
		}
		if (consecutiveFailureCount === 3) {
			logWarning(
				`task ${requestTaskId}: heartbeat has failed 3 consecutive times; the caller may treat this run as stalled`,
			);
		}
	}

	function resetHeartbeatFailures(): void {
		consecutiveFailureCount = 0;
	}

	async function tick(): Promise<void> {
		if (stopped || inFlight) {
			return;
		}
		inFlight = true;
		const abort = new AbortController();
		const timeoutHandle = setTimeout(() => abort.abort(), HEARTBEAT_REQUEST_TIMEOUT_MS);
		activeAbort = abort;
		activeTimeoutHandle = timeoutHandle;
		try {
			const response = await fetchFn(url, {
				method: 'POST',
				signal: abort.signal,
			});
			if (TERMINAL_STATUS_CODES.has(response.status)) {
				logWarning(
					`task ${requestTaskId}: caller returned HTTP ${String(response.status)} from ${url} - stopping heartbeat permanently`,
				);
				stopTicker();
				return;
			}
			if (!response.ok) {
				recordHeartbeatFailure(
					`task ${requestTaskId}: caller returned HTTP ${String(response.status)} from ${url}`,
				);
				return;
			}
			resetHeartbeatFailures();
		} catch (error) {
			if (stopped && abort.signal.aborted) {
				return;
			}
			const message = error instanceof Error ? error.message : String(error);
			recordHeartbeatFailure(`task ${requestTaskId}: heartbeat POST failed to ${url}: ${message}`);
		} finally {
			clearTimeout(timeoutHandle);
			if (activeTimeoutHandle === timeoutHandle) {
				activeTimeoutHandle = undefined;
			}
			if (activeAbort === abort) {
				activeAbort = undefined;
			}
			inFlight = false;
		}
	}

	void tick();

	return {
		stop() {
			stopTicker();
		},
	};
}
