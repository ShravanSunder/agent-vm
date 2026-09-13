import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, open, readFile, rm, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ArtifactReference } from '@agent-vm/agent-portal-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import type {
	GatewayRuntimeArtifactReadCaller,
	GatewayRuntimeArtifactReader,
} from './artifact-store.js';
import type {
	WorkspaceArtifactFileStat,
	WorkspaceArtifactFilesystemPort,
	WorkspaceArtifactPublicationResult,
} from './workspace-artifact-publisher.js';
import { publishGatewayArtifactToWorkspace } from './workspace-artifact-publisher.js';

const caller = {
	principal: {
		agentId: 'sun',
		frameworkIdentity: { kind: 'hermes', profileName: 'sun' },
		profileAssignmentRevision: 'assignment-1',
		toolPortalProfileId: 'default',
	},
	surfaceClass: 'protected_uds',
} satisfies GatewayRuntimeArtifactReadCaller;

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map(async (root) => await rm(root, { force: true, recursive: true })),
	);
});

function createReader(bytes: Uint8Array): {
	readonly reader: GatewayRuntimeArtifactReader;
	readonly reference: ArtifactReference;
} {
	const reference = {
		byteLength: bytes.byteLength,
		expiresAt: '2099-01-01T00:00:00.000Z',
		fingerprint: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
		id: 'integration-artifact',
		mediaType: 'application/octet-stream',
	} satisfies ArtifactReference;
	return {
		reader: {
			read: async ({ request }) => {
				const chunk = bytes.subarray(request.offsetBytes, request.offsetBytes + request.maxBytes);
				return {
					contentBase64: Buffer.from(chunk).toString('base64'),
					offsetBytes: request.offsetBytes,
					reference,
					truncated: request.offsetBytes + chunk.byteLength < bytes.byteLength,
				};
			},
		},
		reference,
	};
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error;
}

async function createLocalFilesystemPort(root: string): Promise<WorkspaceArtifactFilesystemPort> {
	const resolveGuestPath = (guestPath: string): string =>
		path.join(root, guestPath.slice('/workspace'.length));
	return {
		stat: async ({ path: guestPath }): Promise<WorkspaceArtifactFileStat> => {
			try {
				const value = await lstat(resolveGuestPath(guestPath));
				return value.isSymbolicLink()
					? { kind: 'symbolic-link' }
					: value.isDirectory()
						? { kind: 'directory' }
						: value.isFile()
							? { byteLength: value.size, kind: 'file' }
							: { kind: 'other' };
			} catch (error) {
				if (isNodeError(error) && error.code === 'ENOENT') return { kind: 'missing' };
				throw error;
			}
		},
		mkdir: async ({ path: guestPath }) => {
			try {
				await mkdir(resolveGuestPath(guestPath), { mode: 0o700 });
				return { kind: 'created' } as const;
			} catch (error) {
				if (isNodeError(error) && error.code === 'EEXIST')
					return { kind: 'already-exists' } as const;
				throw error;
			}
		},
		readFile: async ({ path: guestPath }) => await readFile(resolveGuestPath(guestPath)),
		writeFileExclusive: async ({ bytes, path: guestPath }) => {
			try {
				const handle = await open(
					resolveGuestPath(guestPath),
					constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
					0o600,
				);
				try {
					await handle.writeFile(bytes);
				} finally {
					await handle.close();
				}
				return { kind: 'written' } as const;
			} catch (error) {
				if (isNodeError(error) && error.code === 'EEXIST')
					return { kind: 'failed', temporaryFileOwnership: 'unowned' } as const;
				return { kind: 'failed', temporaryFileOwnership: 'owned' } as const;
			}
		},
		renameNoReplace: async ({ fromPath, toPath }) => {
			try {
				await link(resolveGuestPath(fromPath), resolveGuestPath(toPath));
				await unlink(resolveGuestPath(fromPath));
				return { kind: 'renamed' } as const;
			} catch (error) {
				if (isNodeError(error) && error.code === 'EEXIST')
					return { kind: 'destination-exists' } as const;
				throw error;
			}
		},
		removeFile: async ({ path: guestPath }) => await unlink(resolveGuestPath(guestPath)),
	};
}

describe('workspace artifact publisher local filesystem integration', () => {
	it('publishes byte-exact content and atomically refuses replacement', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-workspace-publisher-'));
		temporaryRoots.push(root);
		const filesystem = await createLocalFilesystemPort(root);
		const bytes = Uint8Array.from({ length: 96 * 1_024 }, (_, index) => index % 256);
		const artifact = createReader(bytes);
		const publish = async (): Promise<WorkspaceArtifactPublicationResult> =>
			await publishGatewayArtifactToWorkspace({
				assertCurrentLeaseAndAuthority: async (): Promise<void> => {},
				caller,
				cleanupDeadlineMilliseconds: 1_000,
				fileName: 'binary.dat',
				filesystem,
				maximumBytes: 16 * 1_024 * 1_024,
				reader: artifact.reader,
				reference: artifact.reference,
				signal: new AbortController().signal,
			});

		const first = await publish();
		expect(
			Buffer.from(
				await filesystem.readFile({
					maximumBytes: bytes.byteLength,
					path: first.workspacePath,
					signal: new AbortController().signal,
				}),
			),
		).toEqual(Buffer.from(bytes));
		await expect(publish()).resolves.toEqual({
			kind: 'reused',
			workspacePath: first.workspacePath,
		});
		await expect(
			filesystem.renameNoReplace({
				fromPath: first.workspacePath,
				toPath: first.workspacePath,
				signal: new AbortController().signal,
			}),
		).resolves.toEqual({ kind: 'destination-exists' });
	});
});
