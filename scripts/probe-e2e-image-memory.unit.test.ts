/// <reference types="node" />
/// <reference lib="es2024" />
import { describe, expect, it } from 'vitest';

import {
	InspectionFailure,
	inspectionLimits,
	type InspectionIo,
	type InspectionPathInfo,
	type CacheObservation,
} from './inspect-e2e-image-cache.ts';
import {
	cacheRoot,
	fixture as sdkFixture,
	imagePath,
	observation as baseObservation,
	rewriteMetadata,
	toolFingerprint,
	sha256,
} from './probe-e2e-image-boot-fixture.ts';
import { runMemoryProbe } from './probe-e2e-image-memory.ts';

const kernelPath = imagePath(toolFingerprint) + '/vmlinuz-virt';
function kernelBytes(
	props: {
		readonly protocol?: number;
		readonly initrdAddrMax?: number;
		readonly xloadflags?: number;
	} = {},
): Buffer {
	const bytes = Buffer.alloc(1024, 0);
	bytes.write('fixture-private-kernel-secret', 0x20, 'ascii');
	bytes.write('HdrS', 0x202, 'ascii');
	bytes.writeUInt16LE(props.protocol ?? 0x20c, 0x206);
	bytes.writeUInt32LE(props.initrdAddrMax ?? 0x7fffffff, 0x22c);
	bytes.writeUInt16LE(props.xloadflags ?? 2, 0x236);
	return bytes;
}
function observation(bytes: Uint8Array = kernelBytes()): CacheObservation {
	return rewriteMetadata(baseObservation(), (metadata) => ({
		...metadata,
		assets: metadata.assets.map((asset) =>
			asset.role === 'kernel'
				? {
						...asset,
						declaredSha256: sha256(bytes),
						bytes: {
							status: 'measured',
							sizeBytes: bytes.byteLength,
							sha256: sha256(bytes),
							checksumMatch: true,
						},
					}
				: asset,
		),
	}));
}
function fixture(
	behaviors: Parameters<typeof sdkFixture>[0] = [{}],
	before: CacheObservation = observation(),
	bytes: Uint8Array = kernelBytes(),
): ReturnType<typeof sdkFixture> {
	const data = sdkFixture(behaviors, before);
	const original = data.dependencies.inputIo;
	const inputIo: InspectionIo = {
		async lstat(filePath: string): Promise<InspectionPathInfo> {
			if (filePath === kernelPath)
				return { kind: 'file', sizeBytes: bytes.byteLength, identity: 'fixture-kernel' };
			return await original.lstat(filePath);
		},
		realpath: original.realpath,
		async *readChunks(props: Parameters<InspectionIo['readChunks']>[0]): AsyncIterable<Uint8Array> {
			if (props.filePath === kernelPath) {
				yield bytes;
				return;
			}
			yield* original.readChunks(props);
		},
	};
	return { ...data, dependencies: { ...data.dependencies, inputIo } };
}

