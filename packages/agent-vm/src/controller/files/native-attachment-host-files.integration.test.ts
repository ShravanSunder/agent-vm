import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
	cleanupNativeAttachmentCacheAfterContainment,
	createNativeAttachmentHostFiles,
} from './native-attachment-host-files.js';
import { createNativeAttachmentStaging } from './native-attachment-staging.js';
import { createOperationFileRetentionBudget } from './operation-file-retention-budget.js';

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
	);
});

describe('native attachments through the existing host-backed cache', () => {
	it.each(['sent', 'failed', 'unconfirmed'] as const)(
		'cleans the selected cache copy after settled %s',
		async (outcome) => {
			// Arrange
			const cacheDirectory = await mkdtemp(path.join(os.tmpdir(), 'native-cache-cleanup-'));
			roots.push(cacheDirectory);
			await writeFile(path.join(cacheDirectory, 'sentinel'), 'keep');
			const signal = new AbortController().signal;
			const host = await createNativeAttachmentHostFiles({
				cacheDirectory,
				controllerEpoch: 'run',
				gatewayVmId: 'gateway',
				signal,
			});
			const staging = createNativeAttachmentStaging({
				retentionBudget: createOperationFileRetentionBudget(),
			});
			const owner = {
				zoneId: 'zone',
				agentId: 'sun',
				profileName: 'sun',
				gatewayVmId: 'gateway',
				stablePrincipal: 'a'.repeat(64),
				sessionId: 'session',
			};
			const request = {
				owner,
				source: {
					read: async function* () {
						yield Buffer.from([0, 255, 128]);
					},
				},
				sourceRelativePath: 'report.bin',
				destination: host.destination,
				destinationWriter: host.writer,
				destinationRoot: host.guestRoot,
				sourceAuthorityIsCurrent: () => true,
				destinationAuthorityIsCurrent: () => true,
				signal,
			};
			// Act
			const staged = await staging.stage(request);
			if (staged.kind !== 'staged') throw new Error(`Expected staged file, got ${staged.kind}.`);
			const hostFile = path.join(cacheDirectory, staged.path.slice('/home/hermes/.cache/'.length));
			expect(await readFile(hostFile)).toEqual(Buffer.from([0, 255, 128]));
			expect(await staging.settle({ owner, stagingId: staged.stagingId, outcome })).toEqual({
				kind: 'cleaned',
			});
			// Assert
			await expect(readFile(hostFile)).rejects.toMatchObject({ code: 'ENOENT' });
			expect(await readFile(path.join(cacheDirectory, 'sentinel'), 'utf8')).toBe('keep');
		},
	);

	it('recovery deletes pending-send leftovers only inside the owned generation subtree', async () => {
		// Arrange
		const cacheDirectory = await mkdtemp(path.join(os.tmpdir(), 'native-cache-recovery-'));
		roots.push(cacheDirectory);
		await writeFile(path.join(cacheDirectory, 'sentinel'), 'keep');
		const signal = new AbortController().signal;
		const host = await createNativeAttachmentHostFiles({
			cacheDirectory,
			controllerEpoch: 'old-run',
			gatewayVmId: 'old-gateway',
			signal,
		});
		await host.destination.createDirectory('send');
		await host.writer.writeFileStream({
			guestPath: `${host.guestRoot}/send/file`,
			contents: (async function* () {
				yield Buffer.from('bytes');
			})(),
			signal,
		});
		const hostFile = path.join(
			cacheDirectory,
			host.guestRoot.slice('/home/hermes/.cache/'.length),
			'send',
			'file',
		);
		// Act: caller has already completed recorded Gateway containment.
		await cleanupNativeAttachmentCacheAfterContainment(cacheDirectory);
		// Assert
		await expect(readFile(hostFile)).rejects.toMatchObject({ code: 'ENOENT' });
		expect(await readFile(path.join(cacheDirectory, 'sentinel'), 'utf8')).toBe('keep');
		await cleanupNativeAttachmentCacheAfterContainment(cacheDirectory);
	});
});
