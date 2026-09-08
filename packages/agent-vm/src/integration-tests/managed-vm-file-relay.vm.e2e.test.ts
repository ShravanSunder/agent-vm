import { createHash } from 'node:crypto';

import type { ManagedVm } from '@agent-vm/managed-vm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createCredentialedOperationFolderSession } from '../controller/credentialed-runtime/credentialed-operation-folder-session.js';
import { createCredentialedOperationFolders } from '../controller/credentialed-runtime/credentialed-operation-folders.js';
import { inspectGogFileInputs } from '../controller/files/gog-file-input-preflight.js';
import { relayOperationFile } from '../controller/files/operation-file-relay.js';
import { createOperationFileRetentionBudget } from '../controller/files/operation-file-retention-budget.js';
import {
	createOperationFolderGuestAccess,
	loadOperationFolderGuestProgram,
} from '../controller/files/operation-folder-guest-access.js';
import { shouldRunLiveVmE2e } from './live-vm-e2e-gates.js';
import {
	createManagedFileRelayDestinationVm,
	expectedFileRelayDigest as expectedDigest,
	fileRelayBytePattern as bytePattern,
	fileRelayOperationDirectory as operationDirectory,
	fileRelayPythonExecutable as pythonExecutable,
	requireManagedFileTransfer as requireFileTransfer,
} from './managed-file-relay-test-fixture.js';
import {
	startManagedGatewayImageBootFixture,
	type ManagedGatewayImageBootFixture,
} from './managed-gateway-image-boot-test-fixture.js';

const describeLiveFileRelay = shouldRunLiveVmE2e() ? describe : describe.skip;