describe('retained Tool 2049M comparison', () => {
	it('uses exactly the selected Tool image at 2049M through the shared probe and rehashes after close', async () => {
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
			memory: '2049M',
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
			comparison: 'tool-2049m-after-2g-baseline',
			requestedMemory: '2049M',
			inputStatus: 'available',
			probe: {
				family: 'toolVm',
				name: 'default',
				requestedMemory: '2049M',
				stockReadinessDefaultMs: 120000,
				process: { status: 'observed', memory: '2049M' },
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
				requestedMemory: '2049M',
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

describe('bound kernel header admission for the exact 2G boundary control', () => {
	it('measures literal little-endian fields, binds the full hash, and then requests 2049M', async () => {
		const data = fixture();
		const result = await runMemoryProbe(data.dependencies);
		expect(result.record).toMatchObject({
			inputStatus: 'available',
			kernelHeader: {
				status: 'measured-bzimage',
				kernelSha256: sha256(kernelBytes()),
				protocol: 524,
				initrdAddrMax: 2147483647,
				xloadflags: 2,
				applicability: 'necessary-page-match',
			},
			probe: { requestedMemory: '2049M', process: { status: 'observed', memory: '2049M' } },
		});
		expect(data.options[0]?.memory).toBe('2049M');
		expect(Object.keys(result.record.kernelHeader).toSorted()).toEqual([
			'applicability',
			'initrdAddrMax',
			'kernelSha256',
			'protocol',
			'status',
			'xloadflags',
		]);
		expect(JSON.stringify(result.record)).not.toContain('fixture-private');
	});
	it.each([
		{ protocol: 0x202, max: 0x7fffffff, flags: 65535, expectedFlags: null, applicable: false },
		{ protocol: 0x203, max: 0x7fffffff, flags: 65535, expectedFlags: null, applicable: true },
		{ protocol: 0x20b, max: 0x7ffff000, flags: 65535, expectedFlags: null, applicable: true },
		{ protocol: 0x20c, max: 0x7fffffff, flags: 0, expectedFlags: 0, applicable: true },
		{ protocol: 0x20c, max: 0x7fffffff, flags: 2, expectedFlags: 2, applicable: true },
		{ protocol: 0x20c, max: 0xffffffff, flags: 2, expectedFlags: 2, applicable: false },
		{ protocol: 0x20c, max: 0x37ffffff, flags: 2, expectedFlags: 2, applicable: false },
	])('requires the protocol and unsigned page condition %#', async (entry) => {
		const bytes = kernelBytes({
			protocol: entry.protocol,
			initrdAddrMax: entry.max,
			xloadflags: entry.flags,
		});
		const data = fixture([], observation(bytes), bytes);
		const result = await runMemoryProbe(data.dependencies);
		expect(result.record).toMatchObject({
			inputStatus: entry.applicable ? 'available' : 'hypothesis-not-applicable',
			kernelHeader: {
				status: 'measured-bzimage',
				protocol: entry.protocol,
				initrdAddrMax: entry.max,
				xloadflags: entry.expectedFlags,
				applicability: entry.applicable ? 'necessary-page-match' : 'hypothesis-not-applicable',
			},
		});
		expect(data.options).toHaveLength(entry.applicable ? 1 : 0);
		if (!entry.applicable) expect(result.record.probe).toBeNull();
	});
	it('parses across field chunk boundaries and consumes the generator through its identity check', async () => {
		const data = fixture();
		const original = data.dependencies.inputIo;
		const bytes = kernelBytes();
		let reachedEnd = false;
		const result = await runMemoryProbe({
			...data.dependencies,
			inputIo: {
				...original,
				async *readChunks(props): AsyncIterable<Uint8Array> {
					if (props.filePath !== kernelPath) {
						yield* original.readChunks(props);
						return;
					}
					expect(props.maxBytes).toBe(inspectionLimits.kernel);
					expect(props.identity).toBe('fixture-kernel');
					const boundaries = [
						0,
						0x202,
						0x203,
						0x206,
						0x207,
						0x22c,
						0x22e,
						0x236,
						0x237,
						0x238,
						bytes.byteLength,
					];
					for (let index = 0; index < boundaries.length - 1; index += 1)
						yield bytes.subarray(boundaries[index], boundaries[index + 1]);
					reachedEnd = true;
				},
			},
		});
		expect(reachedEnd).toBe(true);
		expect(result.record).toMatchObject({
			inputStatus: 'available',
			kernelHeader: { protocol: 524, initrdAddrMax: 2147483647, xloadflags: 2 },
		});
	});
	it.each(['short', 'not-bzimage'] as const)(
		'boots nothing for %s with a complete matching hash',
		async (status) => {
			const bytes =
				status === 'short' ? Buffer.from('fixture-private-short') : Buffer.alloc(1024, 1);
			const data = fixture([], observation(bytes), bytes);
			const result = await runMemoryProbe(data.dependencies);
			expect(result.record).toMatchObject({
				inputStatus: 'kernel-header-unavailable',
				kernelHeader: { status, kernelSha256: sha256(bytes) },
				probe: null,
			});
			expect(result.exitCode).toBe(0);
			expect(data.events).toEqual([]);
		},
	);
	it('labels the unextended shared fixture as header-unavailable instead of a control boot', async () => {
		const data = sdkFixture();
		const result = await runMemoryProbe(data.dependencies);
		expect(result.record).toMatchObject({
			inputStatus: 'kernel-header-unavailable',
			kernelHeader: { status: 'unavailable', reason: 'unsafe-path' },
			probe: null,
		});
		expect(data.events).toEqual([]);
	});
	it.each(['symlink', 'directory', 'other'] as const)(
		'refuses a kernel leaf of kind %s',
		async (kind) => {
			const data = fixture();
			const original = data.dependencies.inputIo;
			const result = await runMemoryProbe({
				...data.dependencies,
				inputIo: {
					...original,
					async lstat(filePath): Promise<InspectionPathInfo> {
						return filePath === kernelPath
							? { kind, sizeBytes: 1024, identity: 'unsafe' }
							: await original.lstat(filePath);
					},
				},
			});
			expect(result.record).toMatchObject({
				inputStatus: 'kernel-header-unavailable',
				kernelHeader: { status: 'unavailable', reason: 'unsafe-path' },
				probe: null,
			});
			expect(data.options).toEqual([]);
		},
	);
	it('refuses a canonical kernel path escaping the selected image', async () => {
		const data = fixture();
		const original = data.dependencies.inputIo;
		const result = await runMemoryProbe({
			...data.dependencies,
			inputIo: {
				...original,
				async realpath(filePath): Promise<string> {
					return filePath === kernelPath
						? '/fixture-private-other/kernel'
						: await original.realpath(filePath);
				},
			},
		});
		expect(result.record).toMatchObject({
			kernelHeader: { status: 'unavailable', reason: 'unsafe-path' },
			probe: null,
		});
		expect(data.options).toEqual([]);
	});
	it.each([0, -1, Number.NaN, inspectionLimits.kernel + 1])(
		'rejects an invalid or capped kernel size %s',
		async (sizeBytes) => {
			const data = fixture();
			const original = data.dependencies.inputIo;
			const result = await runMemoryProbe({
				...data.dependencies,
				inputIo: {
					...original,
					async lstat(filePath): Promise<InspectionPathInfo> {
						return filePath === kernelPath
							? { kind: 'file', sizeBytes, identity: 'fixture-kernel' }
							: await original.lstat(filePath);
					},
				},
			});
			expect(result.record).toMatchObject({
				inputStatus: 'kernel-header-unavailable',
				probe: null,
			});
			expect(data.options).toEqual([]);
		},
	);
	it('fails closed when lstat size is stale relative to the selected measured asset', async () => {
		const data = fixture();
		const original = data.dependencies.inputIo;
		const result = await runMemoryProbe({
			...data.dependencies,
			inputIo: {
				...original,
				async lstat(filePath): Promise<InspectionPathInfo> {
					return filePath === kernelPath
						? { kind: 'file', sizeBytes: 1025, identity: 'fixture-kernel' }
						: await original.lstat(filePath);
				},
			},
		});
		expect(result.exitCode).toBe(1);
		expect(result.record).toMatchObject({
			inputStatus: 'kernel-header-changed',
			kernelHeader: { status: 'changed', reason: 'size-mismatch' },
			probe: null,
		});
		expect(data.options).toEqual([]);
	});
	it.each(['short-read', 'tail-mismatch', 'identity-changed', 'read-failed'] as const)(
		'consumes the complete stream and records %s without creating a VM',
		async (mode) => {
			const data = fixture();
			const original = data.dependencies.inputIo;
			const error =
				mode === 'identity-changed'
					? new InspectionFailure('changed-during-read')
					: new Error('fixture-private-read-error');
			const bytes = kernelBytes();
			if (mode === 'tail-mismatch') bytes[1023] = 1;
			const result = await runMemoryProbe({
				...data.dependencies,
				inputIo: {
					...original,
					async *readChunks(props): AsyncIterable<Uint8Array> {
						if (props.filePath !== kernelPath) {
							yield* original.readChunks(props);
							return;
						}
						yield mode === 'short-read' ? bytes.subarray(0, 1023) : bytes;
						if (mode === 'identity-changed' || mode === 'read-failed') throw error;
					},
				},
			});
			expect(result.exitCode).toBe(mode === 'read-failed' ? 0 : 1);
			expect(result.record).toMatchObject({
				inputStatus: mode === 'read-failed' ? 'kernel-header-unavailable' : 'kernel-header-changed',
				probe: null,
				kernelHeader:
					mode === 'read-failed'
						? { status: 'unavailable', reason: 'read-failed' }
						: {
								status: 'changed',
								reason:
									mode === 'short-read'
										? 'size-mismatch'
										: mode === 'tail-mismatch'
											? 'hash-mismatch'
											: 'identity-changed',
							},
			});
			expect(data.options).toEqual([]);
			if (mode === 'identity-changed' || mode === 'read-failed')
				expect(result.primaryError).toBe(error);
			for (const value of ['fixture-private', kernelPath, '/proc/'])
				expect(JSON.stringify(result.record)).not.toContain(value);
		},
	);
	it('caps an overproducing stream without retaining a full kernel copy', async () => {
		const before = rewriteMetadata(observation(), (metadata) => ({
			...metadata,
			assets: metadata.assets.map((asset) =>
				asset.role === 'kernel'
					? {
							...asset,
							bytes: {
								status: 'measured',
								sizeBytes: inspectionLimits.kernel,
								sha256: '7'.repeat(64),
								checksumMatch: true,
							},
						}
					: asset,
			),
		}));
		const data = fixture([], before);
		const original = data.dependencies.inputIo;
		let yielded = 0;
		const block = Buffer.alloc(1024 * 1024);
		const result = await runMemoryProbe({
			...data.dependencies,
			inputIo: {
				...original,
				async lstat(filePath): Promise<InspectionPathInfo> {
					return filePath === kernelPath
						? { kind: 'file', sizeBytes: inspectionLimits.kernel, identity: 'fixture-kernel' }
						: await original.lstat(filePath);
				},
				async *readChunks(props): AsyncIterable<Uint8Array> {
					if (props.filePath !== kernelPath) {
						yield* original.readChunks(props);
						return;
					}
					for (let index = 0; index < 66; index += 1) {
						yielded += 1;
						yield block;
					}
				},
			},
		});
		expect(yielded).toBe(65);
		expect(result.exitCode).toBe(1);
		expect(result.record).toMatchObject({
			inputStatus: 'kernel-header-changed',
			kernelHeader: { status: 'changed', reason: 'over-limit' },
			probe: null,
		});
		expect(data.options).toEqual([]);
	});
});
