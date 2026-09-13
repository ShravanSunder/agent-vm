import { createHash } from 'node:crypto';
import type { PathLike } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, realpath, rm, type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { deriveGatewayControlStablePrincipal } from '@agent-vm/gateway-control-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPayloadMemoryProbe } from '../../testing/payload-memory-probe.js';
import { prepareGogRealFsLeaseFixture } from '../oauth/gog-realfs-authority.integration-test-fixture.js';
import { createControllerSharedStaging } from './controller-shared-staging.js';
import { accessNativeAttachment } from './native-attachment-controller-access.js';
import { createNativeAttachmentStaging } from './native-attachment-staging.js';
import { createOperationFileRetentionBudget } from './operation-file-retention-budget.js';
import type { SharedStagingDirectoryStore } from './shared-staging-directory-store.js';

const observation: { onOpen?: (filename: PathLike, handle: FileHandle) => void } = vi.hoisted(
	() => ({}),
);
vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>();
	return {
		...actual,
		open: async (...args: Parameters<typeof actual.open>): Promise<FileHandle> => {
			const handle = await actual.open(...args);
			observation.onOpen?.(args[0], handle);
			return handle;
		},
	};
});

const chunkBytes = 64 * 1024;
const payloadBytes = 8 * 1024 * 1024;
const roots: string[] = [];
afterEach(async () => {
	delete observation.onOpen;
	await Promise.all(
		roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
	);
});

async function writeDistinctPayload(filename: string): Promise<string> {
	const file = await open(filename, 'wx', 0o600);
	const chunk = Buffer.alloc(chunkBytes);
	const digest = createHash('sha256');
	try {
		for (let index = 0; index < payloadBytes / chunkBytes; index += 1) {
			chunk.fill((index * 17) % 256);
			digest.update(chunk);
			// oxlint-disable-next-line no-await-in-loop -- bounded fixture creation, not a preallocated payload.
			await file.write(chunk);
		}
	} finally {
		await file.close();
	}
	return digest.digest('hex');
}

async function fixture(): Promise<{
	readonly root: string;
	readonly cacheDirectory: string;
	readonly staging: ReturnType<typeof createNativeAttachmentStaging>;
	readonly shared: Awaited<
		ReturnType<ReturnType<typeof createControllerSharedStaging>['getStore']>
	>;
	readonly lease: Awaited<ReturnType<typeof prepareGogRealFsLeaseFixture>>;
	readonly principal: {
		readonly agentId: 'sun';
		readonly frameworkIdentity: { readonly kind: 'hermes'; readonly profileName: 'sun' };
		readonly profileAssignmentRevision: string;
		readonly toolPortalProfileId: string;
	};
	readonly sha256: string;
}> {
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'file-delivery-memory-')));
	roots.push(root);
	const cacheDirectory = path.join(root, 'gateway-cache');
	await mkdir(cacheDirectory);
	const retentionBudget = createOperationFileRetentionBudget();
	const controller = createControllerSharedStaging({
		controllerRuntimeDir: path.join(root, 'runtime'),
		controllerEpoch: 'controller-realfs',
		now: () => 1000,
		retentionBudget,
	});
	const principal = {
		agentId: 'sun',
		frameworkIdentity: { kind: 'hermes', profileName: 'sun' },
		profileAssignmentRevision: 'revision-sun',
		toolPortalProfileId: 'policy-sun',
	} as const;
	const shared = await controller.getStore('zone', principal.agentId);
	const lease = await prepareGogRealFsLeaseFixture({
		principal,
		root,
		sharedStaging: controller,
		zoneId: 'zone',
	});
	const source = await shared.prepareOperation({
		producerId: 'producer',
		operationId: 'operation',
		maximumBytes: payloadBytes,
	});
	const sha256 = await writeDistinctPayload(path.join(source, 'report.bin'));
	return {
		root,
		cacheDirectory,
		principal,
		shared,
		lease,
		sha256,
		staging: createNativeAttachmentStaging({ retentionBudget }),
	};
}

function watchFiles(root: string, stalledWrites = 1): ReturnType<typeof createPayloadMemoryProbe> {
	const probe = createPayloadMemoryProbe(stalledWrites);
	observation.onOpen = (filename, handle) => {
		if (typeof filename === 'string' && filename.startsWith(`${root}/`)) probe.observe(handle);
	};
	return probe;
}

