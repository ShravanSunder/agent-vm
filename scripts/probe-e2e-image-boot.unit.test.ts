/// <reference types="node" />
/// <reference lib="es2024" />
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type CacheObservation } from './inspect-e2e-image-cache.ts';
import {
	cacheRoot,
	toolFingerprint,
	gatewayFingerprint,
	imagePath,
	rawManifest,
	manifestBytes,
	sha256,
	observation,
	inputIo,
	fixture,
	firstInput,
	rewriteMetadata,
} from './probe-e2e-image-boot-fixture.ts';
import { probeOneImage, runBootProbe, type PublicProbeSdk } from './probe-e2e-image-boot.ts';

afterEach(() => {
	vi.useRealTimers();
});

describe('stock public SDK image boot probe', () => {
	it('boots Tool first and waits for its close plus observed exit before creating Gateway', async () => {
		const data = fixture();
		const result = await runBootProbe(data.dependencies);
		expect(result.exitCode).toBe(0);
		expect(data.events).toEqual([
			'create:0',
			'start:0',
			'close:0',
			'create:1',
			'start:1',
			'close:1',
		]);
		expect(
			result.records.map((record) => [
				record.family,
				record.cleanup.close,
				record.cleanup.runner,
				record.postBootAssetIdentity,
			]),
		).toEqual([
			['toolVm', 'resolved', 'exited', 'unchanged'],
			['gateway', 'resolved', 'exited', 'unchanged'],
		]);
		expect(data.options.map((options) => options.sandbox.imagePath)).toEqual([
			imagePath(toolFingerprint),
			imagePath(gatewayFingerprint),
		]);
		expect(data.hookOptions).toEqual([
			{ secretPlaceholderMode: 'unique', allowedHosts: [], secrets: {} },
			{ secretPlaceholderMode: 'unique', allowedHosts: [], secrets: {} },
		]);
		for (const options of data.options) {
			expect(Object.keys(options).toSorted()).toEqual([
				'cpus',
				'debugLog',
				'env',
				'httpHooks',
				'memory',
				'rootfs',
				'sandbox',
				'vfs',
			]);
			expect(options).toMatchObject({
				memory: '2G',
				cpus: 1,
				rootfs: { mode: 'cow', size: '12G' },
				env: {},
				vfs: { fuseMount: '/data', mounts: {} },
				sandbox: { debug: ['protocol', 'vfs'] },
			});
		}
		expect(result.records[0]).toMatchObject({
			caller: 'isolated-public-sdk-no-managed-input-mounts',
			stockReadinessDefaultMs: 120000,
			beforeClose: { stdoutLineCount: 1 },
			afterClose: { stdoutLineCount: 2 },
			processCaptureTiming: 'first-qemu-event',
			process: {
				status: 'observed',
				accelerator: 'kvm',
				kernelMatchesSelectedAsset: true,
				initrdMatchesSelectedAsset: true,
			},
			cleanup: { cowAndFdCleanup: 'sdk-owner-not-independently-observed' },
		});
		const output = JSON.stringify(result.records);
		for (const forbidden of [cacheRoot, '/proc/', 'fixture-private', '987654321'])
			expect(output).not.toContain(forbidden);
	});
	it('retains the exact startup error object without exposing it in records or replacing it with close failure', async () => {
		const startupError = Object.assign(new Error('fixture-private-token-start-error'), {
			code: 'vm_start_timeout',
		});
		const cleanupError = new Error('fixture-private-close-error');
		const data = fixture([{ startError: startupError, closeError: cleanupError }]);
		const result = await probeOneImage({
			input: await firstInput(data),
			observation: observation(),
			sdk: data.dependencies.sdk,
			processIo: data.dependencies.processIo,
			now: data.dependencies.now,
		});
		expect(result.primaryError).toBe(startupError);
		expect(result.cleanupError).toBe(cleanupError);
		expect(result.exitCode).toBe(1);
		expect(result.record.startup).toEqual({ phase: 'start', status: 'timeout' });
		expect(result.record.cleanup).toMatchObject({ close: 'rejected', runner: 'exited' });
		expect(JSON.stringify(result.record)).not.toContain('fixture-private');
	});
	it.each(['vm_start_timeout', 'unrelated-code'])(
		'observes expected start failure %s without calling it live proof',
		async (code) => {
			const error = Object.assign(new Error('fixture-private-start'), { code });
			const data = fixture([{ startError: error }]);
			const result = await runBootProbe(data.dependencies);
			expect(result.exitCode).toBe(0);
			expect(result.primaryErrors[0]).toBe(error);
			expect(result.records[0]?.startup).toEqual({
				phase: 'start',
				status: code === 'vm_start_timeout' ? 'timeout' : 'failed',
			});
			expect(data.options).toHaveLength(2);
			expect(JSON.stringify(result.records)).not.toContain('fixture-private');
		},
	);
	it.each([
		{ behavior: { stillAlive: true }, close: 'resolved', runner: 'still-observed' },
		{ behavior: { exitUnknown: true }, close: 'resolved', runner: 'unknown' },
		{ behavior: { closeError: new Error('private-close') }, close: 'rejected', runner: 'exited' },
		{ behavior: { noPublicPid: true }, close: 'resolved', runner: 'unknown' },
	])(
		'stops before Gateway when Tool cleanup is not independently verified %#',
		async ({ behavior, close, runner }) => {
			const data = fixture([behavior]);
			const result = await runBootProbe(data.dependencies);
			expect(result.exitCode).toBe(1);
			expect(data.options).toHaveLength(1);
			expect(result.records[0]?.cleanup).toMatchObject({ close, runner });
			expect(result.records[1]?.startup).toEqual({
				phase: 'not-run',
				reason: 'prior-cleanup-unverified',
			});
			expect(result.records[1]?.cleanup).toMatchObject({ close: 'not-created', runner: 'unknown' });
		},
	);
	it('keeps optional argv unavailability separate from enough identity evidence to verify cleanup', async () => {
		const data = fixture([{ cmdlineUnavailable: true }]);
		const result = await runBootProbe(data.dependencies);
		expect(result.exitCode).toBe(0);
		expect(data.options).toHaveLength(2);
		expect(result.records[0]?.process).toEqual({ status: 'read-failed' });
		expect(result.records[0]?.cleanup).toMatchObject({ close: 'resolved', runner: 'exited' });
	});
	it('reports create failure and never starts a second image without verified first cleanup', async () => {
		const error = new Error('fixture-private-create');
		const data = fixture([{ createError: error }]);
		const result = await runBootProbe(data.dependencies);
		expect(result.exitCode).toBe(1);
		expect(result.primaryErrors[0]).toBe(error);
		expect(data.events).toEqual(['create:0']);
		expect(result.records[0]?.startup).toEqual({ phase: 'create', status: 'failed' });
		expect(result.records[0]?.cleanup).toMatchObject({ close: 'not-created', runner: 'unknown' });
	});
	it('does not begin an abandoned capture from a trailing console flush inside close', async () => {
		const data = fixture([{ closeOnlyConsole: true }]);
		// No public PID is exposed until close begins, so pre-close fallback cannot capture.
		const sdk = data.dependencies.sdk;
		const wrappedSdk: PublicProbeSdk = {
			...sdk,
			VM: {
				async create(options) {
					const vm = await sdk.VM.create(options);
					let closing = false;
					return {
						start: async () => {
							await vm.start();
						},
						getHostPid: () => (closing ? (vm.getHostPid?.() ?? null) : null),
						close: async () => {
							closing = true;
							await vm.close();
						},
					};
				},
			},
		};
		const result = await runBootProbe({ ...data.dependencies, sdk: wrappedSdk });
		expect(result.exitCode).toBe(1);
		expect(data.procReads).toEqual([]);
		expect(result.records[0]?.processCaptureTiming).toBe('unavailable');
		expect(result.records[0]?.afterClose).toMatchObject({ stdoutLineCount: 1 });
	});
	it('retains early identity when SDK rejects then clears its public PID on the next timer turn', async () => {
		vi.useFakeTimers();
		const error = Object.assign(new Error('fixture-private-timeout'), { code: 'vm_start_timeout' });
		const data = fixture([{ startError: error, teardownAfterRejection: true }]);
		const pending = runBootProbe(data.dependencies);
		await vi.runAllTimersAsync();
		const result = await pending;
		expect(result.primaryErrors[0]).toBe(error);
		expect(result.records[0]).toMatchObject({
			processCaptureTiming: 'first-qemu-event',
			process: { status: 'observed' },
			cleanup: { close: 'resolved', runner: 'exited' },
		});
		expect(data.events).toContain('sdk-teardown');
		expect(data.events.indexOf('sdk-teardown')).toBeLessThan(data.events.indexOf('create:1'));
		expect(result.exitCode).toBe(0);
	});
	it('honestly loses fallback capture when asynchronous reads race SDK next-turn teardown', async () => {
		vi.useFakeTimers();
		const error = Object.assign(new Error('fixture-private-timeout'), { code: 'vm_start_timeout' });
		const data = fixture([
			{
				startError: error,
				noConsole: true,
				teardownAfterRejection: true,
				loseFallbackCapture: true,
			},
		]);
		const pending = runBootProbe(data.dependencies);
		await vi.runAllTimersAsync();
		const result = await pending;
		expect(result.exitCode).toBe(1);
		expect(result.primaryErrors[0]).toBe(error);
		expect(result.records[0]).toMatchObject({
			processCaptureTiming: 'after-start',
			process: { status: 'missing' },
			cleanup: { close: 'resolved', runner: 'unknown' },
		});
		expect(data.options).toHaveLength(1);
	});
	it('records a changed post-boot hash after cleanup and returns nonzero', async () => {
		const before = observation();
		const data = fixture([{}], before);
		let inspections = 0;
		const result = await runBootProbe({
			...data.dependencies,
			inspect: async () => {
				inspections += 1;
				return inspections === 1
					? before
					: rewriteMetadata(before, (metadata) => ({
							...metadata,
							assets: metadata.assets.map((asset) => ({
								...asset,
								bytes: {
									status: 'measured',
									sizeBytes: 3,
									sha256: '8'.repeat(64),
									checksumMatch: false,
								},
							})),
						}));
			},
		});
		expect(result.exitCode).toBe(1);
		expect(inspections).toBe(2);
		expect(result.records.map((record) => record.postBootAssetIdentity)).toEqual([
			'changed',
			'changed',
		]);
		expect(data.events.at(-1)).toBe('close:1');
	});
	it('does not infer unchanged assets from missing post-boot measurements', async () => {
		const before = observation();
		const data = fixture();
		let inspections = 0;
		const result = await runBootProbe({
			...data.dependencies,
			inspect: async () => {
				inspections += 1;
				return inspections === 1 ? before : { ...before, preparedManifest: { status: 'missing' } };
			},
		});
		expect(result.exitCode).toBe(1);
		expect(result.records.map((record) => record.postBootAssetIdentity)).toEqual([
			'unavailable',
			'unavailable',
		]);
	});
});