describeLiveFileRelay('real neutral ManagedVm rootfs file relay', () => {
	let sourceFixture: ManagedGatewayImageBootFixture;

	beforeAll(async () => {
		sourceFixture = await startManagedGatewayImageBootFixture({
			sessionLabel: 'managed-file-relay-source',
		});
		await requireFileTransfer(sourceFixture.vm).createDirectory({ guestPath: operationDirectory });
	});

	afterAll(async () => {
		await sourceFixture?.close();
	});

	async function createDestinationVm(): Promise<ManagedVm> {
		return await createManagedFileRelayDestinationVm(sourceFixture.preparedImage.imagePath);
	}
	it.each([false, true])(
		'stages the preflighted rootfs input bytes (changed after approval: %s)',
		async (changed) => {
			// Arrange: real source/destination VMs and production hash/staging helpers;
			// authorization decisions are substituted, not a provider/Portal smoke test.
			const source = sourceFixture.vm;
			const destination = await createDestinationVm();
			const signal = AbortSignal.timeout(60_000);
			const sourceName = `approval-input-${String(changed)}.bin`;
			try {
				const produced = await source.exec(
					[
						pythonExecutable,
						'-c',
						'import pathlib,sys; pathlib.Path(sys.argv[1]).write_bytes(bytes(range(256))*256)',
						`/work/${sourceName}`,
					],
					{ signal },
				);
				expect(produced.exitCode).toBe(0);
				const files = createOperationFolderGuestAccess({
					vm: source,
					root: '/work',
					program: await loadOperationFolderGuestProgram(),
					pythonExecutable,
					signal,
				});
				const snapshot = await inspectGogFileInputs({
					binding: { leaseId: 'proof-lease', leafGeneration: 'proof-leaf', vmId: source.id },
					paths: [`./${sourceName}`],
					files,
					signal,
				});
				const input = snapshot.files[0];
				if (input === undefined) throw new Error('Expected input identity.');
				const folder = await createCredentialedOperationFolderSession({
					vm: destination,
					folders: createCredentialedOperationFolders(
						createOperationFileRetentionBudget().forOwner({
							agentId: 'sun',
							zoneId: 'zone',
							ownerId: destination.id,
						}),
					),
					operationId: '11111111-1111-4111-8111-111111111111',
					workRoot: operationDirectory,
					maximumBytes: 65536,
					signal,
					now: Date.now,
					authorityIsCurrent: () => !signal.aborted,
				});
				if (changed) {
					const modified = await source.exec(
						[
							pythonExecutable,
							'-c',
							'import pathlib,sys; pathlib.Path(sys.argv[1]).write_bytes(bytes([9])*65536)',
							`/work/${sourceName}`,
						],
						{ signal },
					);
					expect(modified.exitCode).toBe(0);
				}
				// Act / Assert: changing even same-length bytes fails before any Gog call.
				const staged = folder.stageInput(input.relativePath, files.read(input.relativePath), input);
				if (changed) {
					await expect(staged).rejects.toThrow('integrity-mismatch');
				} else {
					await staged;
					const opened = await destination.exec(
						[
							pythonExecutable,
							'-c',
							'import hashlib,sys; print(hashlib.file_digest(open(sys.argv[1],"rb"),"sha256").hexdigest())',
							`${folder.root}/${sourceName}`,
						],
						{ signal },
					);
					expect(opened.exitCode).toBe(0);
					expect(opened.stdout.trim()).toBe(input.sha256);
				}
			} finally {
				await destination.close();
			}
		},
	);

	it.each([0, 16 * 1024 * 1024])(
		'relays %i binary bytes with incremental hashes and no final capture',
		async (size) => {
			// Arrange: files live on guest COW rootfs, with no host file mount/staging.
			const source = sourceFixture.vm;
			const destination = await createDestinationVm();
			const signal = AbortSignal.timeout(60_000);
			const sourcePath = `${operationDirectory}/source-${String(size)}.bin`;
			const destinationPath = `${operationDirectory}/delivered.bin`;
			const releaseConsumer = Promise.withResolvers<void>();
			try {
				const generated = await source.exec(
					[
						pythonExecutable,
						'-c',
						[
							'import sys',
							'with open(sys.argv[1], "wb") as output:',
							'    for _ in range(int(sys.argv[2]) // 65536):',
							'        output.write(bytes(range(256)) * 256)',
						].join('\n'),
						sourcePath,
						String(size),
					],
					{ signal },
				);
				expect(generated.exitCode).toBe(0);

				// Act: source exec pipe -> demand-driven host iterator -> destination vm.fs.
				const sourceProcess = source.exec(['/bin/cat', sourcePath], {
					output: { stderr: { kind: 'pipe' }, stdout: { kind: 'pipe' } },
					pty: false,
					signal,
				});
				const consumerPaused = Promise.withResolvers<void>();
				let byteCount = 0;
				let sourceFinished = false;
				const sourceHash = createHash('sha256');
				const completion = sourceProcess.result.then((result) => {
					sourceFinished = true;
					return result;
				});
				async function* sourceBytes(): AsyncIterable<Uint8Array> {
					for await (const chunk of sourceProcess.output()) {
						if (chunk.stream === 'stderr') {
							throw new Error('File reader reported an unexpected diagnostic.');
						}
						byteCount += chunk.data.byteLength;
						if (byteCount > size) {
							throw new Error('Source exceeded its expected byte length.');
						}
						sourceHash.update(chunk.data);
						yield chunk.data;
						consumerPaused.resolve();
						await releaseConsumer.promise;
					}
				}
				const transfer = Promise.all([
					completion,
					requireFileTransfer(destination).writeFileStream({
						contents: sourceBytes(),
						guestPath: destinationPath,
						signal,
					}),
				]);
				if (size > 0) {
					await Promise.race([consumerPaused.promise, transfer]);
					// A separate completed guest command supplies an event barrier, not a sleep.
					const barrier = await source.exec(['/bin/echo', 'consumer-paused'], { signal });
					expect(barrier.exitCode).toBe(0);
					expect(sourceFinished).toBe(false);
					expect(byteCount).toBeLessThanOrEqual(256 * 1024);
				}
				releaseConsumer.resolve();
				const [result] = await transfer;

				// Assert: only fixed-sized metadata crosses the buffered verification command.
				expect(result.exitCode).toBe(0);
				expect(result.stdoutBuffer.byteLength).toBe(0);
				expect(result.stderrBuffer.byteLength).toBe(0);
				expect(byteCount).toBe(size);
				expect(sourceHash.digest('hex')).toBe(expectedDigest(size));
				const verification = await destination.exec(
					[
						pythonExecutable,
						'-c',
						'import hashlib,json,os,sys; f=open(sys.argv[1],"rb"); print(json.dumps({"size":os.fstat(f.fileno()).st_size,"sha256":hashlib.file_digest(f,"sha256").hexdigest()}))',
						destinationPath,
					],
					{ signal },
				);
				expect(verification.exitCode).toBe(0);
				expect(verification.json()).toEqual({ sha256: expectedDigest(size), size });
			} finally {
				releaseConsumer.resolve();
				await destination.close();
				expect(destination.getHostProcessId()).toBeNull();
			}
		},
	);

	it.each(['input-error', 'abort', 'destination-error'] as const)(
		'preserves caught %s and reuses the VM after fixed application cleanup',
		async (scenario) => {
			// Arrange: qualify the selected write -> cleanup -> reuse sequence. Raw
			// SDK write -> write after an open failure is not safe on Gondolin 0.12.0;
			// see the file-write-reuse investigation, not a broader SDK recovery claim.
			const destination = await createDestinationVm();
			const abortController = new AbortController();
			const signal = AbortSignal.any([abortController.signal, AbortSignal.timeout(30_000)]);
			const destinationPath =
				scenario === 'destination-error'
					? `${operationDirectory}/missing-parent/input.part`
					: `${operationDirectory}/input.part`;
			async function* inputBytes(): AsyncIterable<Uint8Array> {
				yield bytePattern;
				if (scenario === 'input-error') {
					throw new Error('intentional source failure');
				}
				if (scenario === 'abort') {
					abortController.abort();
				}
				yield bytePattern;
			}
			try {
				// Act / Assert: the public operation rejects; unhandled rejections fail Vitest.
				await expect(
					requireFileTransfer(destination).writeFileStream({
						contents: inputBytes(),
						guestPath: destinationPath,
						signal,
					}),
				).rejects.toThrow();
				const recoverySignal = AbortSignal.timeout(30_000);
				const cleanup = createOperationFolderGuestAccess({
					vm: destination,
					root: operationDirectory,
					program: await loadOperationFolderGuestProgram(),
					pythonExecutable,
					signal: recoverySignal,
				});
				// Same fixed exec helper used by relayOperationFile. A missing partial
				// file reports unavailable; do not claim cleanup success in that case.
				const removed = cleanup.removeOwned(
					scenario === 'destination-error' ? 'missing-parent/input.part' : 'input.part',
				);
				if (scenario === 'destination-error') {
					await expect(removed).rejects.toThrow('unavailable');
				} else {
					await removed;
				}
				await requireFileTransfer(destination).writeFileStream({
					guestPath: `${operationDirectory}/after-failure.bin`,
					contents: (async function* () {
						yield new Uint8Array([0, 255, 128, 1]);
					})(),
					signal: recoverySignal,
				});
				const recovered = await destination.exec(
					[
						pythonExecutable,
						'-c',
						'import pathlib,sys; print(pathlib.Path(sys.argv[1]).read_bytes().hex())',
						`${operationDirectory}/after-failure.bin`,
					],
					{ signal: recoverySignal },
				);
				expect(recovered.exitCode).toBe(0);
				expect(recovered.stdout.trim()).toBe('00ff8001');
			} finally {
				await destination.close();
				expect(destination.getHostProcessId()).toBeNull();
			}
		},
	);

	it('recovers on the same VM after application cleanup of a destination-open failure', async () => {
		// Arrange: real rootfs VMs and the production relay; only the first writer's
		// target is fault-injected. Do not substitute cleanup with a test-only barrier.
		const source = sourceFixture.vm;
		const destination = await createDestinationVm();
		const signal = AbortSignal.timeout(60_000);
		const program = await loadOperationFolderGuestProgram();
		const sourceFiles = createOperationFolderGuestAccess({
			vm: source,
			root: operationDirectory,
			program,
			pythonExecutable,
			signal,
		});
		const destinationFiles = createOperationFolderGuestAccess({
			vm: destination,
			root: operationDirectory,
			program,
			pythonExecutable,
			signal,
		});
		const removeOwned = vi.fn(async (path: string): Promise<void> => {
			await destinationFiles.removeOwned(path);
		});
		const writer = requireFileTransfer(destination);
		try {
			await requireFileTransfer(source).writeFileStream({
				guestPath: `${operationDirectory}/recovery-source.bin`,
				contents: (async function* () {
					yield bytePattern;
				})(),
				signal,
			});
			const relay = {
				source: sourceFiles,
				sourceRelativePath: 'recovery-source.bin',
				destination: { ...destinationFiles, removeOwned },
				destinationRoot: operationDirectory,
				finalName: 'complete.bin',
				expectedIdentity: {
					byteLength: bytePattern.byteLength,
					sha256: expectedDigest(bytePattern.byteLength),
				},
				signal,
				authorityIsCurrent: () => true,
			};
			// Act: fail the guest open, await the relay's own cleanup, then reuse.
			const failed = await relayOperationFile({
				...relay,
				destinationDirectory: 'failed-open',
				destinationWriter: {
					writeFileStream: (request) =>
						writer.writeFileStream({
							...request,
							guestPath: `${request.guestPath}/missing-child`,
						}),
				},
			});
			expect(failed).toEqual({
				kind: 'failed',
				reason: 'transfer-failed',
				cleanup: 'pending',
			});
			expect(removeOwned).toHaveBeenCalledExactlyOnceWith('failed-open/incoming.part');
			const recovered = await relayOperationFile({
				...relay,
				destinationDirectory: 'after-open-failure',
				destinationWriter: writer,
			});
			// Assert: the same live destination publishes verified bytes, no restart.
			expect(recovered).toMatchObject({ kind: 'published', cleanup: 'complete' });
			const digest = createHash('sha256');
			for await (const chunk of destinationFiles.read('after-open-failure/complete.bin')) {
				digest.update(chunk);
			}
			expect(digest.digest('hex')).toBe(expectedDigest(bytePattern.byteLength));
		} finally {
			await destination.close();
			expect(destination.getHostProcessId()).toBeNull();
		}
	});

	it('uses the application folder reader and verified no-replace publication across real rootfs VMs', async () => {
		// Arrange
		const source = sourceFixture.vm;
		const destination = await createDestinationVm();
		const signal = AbortSignal.timeout(60_000);
		const program = await loadOperationFolderGuestProgram();
		const sourceFiles = createOperationFolderGuestAccess({
			vm: source,
			root: operationDirectory,
			program,
			pythonExecutable,
			signal,
		});
		const destinationFiles = createOperationFolderGuestAccess({
			vm: destination,
			root: operationDirectory,
			program,
			pythonExecutable,
			signal,
		});
		const payload = bytePattern;
		const digest = expectedDigest(payload.byteLength);
		try {
			await requireFileTransfer(source).writeFileStream({
				guestPath: `${operationDirectory}/guarded.bin`,
				contents: (async function* () {
					yield payload;
				})(),
				signal,
			});
			// Act
			const published = await relayOperationFile({
				source: sourceFiles,
				sourceRelativePath: 'guarded.bin',
				destination: destinationFiles,
				destinationWriter: requireFileTransfer(destination),
				destinationRoot: operationDirectory,
				destinationDirectory: 'delivered',
				finalName: 'complete.bin',
				expectedIdentity: { byteLength: payload.byteLength, sha256: digest },
				signal,
				authorityIsCurrent: () => true,
			});
			const receivedDigest = createHash('sha256');
			for await (const bytes of destinationFiles.read('delivered/complete.bin'))
				receivedDigest.update(bytes);
			// Assert
			expect(published).toMatchObject({
				kind: 'published',
				cleanup: 'complete',
				path: `${operationDirectory}/delivered/complete.bin`,
			});
			expect(receivedDigest.digest('hex')).toBe(digest);
			expect(await destinationFiles.list('delivered')).toMatchObject({
				limitReached: false,
				entries: [{ kind: 'file', name: 'complete.bin', byteLength: payload.byteLength }],
			});
			expect(await destinationFiles.inventory()).toEqual({
				byteLength: payload.byteLength,
				entryCount: 2,
			});
		} finally {
			await destination.close();
			expect(destination.getHostProcessId()).toBeNull();
		}
	});
});