function expectBounded(probe: ReturnType<typeof createPayloadMemoryProbe>, streams = 1): void {
	const measured = probe.snapshot();
	expect(measured.peakPendingWriteBytes).toBeLessThanOrEqual(streams * chunkBytes);
	// ArrayBuffer accounting observes native byte storage, not only generator pull counts.
	// Heap/RSS are recorded too; heap allows fixed control/Promise overhead, not an 8MiB payload.
	expect(measured.peakArrayBufferGrowth).toBeLessThan(1024 * 1024);
	expect(measured.peakHeapGrowth).toBeLessThan(4 * 1024 * 1024);
	expect(measured.pendingWriteBytes).toBe(0);
	expect(measured.openHandles).toBe(0);
	process.stdout.write(`[file-delivery-memory] ${JSON.stringify(measured)}\n`);
}

async function waitForStall(
	probe: ReturnType<typeof createPayloadMemoryProbe>,
	operation: Promise<unknown>,
): Promise<void> {
	await Promise.race([
		probe.stalled,
		operation.then(() => {
			throw new Error(
				'Production operation completed before reaching the instrumented destination stall.',
			);
		}),
	]);
}

async function publish(
	data: Awaited<ReturnType<typeof fixture>>,
	signal: AbortSignal,
): ReturnType<SharedStagingDirectoryStore['publish']> {
	return await data.shared.publish({
		producerId: 'producer',
		operationId: 'operation',
		receiver: data.lease.receiver,
		relativePaths: ['report.bin'],
		signal,
		withPublicationAuthority: async (expose) => await expose(),
	});
}