describe('bound prepared inputs refuse unsafe or different experiments before VM.create', () => {
	it.each(['rebuilt-cache', 'unconfirmed'] as const)(
		'closes %s as a different experiment without any SDK call',
		async (experiment) => {
			const before = observation();
			const data = fixture([], { ...before, provenance: { ...before.provenance, experiment } });
			const result = await runBootProbe(data.dependencies);
			expect(result.records.map((record) => record.inputStatus)).toEqual([
				'different-experiment',
				'different-experiment',
			]);
			expect(data.events).toEqual([]);
			expect(data.hookOptions).toEqual([]);
		},
	);
	it.each([
		{
			name: 'checksum mismatch',
			change: (before: CacheObservation): CacheObservation =>
				rewriteMetadata(before, (metadata) => ({
					...metadata,
					assets: metadata.assets.map((asset) => ({
						...asset,
						bytes: {
							status: 'measured',
							sizeBytes: 3,
							sha256: '8'.repeat(64),
							checksumMatch: false,
						},
					})),
				})),
		},
		{
			name: 'missing required asset',
			change: (before: CacheObservation): CacheObservation =>
				rewriteMetadata(before, (metadata) => ({
					...metadata,
					assets: metadata.assets.filter((asset) => asset.role !== 'rootfs'),
				})),
		},
		{
			name: 'duplicate asset role',
			change: (before: CacheObservation): CacheObservation =>
				rewriteMetadata(before, (metadata) => ({
					...metadata,
					assets: [
						...metadata.assets,
						metadata.assets[0] ?? {
							role: 'kernel',
							declaredSha256: '',
							bytes: { status: 'missing' },
						},
					],
				})),
		},
		{
			name: 'unavailable image',
			change: (before: CacheObservation): CacheObservation =>
				rewriteMetadata(before, () => ({ status: 'missing' })),
		},
	])('boots nothing for $name', async ({ change }) => {
		const data = fixture([], change(observation()));
		const result = await runBootProbe(data.dependencies);
		expect(result.records.map((record) => record.inputStatus)).toEqual([
			'invalid-assets',
			'invalid-assets',
		]);
		expect(data.events).toEqual([]);
	});
	it.each([
		{
			name: 'manifest SHA changed',
			bytes: Buffer.from(JSON.stringify({ ...rawManifest, schemaVersion: 3 })),
			unsafe: false,
			bindSha: false,
			expected: 'read-failed',
		},
		{
			name: 'symlink manifest',
			bytes: manifestBytes,
			unsafe: true,
			bindSha: true,
			expected: 'read-failed',
		},
		{
			name: 'invalid recipe fingerprint',
			bytes: Buffer.from(
				JSON.stringify({
					...rawManifest,
					entries: rawManifest.entries.map((entry) => ({
						...entry,
						recipeFingerprint: '/private-token',
					})),
				}),
			),
			unsafe: false,
			bindSha: true,
			expected: 'invalid-selection',
		},
		{
			name: 'different selected fingerprint',
			bytes: Buffer.from(
				JSON.stringify({
					...rawManifest,
					entries: rawManifest.entries.map((entry) => ({ ...entry, fingerprint: '9'.repeat(16) })),
				}),
			),
			unsafe: false,
			bindSha: true,
			expected: 'invalid-selection',
		},
	])(
		'boots nothing for $name and emits no raw manifest data',
		async ({ bytes, unsafe, bindSha, expected }) => {
			const before = observation();
			const bound = bindSha
				? { ...before, preparedManifest: { status: 'measured' as const, sha256: sha256(bytes) } }
				: before;
			const data = fixture([], bound);
			const result = await runBootProbe({ ...data.dependencies, inputIo: inputIo(bytes, unsafe) });
			expect(result.records.map((record) => record.inputStatus)).toEqual([expected, expected]);
			expect(data.events).toEqual([]);
			expect(JSON.stringify(result.records)).not.toContain('/private-token');
		},
	);
	it('refuses an externally overridden readiness timeout rather than changing stock behavior', async () => {
		const data = fixture();
		const result = await runBootProbe({
			...data.dependencies,
			environment: { GONDOLIN_START_TIMEOUT_MS: '1', PRIVATE_TEST_ENV: 'fixture-private-token' },
		});
		expect(result.records.map((record) => record.inputStatus)).toEqual([
			'custom-start-timeout',
			'custom-start-timeout',
		]);
		expect(data.events).toEqual([]);
		expect(JSON.stringify(result.records)).not.toContain('fixture-private');
	});
});
