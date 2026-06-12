import type { EnabledObservabilityRuntimeConfig } from './observability-config.js';

export type ObservabilityReadinessResult =
	| {
			readonly ok: true;
			readonly status: 'ready';
	  }
	| {
			readonly ok: false;
			readonly reason: string;
			readonly status: 'unavailable';
	  };

export interface CheckObservabilityStackReadinessOptions {
	readonly config: EnabledObservabilityRuntimeConfig;
	readonly fetchImpl?: typeof fetch;
	readonly retryDelayMs?: number;
}

function formatHttpHost(host: '127.0.0.1' | '::1'): string {
	return host === '::1' ? '[::1]' : host;
}

interface ObservabilityHealthEndpoint {
	readonly name: string;
	readonly url: string;
}

function createHealthEndpoints(
	config: EnabledObservabilityRuntimeConfig,
): readonly ObservabilityHealthEndpoint[] {
	const host = formatHttpHost(config.bindAddress);
	const collectorEndpoint = {
		name: 'collector',
		url: `http://${host}:${String(config.ports.collectorHealth)}/`,
	} as const;
	if (config.stackMode === 'external') {
		return [collectorEndpoint];
	}
	return [
		collectorEndpoint,
		{
			name: 'victoria-metrics',
			url: `http://${host}:${String(config.ports.metrics)}/health`,
		},
		{
			name: 'victoria-logs',
			url: `http://${host}:${String(config.ports.logs)}/health`,
		},
		{
			name: 'victoria-traces',
			url: `http://${host}:${String(config.ports.traces)}/health`,
		},
	];
}

function readErrorCauseCode(error: Error): string | undefined {
	const cause = error.cause;
	if (typeof cause !== 'object' || cause === null || !('code' in cause)) {
		return undefined;
	}
	const code = cause.code;
	return typeof code === 'string' && code.length > 0 ? code : undefined;
}

function formatReadinessError(error: unknown): string {
	if (!(error instanceof Error)) {
		return String(error);
	}
	const causeCode = readErrorCauseCode(error);
	return causeCode === undefined ? error.message : `${error.message} (${causeCode})`;
}

export async function checkObservabilityStackReadiness(
	options: CheckObservabilityStackReadinessOptions,
): Promise<ObservabilityReadinessResult> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const retryDelayMs = options.retryDelayMs ?? 100;
	const healthEndpoints = createHealthEndpoints(options.config);
	const deadlineMs = Date.now() + options.config.startupCheckTimeoutMs;
	let lastErrorReason = 'observability health checks did not complete';
	try {
		for (;;) {
			let ready = true;
			for (const endpoint of healthEndpoints) {
				const remainingMs = Math.max(1, deadlineMs - Date.now());
				try {
					// oxlint-disable-next-line no-await-in-loop -- bounded readiness checks must preserve failure attribution
					const response = await fetchImpl(endpoint.url, {
						signal: AbortSignal.timeout(remainingMs),
					});
					if (!response.ok) {
						ready = false;
						lastErrorReason = `${endpoint.name} health check returned HTTP ${String(
							response.status,
						)}`;
						break;
					}
				} catch (error) {
					ready = false;
					lastErrorReason = `${endpoint.name} health check failed: ${formatReadinessError(error)}`;
					break;
				}
			}
			if (ready) {
				return { ok: true, status: 'ready' };
			}
			if (Date.now() >= deadlineMs) {
				break;
			}
			// oxlint-disable-next-line no-await-in-loop -- bounded readiness polling for transient port binding races
			await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
		}
	} catch (error) {
		lastErrorReason = error instanceof Error ? error.message : String(error);
	}
	return {
		ok: false,
		reason: lastErrorReason,
		status: 'unavailable',
	};
}