describe('resident payload memory through controller file-delivery paths', () => {
	it('detects whole-payload retention in the memory observation itself', () => {
		// Arrange / Act: negative control, not a replacement production implementation.
		const probe = createPayloadMemoryProbe(1);
		const retainedPayload = Buffer.alloc(payloadBytes, 7);
		const observed = probe.snapshot();
		// Assert: an 8MiB retained buffer cannot pass the 1MiB production bound.
		expect(observed.peakArrayBufferGrowth).toBeGreaterThan(1024 * 1024);
		expect(retainedPayload.at(-1)).toBe(7);
	});

	it.each([false, true])(
		'bounds publication with a stalled destination; cancel=%s',
		async (cancel) => {
			// Arrange: actual store, independent-inode copy and real host files, 128 windows of distinct data.
			const data = await fixture();
			const abort = new AbortController();
			const probe = watchFiles(data.root);
			try {
				// Act
				const publishing = publish(data, abort.signal);
				const outcome = publishing.then(
					(value) => ({ kind: 'published' as const, value }),
					(error: unknown) => ({ kind: 'failed' as const, error }),
				);
				await waitForStall(probe, outcome);
				// Assert while stalled: no payload-sized read-ahead before consumption.
				expect(probe.snapshot().readBytes).toBe(chunkBytes);
				expect(probe.snapshot().writtenBytes).toBe(0);
				if (cancel) abort.abort();
				probe.release();
				const result = await outcome;
				expectBounded(probe);
				if (cancel) {
					expect(result.kind).toBe('failed');
					expect(probe.snapshot().readBytes).toBe(chunkBytes);
					expect(await readdir(data.lease.receiverHostRoot)).toEqual([]);
				} else {
					if (result.kind !== 'published') throw result.error;
					expect(result.value.files).toMatchObject([
						{ byteLength: payloadBytes, sha256: data.sha256 },
					]);
				}
			} finally {
				probe.release();
				delete observation.onOpen;
				await data.lease.close();
			}
		},
	);

	it('keeps two simultaneous publication flows bounded while both destinations are stalled', async () => {
		// Arrange: two independent owners use the same host process and production publication path.
		const owners = await Promise.all([fixture(), fixture()]);
		const probe = createPayloadMemoryProbe(owners.length);
		observation.onOpen = (filename, handle) => {
			if (
				typeof filename === 'string' &&
				owners.some((owner) => filename.startsWith(`${owner.root}/`))
			)
				probe.observe(handle);
		};
		try {
			// Act
			const publications = owners.map(
				async (owner) => await publish(owner, new AbortController().signal),
			);
			await Promise.race([
				probe.stalled,
				...publications.map(async (publication) => {
					await publication;
					throw new Error('Publication completed before both destinations stalled.');
				}),
			]);
			// Assert: 16MiB on disk, only two 64KiB reads admitted into the pending writes.
			expect(probe.snapshot().readBytes).toBe(owners.length * chunkBytes);
			expect(probe.snapshot().writtenBytes).toBe(0);
			probe.release();
			const results = await Promise.all(publications);
			for (const result of results) expect(result.files[0]?.byteLength).toBe(payloadBytes);
			expectBounded(probe, owners.length);
		} finally {
			probe.release();
			delete observation.onOpen;
			await Promise.all(owners.map(async (owner) => await owner.lease.close()));
		}
	});

	it('bounds repeated reads of a published file without republishing or reproducing it', async () => {
		// Arrange
		const data = await fixture();
		const publication = await publish(data, new AbortController().signal);
		try {
			for (let delivery = 0; delivery < 2; delivery += 1) {
				const abort = new AbortController();
				const probe = watchFiles(data.root);
				const source = data.shared.readPublishedFile({
					publicationId: publication.publicationId,
					receiver: data.lease.receiver,
					relativePath: 'report.bin',
					signal: abort.signal,
				});
				const reader = source[Symbol.asyncIterator]();
				// Act: do not request another chunk while the consumer is stalled.
				// oxlint-disable-next-line no-await-in-loop -- observe each complete delivery separately.
				const first = await reader.next();
				expect(first.done).toBe(false);
				expect(probe.snapshot().readBytes).toBe(chunkBytes);
				const digest = createHash('sha256');
				if (first.done) throw new Error('Expected file bytes.');
				digest.update(first.value);
				if (delivery === 1) {
					abort.abort();
					// oxlint-disable-next-line no-await-in-loop -- cancellation must settle the current reader.
					await expect(reader.next()).rejects.toThrow();
					expect(probe.snapshot().readBytes).toBe(chunkBytes);
				} else {
					let next;
					// oxlint-disable-next-line no-await-in-loop -- a real slow-consumer seam, never collect payload chunks.
					while (!(next = await reader.next()).done) digest.update(next.value);
					expect(digest.digest('hex')).toBe(data.sha256);
				}
				// Assert
				expectBounded(probe);
			}
		} finally {
			delete observation.onOpen;
			await data.lease.close();
		}
	});

	it.each([false, true])(
		'bounds actual native controller staging and settlement; cancel=%s',
		async (cancel) => {
			// Arrange: preserve the real lease/authority join, staging owner, relay and Gateway cache writer.
			const data = await fixture();
			const publication = await publish(data, new AbortController().signal);
			const abort = new AbortController();
			const callerContext = {
				agentId: 'sun',
				bootId: data.lease.authority.gateway.bootId,
				callerContextId: '10000000-0000-4000-8000-000000000001',
				connectionId: 'connection',
				controllerEpoch: data.lease.authority.gateway.controllerEpoch,
				peerId: 'peer',
				principal: data.principal,
				purpose: 'tool_portal_controller_execution' as const,
				sessionId: 'control-session',
				stablePrincipal: deriveGatewayControlStablePrincipal({ principal: data.principal }),
				zoneId: 'zone',
			};
			const base = {
				cacheDirectory: data.cacheDirectory,
				sharedStaging: data.shared,
				staging: data.staging,
				leaseManager: data.lease.leaseManager,
				destinationVm: { id: data.lease.authority.gateway.gatewayVmId },
				destinationAuthorityIsCurrent: () => true,
			};
			const context = {
				callerContext,
				gateway: data.lease.authority.gateway,
				sessionId: 'captured-session',
				signal: abort.signal,
				executionProof: {
					operationPayloadDigest: 'attachment',
					processEpoch: 'process',
					semanticOperationId: 'native-stage',
					sessionAttachmentGeneration: 1,
				},
			};
			const probe = watchFiles(data.root);
			try {
				// Act
				const staged = accessNativeAttachment({
					...base,
					context: {
						...context,
						request: {
							action: 'stage',
							source: {
								kind: 'operation-file',
								referenceId: publication.publicationId,
								path: 'report.bin',
							},
						},
					},
				});
				await waitForStall(probe, staged);
				expect(probe.snapshot().readBytes).toBe(chunkBytes);
				expect(probe.snapshot().writtenBytes).toBe(0);
				if (cancel) abort.abort();
				probe.release();
				const result = await staged;
				// Assert
				expectBounded(probe);
				if (cancel) {
					expect(result.kind).not.toBe('staged');
					expect(probe.snapshot().readBytes).toBe(chunkBytes);
					await data.staging.reapPendingCleanup();
				} else {
					if (result.kind !== 'staged') throw new Error(`Expected staging, got ${result.kind}.`);
					expect(result).toMatchObject({ byteLength: payloadBytes, sha256: data.sha256 });
					expect(
						await accessNativeAttachment({
							...base,
							context: {
								...context,
								request: { action: 'settle', stagingId: result.stagingId, outcome: 'sent' },
							},
						}),
					).toEqual({ kind: 'cleaned' });
				}
			} finally {
				probe.release();
				delete observation.onOpen;
				await data.lease.close();
			}
		},
	);
});
