import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ManagedVm } from '@agent-vm/managed-vm';
import { describe, expect, it } from 'vitest';

import { createManagedVmRuntimeComposition } from '../composition/gondolin-managed-vm-provider.js';
import { createOperationFileRetentionBudget } from '../controller/files/operation-file-retention-budget.js';
import { createSharedStagingDirectoryStore } from '../controller/files/shared-staging-directory-store.js';
import { createManagedVmWithFilteredAgentWorkspace } from '../tool-vm/managed-agent-tool-vm-mounts.js';
import { shouldRunLiveVmE2e } from './live-vm-e2e-gates.js';
import { fileRelayPythonExecutable as pythonExecutable } from './managed-file-relay-test-fixture.js';
import { startManagedGatewayImageBootFixture } from './managed-gateway-image-boot-test-fixture.js';

const describeRealStaging = shouldRunLiveVmE2e() ? describe : describe.skip;

describeRealStaging('RealFS shared staging with real producer and Tool VMs', () => {
	it.each(['expiry', 'receiver-closure'] as const)(
		'publishes byte-exact read-only files, survives producer closure, and cleans on %s',
		async (cleanupTrigger) => {
			// Arrange: real provider/mounts/store; Google and call authorization are deliberately not exercised.
			const fixture = await startManagedGatewayImageBootFixture({
				sessionLabel: 'shared-staging-image',
			});
			let source: ManagedVm | undefined;
			let destination: ManagedVm | undefined;
			try {
				const composition = createManagedVmRuntimeComposition();
				let nowMs = 1000;
				const store = await createSharedStagingDirectoryStore({
					root: path.join(fixture.project.tempRoot, 'shared-staging'),
					now: () => nowMs,
					retention: createOperationFileRetentionBudget().forOwner({
						agentId: 'sun',
						zoneId: 'zone',
						ownerId: 'run',
					}),
				});
				const producerRoot = await store.prepareProducerRoot('producer');
				await store.prepareOperation({
					producerId: 'producer',
					operationId: 'operation',
					maximumBytes: 16 * 1024 * 1024,
				});
				const receiverRoot = await store.prepareReceiverRoot('leaf');
				const workspaceRoot = path.join(fixture.project.tempRoot, 'agent-workspace');
				await mkdir(workspaceRoot);
				await writeFile(path.join(workspaceRoot, 'sentinel'), 'keep');
				const request = {
					allowedHosts: [],
					environment: {},
					imageReference: fixture.preparedImage.imagePath,
					mediatedSecrets: [],
					resources: { cpuCount: 1, memory: '512M' },
					rootfsMode: 'cow' as const,
					sessionLabel: 'shared-staging-proof',
					tcpHosts: [],
				};
				source = await composition.managedVmFactory.createManagedVm({
					...request,
					mounts: {
						'/agent-vm/gog-work': {
							kind: 'owned-host-directory',
							access: 'read-write',
							directory: composition.managedVmOwnedDirectories.openHostDirectory(producerRoot),
						},
					},
				});
				destination = await createManagedVmWithFilteredAgentWorkspace({
					factory: composition.managedVmFactory,
					ownedDirectories: composition.managedVmOwnedDirectories,
					hostWorkspaceRoot: workspaceRoot,
					hostPublishedFilesRoot: receiverRoot,
					request,
					workspacePolicy: {
						hiddenPaths: [],
						readonlyInputs: [],
						temporaryPaths: [],
						visibility: { kind: 'whole-root-writable' },
					},
				});
				await source.start();
				await destination.start();
				const signal = AbortSignal.timeout(60_000);
				const produced = await source.exec(
					[
						pythonExecutable,
						'-c',
						'import pathlib; pathlib.Path("/agent-vm/gog-work/operation/report.bin").write_bytes(bytes(range(256))*16384)',
					],
					{ signal },
				);
				expect(produced.exitCode).toBe(0);
				// Act: production host publication, then a normal guest tool opens the returned path.
				const receiver = { leaseId: 'lease', leafGeneration: 'leaf', vmId: destination.id };
				await expect(
					store.publish({
						producerId: 'producer',
						operationId: 'operation',
						receiver,
						relativePaths: ['report.bin'],
						withPublicationAuthority: async () => {
							throw new Error('authorization changed before publication');
						},
						signal,
					}),
				).rejects.toThrow('authorization changed before publication');
				expect(await readdir(receiverRoot)).toEqual([]);
				const publication = await store.publish({
					producerId: 'producer',
					operationId: 'operation',
					receiver,
					relativePaths: ['report.bin'],
					withPublicationAuthority: async (expose) => await expose(),
					signal,
				});
				const file = publication.files[0];
				if (file === undefined) throw new Error('Expected publication.');
				await source.close();
				source = undefined;
				await store.retireProducer('producer');
				const opened = await destination.exec(
					[
						pythonExecutable,
						'-c',
						'import hashlib,sys; print(hashlib.file_digest(open(sys.argv[1],"rb"),"sha256").hexdigest())',
						file.path,
					],
					{ signal },
				);
				// Assert
				expect(opened.exitCode).toBe(0);
				expect(opened.stdout.trim()).toBe(file.sha256);
				const mutation = await destination.exec(
					[
						pythonExecutable,
						'-c',
						'import errno,sys\ntry:\n open(sys.argv[1],"wb")\nexcept OSError as error:\n assert error.errno in (errno.EROFS,errno.EACCES)\nelse:\n raise AssertionError("staging was writable")',
						file.path,
					],
					{ signal },
				);
				expect(mutation.exitCode).toBe(0);
				if (cleanupTrigger === 'receiver-closure') {
					await destination.close();
					destination = undefined;
					expect(await store.retireReceiver(receiver)).toEqual({ removed: 1, pending: 0 });
				} else {
					nowMs = publication.expiresAtMs;
					expect(await store.reapExpired()).toEqual({ removed: 1, pending: 0 });
					const expired = await destination.exec(
						[
							pythonExecutable,
							'-c',
							'import sys\ntry:\n open(sys.argv[1],"rb")\nexcept FileNotFoundError:\n pass\nelse:\n raise AssertionError("expired file still opens")',
							file.path,
						],
						{ signal },
					);
					expect(expired.exitCode).toBe(0);
				}
				expect(await readdir(receiverRoot)).toEqual([]);
				expect(await readFile(path.join(workspaceRoot, 'sentinel'), 'utf8')).toBe('keep');
			} finally {
				await Promise.all([source?.close(), destination?.close()]);
				await fixture.close();
			}
		},
	);
});
