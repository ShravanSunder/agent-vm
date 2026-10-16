/// <reference types="node" />
/// <reference lib="es2024" />
import { describe, expect, it } from 'vitest';

import { type CacheObservation } from './inspect-e2e-image-cache.ts';
import {
	cacheRoot,
	fixture,
	imagePath,
	observation,
	rewriteMetadata,
	toolFingerprint,
} from './probe-e2e-image-boot-fixture.ts';
import { runMemoryProbe } from './probe-e2e-image-memory.ts';

describe('retained Tool 1G comparison', () => {
	it('uses exactly the selected Tool image at 1G through the shared probe and rehashes after close', async () => {
		const data = fixture();
		const events: string[] = [];
		const result = await runMemoryProbe({
			...data.dependencies,
			inspect: async () => {
				events.push('inspect');
				return observation();
			},
		});
		expect(result.exitCode).toBe(0);
		expect(data.options).toHaveLength(1);
		expect(data.events).toEqual(['create:0', 'start:0', 'close:0']);
		expect(events).toEqual(['inspect', 'inspect']);
		expect(data.options[0]).toMatchObject({
			memory: '1G',
			cpus: 1,
			rootfs: { mode: 'cow', size: '12G' },
			sandbox: { imagePath: imagePath(toolFingerprint), debug: ['protocol', 'vfs'] },
			env: {},
			vfs: { fuseMount: '/data', mounts: {} },
		});
		expect(data.hookOptions).toEqual([
			{ secretPlaceholderMode: 'unique', allowedHosts: [], secrets: {} },
		]);
		expect(result.record).toMatchObject({
			kind: 'stock-sdk-image-memory-comparison',
			comparison: 'tool-1g-after-2g-baseline',
			requestedMemory: '1G',
			inputStatus: 'available',
			probe: {
				family: 'toolVm',
				name: 'default',
				requestedMemory: '1G',
				stockReadinessDefaultMs: 120000,
				process: { status: 'observed', memory: '1G' },
				cleanup: { close: 'resolved', runner: 'exited' },
				postBootAssetIdentity: 'unchanged',
			},
		});
		for (const privateValue of [cacheRoot, '/proc/', 'fixture-private', '987654321'])
			expect(JSON.stringify(result.record)).not.toContain(privateValue);
	});
	it.each(['rebuilt-cache', 'unconfirmed'] as const)(
		'boots nothing for %s and labels the unavailable comparison',
		async (experiment) => {
			const before = observation();
			const data = fixture([], { ...before, provenance: { ...before.provenance, experiment } });
			const result = await runMemoryProbe(data.dependencies);
			expect(result.record).toMatchObject({
				inputStatus: 'different-experiment',
				requestedMemory: '1G',
				probe: null,
			});
			expect(data.events).toEqual([]);
			expect(data.hookOptions).toEqual([]);
		},
	);
	it('preserves measured-asset admission before creating a VM', async () => {
		const before = rewriteMetadata(observation(), (metadata) => ({
			...metadata,
			assets: metadata.assets.map((asset) => ({
				...asset,
				bytes: { status: 'measured', sizeBytes: 3, sha256: '8'.repeat(64), checksumMatch: false },
			})),
		}));
		const data = fixture([], before);
		const result = await runMemoryProbe(data.dependencies);
		expect(result.record).toMatchObject({ inputStatus: 'invalid-assets', probe: null });
		expect(data.events).toEqual([]);
	});
	it('retains default readiness refusal without creating a VM', async () => {
		const data = fixture();
		const result = await runMemoryProbe({
			...data.dependencies,
			environment: { GONDOLIN_START_TIMEOUT_MS: '1' },
		});
		expect(result.record).toMatchObject({ inputStatus: 'custom-start-timeout', probe: null });
		expect(data.events).toEqual([]);
	});
	it.each([
		{ behavior: { stillAlive: true }, close: 'resolved', runner: 'still-observed' },
		{ behavior: { exitUnknown: true }, close: 'resolved', runner: 'unknown' },
		{ behavior: { noPublicPid: true }, close: 'resolved', runner: 'unknown' },
		{
			behavior: { closeError: new Error('fixture-private-close') },
			close: 'rejected',
			runner: 'exited',
		},
	])(
		'returns nonzero for unverified or rejected cleanup %#',
		async ({ behavior, close, runner }) => {
			const data = fixture([behavior]);
			const result = await runMemoryProbe(data.dependencies);
			expect(result.exitCode).toBe(1);
			expect(data.options).toHaveLength(1);
			expect(result.record.probe?.cleanup).toMatchObject({ close, runner });
		},
	);
	it('preserves exact startup error identity while a clean timeout remains diagnostic-only', async () => {
		const error = Object.assign(new Error('fixture-private-start'), { code: 'vm_start_timeout' });
		const data = fixture([{ startError: error }]);
		const result = await runMemoryProbe(data.dependencies);
		expect(result.primaryError).toBe(error);
		expect(result.exitCode).toBe(0);
		expect(result.record.probe?.startup).toEqual({ phase: 'start', status: 'timeout' });
		expect(JSON.stringify(result.record)).not.toContain('fixture-private');
	});
	it('never calls create failure a clean observation', async () => {
		const error = new Error('fixture-private-create');
		const data = fixture([{ createError: error }]);
		const result = await runMemoryProbe(data.dependencies);
		expect(result.primaryError).toBe(error);
		expect(result.exitCode).toBe(1);
		expect(result.record.probe?.cleanup).toMatchObject({ close: 'not-created', runner: 'unknown' });
	});
	it.each([
		{
			name: 'changed bytes',
			post: rewriteMetadata(observation(), (metadata) => ({
				...metadata,
				assets: metadata.assets.map((asset) => ({
					...asset,
					bytes: { status: 'measured', sizeBytes: 3, sha256: '8'.repeat(64), checksumMatch: false },
				})),
			})),
			expected: 'changed',
		},
		{
			name: 'missing image measurement',
			post: rewriteMetadata(observation(), () => ({ status: 'missing' })),
			expected: 'unavailable',
		},
		{
			name: 'missing prepared manifest',
			post: {
				...observation(),
				preparedManifest: { status: 'missing' },
			} satisfies CacheObservation,
			expected: 'unavailable',
		},
	])('returns nonzero for $name after close', async ({ post, expected }) => {
		const data = fixture();
		let inspections = 0;
		const result = await runMemoryProbe({
			...data.dependencies,
			inspect: async () => {
				inspections += 1;
				return inspections === 1 ? observation() : post;
			},
		});
		expect(inspections).toBe(2);
		expect(result.exitCode).toBe(1);
		expect(result.record.probe?.postBootAssetIdentity).toBe(expected);
		expect(data.events.at(-1)).toBe('close:0');
	});
});
