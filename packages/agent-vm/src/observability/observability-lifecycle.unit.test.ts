import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import type { ManagedObservabilityRuntimeConfig } from './observability-config.js';
import { prepareObservabilityStack } from './observability-lifecycle.js';

const createdDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		createdDirectories
			.splice(0)
			.map((directoryPath) => rm(directoryPath, { recursive: true, force: true })),
	);
});

async function createRuntimeConfig(): Promise<ManagedObservabilityRuntimeConfig> {
	const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-observability-'));
	createdDirectories.push(tempDirectory);
	return {
		enabled: true,
		stackMode: 'managed',
		projectName: 'agent-vm-observability-sunfam',
		runtimeDir: path.join(tempDirectory, 'runtime', 'observability', 'sunfam'),
		dataDir: path.join(tempDirectory, 'observability', 'sunfam'),
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
			metrics: { period: '30d', minFreeDiskSpaceBytes: '5GiB' },
			logs: { period: '14d', maxDiskSpaceUsageBytes: '50GiB' },
			traces: { period: '7d', maxDiskSpaceUsageBytes: '20GiB' },
		},
		prepareOnBuild: true,
		waitOnBuild: true,
		controllerStartPolicy: 'degraded',
		startupCheckTimeoutMs: 500,
		zones: [],
	};
}

describe('prepareObservabilityStack', () => {
	test('waits for collector readiness before reporting ready', async () => {
		const events: string[] = [];
		const config = await createRuntimeConfig();

		const result = await prepareObservabilityStack({
			config,
			runCompose: async () => {
				events.push('compose');
			},
			checkReadiness: async () => {
				events.push('readiness');
				return { ok: true, status: 'ready' };
			},
			wait: true,
		});

		expect(events).toEqual(['compose', 'readiness']);
		expect(result.status).toBe('ready');
		await expect(readFile(result.composePath, 'utf8')).resolves.toContain('victoria-metrics:');
		await expect(readFile(result.collectorConfigPath, 'utf8')).resolves.toContain(
			'attributes/drop-sensitive-fields',
		);
		expect((await stat(config.runtimeDir)).mode & 0o777).toBe(0o700);
		expect((await stat(config.dataDir)).mode & 0o777).toBe(0o700);
		expect((await stat(result.composePath)).mode & 0o777).toBe(0o600);
		expect((await stat(result.collectorConfigPath)).mode & 0o777).toBe(0o600);
	});

	test('does not claim ready when compose succeeds but collector readiness fails', async () => {
		const config = await createRuntimeConfig();

		await expect(
			prepareObservabilityStack({
				config,
				runCompose: async () => {},
				checkReadiness: async () => ({
					ok: false,
					reason: 'collector health check returned HTTP 503',
					status: 'unavailable',
				}),
				wait: true,
			}),
		).rejects.toThrow(/collector health check returned HTTP 503/u);
	});

	test('skips collector readiness check when wait is disabled', async () => {
		const config = await createRuntimeConfig();
		let readinessCalled = false;

		const result = await prepareObservabilityStack({
			config,
			runCompose: async () => {},
			checkReadiness: async () => {
				readinessCalled = true;
				return { ok: true, status: 'ready' };
			},
			wait: false,
		});

		expect(result.status).toBe('started');
		expect(readinessCalled).toBe(false);
	});

	test('reports Docker Compose startup failures with the build skip escape hatch', async () => {
		const config = await createRuntimeConfig();

		await expect(
			prepareObservabilityStack({
				config,
				runCompose: async () => {
					throw new Error('docker compose ENOENT');
				},
				wait: false,
			}),
		).rejects.toThrow(/--no-observability/u);
	});
});
