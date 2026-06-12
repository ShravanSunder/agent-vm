import { describe, expect, test } from 'vitest';

import type {
	ExternalObservabilityRuntimeConfig,
	ManagedObservabilityRuntimeConfig,
} from './observability-config.js';
import { checkObservabilityStackReadiness } from './observability-readiness.js';

function createRuntimeConfig(): ManagedObservabilityRuntimeConfig {
	return {
		enabled: true,
		stackMode: 'managed',
		projectName: 'agent-vm-observability-sunfam',
		runtimeDir: '/tmp/runtime/observability/sunfam',
		dataDir: '/tmp/observability/sunfam',
		bindAddress: '127.0.0.1',
		ports: {
			collectorGrpc: 4317,
			collectorHttp: 4318,
			collectorHealth: 13_133,
			metrics: 8428,
			logs: 9428,
			traces: 10_428,
		},
		retention: {
			metrics: { period: '30d' },
			logs: { period: '14d' },
			traces: { period: '7d' },
		},
		prepareOnBuild: true,
		waitOnBuild: true,
		controllerStartPolicy: 'degraded',
		startupCheckTimeoutMs: 500,
		zones: [
			{
				zoneId: 'shravan',
				serviceName: 'agent-vm-openclaw-shravan',
				traces: true,
				metrics: true,
				logs: true,
				sampleRate: 1,
				flushIntervalMs: 10_000,
				diagnosticsFlags: [],
			},
		],
	};
}

function createExternalRuntimeConfig(): ExternalObservabilityRuntimeConfig {
	const {
		dataDir: _dataDir,
		projectName: _projectName,
		retention: _retention,
		...baseConfig
	} = createRuntimeConfig();
	return {
		...baseConfig,
		stackMode: 'external',
	};
}

describe('checkObservabilityStackReadiness', () => {
	test('checks the configured loopback collector and Victoria health endpoints', async () => {
		const requestedUrls: string[] = [];
		const result = await checkObservabilityStackReadiness({
			config: createRuntimeConfig(),
			fetchImpl: async (url) => {
				requestedUrls.push(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url);
				return new Response(null, { status: 200 });
			},
		});

		expect(result).toEqual({ ok: true, status: 'ready' });
		expect(requestedUrls).toEqual([
			'http://127.0.0.1:13133/',
			'http://127.0.0.1:8428/health',
			'http://127.0.0.1:9428/health',
			'http://127.0.0.1:10428/health',
		]);
	});

	test('checks only the collector health endpoint for external observability', async () => {
		const requestedUrls: string[] = [];
		const result = await checkObservabilityStackReadiness({
			config: createExternalRuntimeConfig(),
			fetchImpl: async (url) => {
				requestedUrls.push(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url);
				return new Response(null, { status: 200 });
			},
		});

		expect(result).toEqual({ ok: true, status: 'ready' });
		expect(requestedUrls).toEqual(['http://127.0.0.1:13133/']);
	});

	test('reports an unavailable backend without throwing', async () => {
		const result = await checkObservabilityStackReadiness({
			config: { ...createRuntimeConfig(), startupCheckTimeoutMs: 5 },
			fetchImpl: async (url) =>
				new Response(null, {
					status: typeof url === 'string' && url.includes(':9428/') ? 503 : 200,
				}),
			retryDelayMs: 1,
		});

		expect(result).toEqual({
			ok: false,
			reason: 'victoria-logs health check returned HTTP 503',
			status: 'unavailable',
		});
	});

	test('includes node network error codes in readiness failures', async () => {
		const cause = new Error('connect ECONNREFUSED 127.0.0.1:13133');
		Object.defineProperty(cause, 'code', { value: 'ECONNREFUSED' });
		const result = await checkObservabilityStackReadiness({
			config: { ...createRuntimeConfig(), startupCheckTimeoutMs: 5 },
			fetchImpl: async () => {
				throw new TypeError('fetch failed', { cause });
			},
			retryDelayMs: 1,
		});

		expect(result).toEqual({
			ok: false,
			reason: 'collector health check failed: fetch failed (ECONNREFUSED)',
			status: 'unavailable',
		});
	});

	test('accepts collector OTLP HTTP reachability when the collector health port is refused', async () => {
		const requestedUrls: string[] = [];
		const cause = new Error('connect ECONNREFUSED 127.0.0.1:13133');
		Object.defineProperty(cause, 'code', { value: 'ECONNREFUSED' });
		const result = await checkObservabilityStackReadiness({
			config: createRuntimeConfig(),
			fetchImpl: async (url) => {
				const requestedUrl =
					typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
				requestedUrls.push(requestedUrl);
				if (requestedUrl === 'http://127.0.0.1:13133/') {
					throw new TypeError('fetch failed', { cause });
				}
				return new Response(null, { status: 200 });
			},
			retryDelayMs: 1,
		});

		expect(result).toEqual({ ok: true, status: 'ready' });
		expect(requestedUrls).toEqual([
			'http://127.0.0.1:13133/',
			'http://127.0.0.1:4318/v1/logs',
			'http://127.0.0.1:8428/health',
			'http://127.0.0.1:9428/health',
			'http://127.0.0.1:10428/health',
		]);
	});

	test('retries transient network failures within the configured timeout', async () => {
		let attemptCount = 0;
		const result = await checkObservabilityStackReadiness({
			config: createRuntimeConfig(),
			fetchImpl: async () => {
				attemptCount += 1;
				if (attemptCount === 1) {
					throw new Error('fetch failed');
				}
				return new Response(null, { status: 200 });
			},
			retryDelayMs: 1,
		});

		expect(result).toEqual({ ok: true, status: 'ready' });
		expect(attemptCount).toBe(5);
	});
});
