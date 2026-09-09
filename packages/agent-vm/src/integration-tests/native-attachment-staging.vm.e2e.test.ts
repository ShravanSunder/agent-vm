import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createNativeAttachmentHostFiles } from '../controller/files/native-attachment-host-files.js';
import { createNativeAttachmentStaging } from '../controller/files/native-attachment-staging.js';
import { createOperationFileRetentionBudget } from '../controller/files/operation-file-retention-budget.js';
import {
	createOperationFolderGuestAccess,
	loadOperationFolderGuestProgram,
} from '../controller/files/operation-folder-guest-access.js';
import { shouldRunLiveVmE2e } from './live-vm-e2e-gates.js';
import {
	createManagedFileRelayDestinationVm,
	expectedFileRelayDigest,
	fileRelayBytePattern,
	fileRelayPythonExecutable,
} from './managed-file-relay-test-fixture.js';
import {
	startManagedGatewayImageBootFixture,
	type ManagedGatewayImageBootFixture,
} from './managed-gateway-image-boot-test-fixture.js';

const describeLiveNativeStaging = shouldRunLiveVmE2e() ? describe : describe.skip;

describeLiveNativeStaging(
	'native attachment controller staging through the real Gateway cache mount',
	() => {
		let sourceFixture: ManagedGatewayImageBootFixture;
		beforeAll(async () => {
			sourceFixture = await startManagedGatewayImageBootFixture({
				sessionLabel: 'native-stage-source',
			});
			const generated = await sourceFixture.vm.exec([
				fileRelayPythonExecutable,
				'-c',
				'import pathlib; pathlib.Path("/work/native-source.bin").write_bytes(bytes(range(256))*256)',
			]);
			expect(generated.exitCode).toBe(0);
		});
		afterAll(async () => {
			await sourceFixture?.close();
		});

		it.each([false, true])(
			'stages and cleans after source scope ends (prior destination failure: %s)',
			async (failFirst) => {
				// Arrange: real controller relay/helper/VM byte path; authority checks are
				// substituted. This is not plugin, Google, Clerk, or recipient qualification.
				const cacheDirectory = path.join(
					sourceFixture.project.tempRoot,
					`native-cache-${String(failFirst)}`,
				);
				await mkdir(cacheDirectory);
				const destination = await createManagedFileRelayDestinationVm(
					sourceFixture.preparedImage.imagePath,
					cacheDirectory,
				);
				const sourceScope = new AbortController();
				const deadline = AbortSignal.timeout(60_000);
				const sourceSignal = AbortSignal.any([sourceScope.signal, deadline]);
				const program = await loadOperationFolderGuestProgram();
				const source = createOperationFolderGuestAccess({
					vm: sourceFixture.vm,
					root: '/work',
					program,
					pythonExecutable: fileRelayPythonExecutable,
					signal: sourceSignal,
				});
				const host = await createNativeAttachmentHostFiles({
					cacheDirectory,
					controllerEpoch: 'native-stage-proof',
					gatewayVmId: destination.id,
					signal: deadline,
				});
				const destinationFiles = createOperationFolderGuestAccess({
					vm: destination,
					root: host.guestRoot,
					program,
					pythonExecutable: fileRelayPythonExecutable,
					signal: deadline,
				});
				const writer = host.writer;
				const staging = createNativeAttachmentStaging({
					retentionBudget: createOperationFileRetentionBudget(),
				});
				const owner = {
					agentId: 'sun',
					zoneId: 'zone',
					gatewayVmId: destination.id,
					stablePrincipal: 'principal',
					profileName: 'sun',
					sessionId: 'session',
				};
				const request = {
					destinationRoot: host.guestRoot,
					owner,
					source,
					sourceRelativePath: './native-source.bin',
					destination: host.destination,
					destinationWriter: writer,
					sourceAuthorityIsCurrent: () => !sourceScope.signal.aborted,
					destinationAuthorityIsCurrent: () => true,
					signal: sourceSignal,
				};
				try {
					if (failFirst) {
						const failure = await staging.stage({
							...request,
							destinationWriter: {
								writeFileStream: (write) =>
									writer.writeFileStream({
										...write,
										guestPath: `${write.guestPath}/missing-parent`,
									}),
							},
						});
						expect(failure).toEqual({ kind: 'failed', reason: 'transfer-failed' });
					}
					// Act: stage on this same VM, then end the unrelated source read scope.
					const staged = await staging.stage(request);
					expect(staged).toMatchObject({
						kind: 'staged',
						byteLength: fileRelayBytePattern.byteLength,
						sha256: expectedFileRelayDigest(fileRelayBytePattern.byteLength),
					});
					if (staged.kind !== 'staged') throw new Error('Expected complete native staging.');
					const relativePath = staged.path.slice(host.guestRoot.length + 1);
					const digest = createHash('sha256');
					for await (const chunk of destinationFiles.read(relativePath)) digest.update(chunk);
					expect(digest.digest('hex')).toBe(staged.sha256);
					sourceScope.abort();
					expect(
						await staging.settle({ owner, stagingId: staged.stagingId, outcome: 'sender-pending' }),
					).toEqual({ kind: 'retained' });
					expect(
						await staging.settle({ owner, stagingId: staged.stagingId, outcome: 'sent' }),
					).toEqual({ kind: 'cleaned' });
					// Assert: the native copy is removed; the source's VM-local file remains.
					await expect(destinationFiles.list(relativePath.split('/')[0] ?? '')).rejects.toThrow(
						'unavailable',
					);
					const sourceStillExists = await sourceFixture.vm.exec([
						'/usr/bin/test',
						'-f',
						'/work/native-source.bin',
					]);
					expect(sourceStillExists.exitCode).toBe(0);
				} finally {
					await destination.close();
					expect(destination.getHostProcessId()).toBeNull();
				}
			},
		);
	},
);
