import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

interface RuntimeFileArtifactStorageWriter {
	readonly commit: () => Promise<void>;
	readonly discard: () => Promise<void>;
	readonly write: (chunk: Uint8Array, signal?: AbortSignal) => Promise<void>;
}

interface RuntimeFileArtifactStorageBackend {
	readonly createWriter: (artifactId: string) => Promise<RuntimeFileArtifactStorageWriter>;
	readonly readRange: (props: {
		readonly artifactId: string;
		readonly maxBytes: number;
		readonly offsetBytes: number;
	}) => Promise<Uint8Array>;
	readonly remove: (artifactId: string) => Promise<void>;
}

interface RuntimeFileArtifactStorageModule {
	readonly createGatewayRuntimeFileArtifactStorageBackend: (props: {
		readonly artifactsDirectoryPath: string;
	}) => RuntimeFileArtifactStorageBackend | Promise<RuntimeFileArtifactStorageBackend>;
}

const gatewayRuntimePackageModuleSpecifier = '../index.js';
const temporarySandboxRoots: string[] = [];

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function loadRuntimeFileArtifactStorageModule(): Promise<RuntimeFileArtifactStorageModule> {
	const moduleExports: unknown = await import(gatewayRuntimePackageModuleSpecifier);
	if (
		!isRecord(moduleExports) ||
		typeof moduleExports.createGatewayRuntimeFileArtifactStorageBackend !== 'function'
	) {
		throw new Error(
			'Gateway runtime package does not export the async runtime-file artifact storage backend.',
		);
	}
	return moduleExports as unknown as RuntimeFileArtifactStorageModule;
}

async function createArtifactsDirectoryPath(label: string): Promise<string> {
	const sandboxRoot = await mkdtemp(path.join(os.tmpdir(), `agent-vm-${label}-`));
	temporarySandboxRoots.push(sandboxRoot);
	return path.join(sandboxRoot, 'gateway-runtime', 'artifacts');
}

async function createBackend(
	artifactsDirectoryPath: string,
): Promise<RuntimeFileArtifactStorageBackend> {
	const module = await loadRuntimeFileArtifactStorageModule();
	return await module.createGatewayRuntimeFileArtifactStorageBackend({ artifactsDirectoryPath });
}

function errorPublicText(error: unknown, visited: Set<unknown> = new Set<unknown>()): string {
	if (error === null || error === undefined) return String(error);
	if (
		typeof error === 'boolean' ||
		typeof error === 'bigint' ||
		typeof error === 'number' ||
		typeof error === 'string'
	) {
		return String(error);
	}
	if (typeof error === 'symbol') return error.description ?? '';
	if (typeof error === 'function') return error.name;
	if (visited.has(error)) return '';
	visited.add(error);
	const errorRecord = error as Readonly<Record<string, unknown>>;
	const ownText = [errorRecord.name, errorRecord.message, errorRecord.code]
		.filter((value): value is string => typeof value === 'string')
		.join(' ');
	const causeText = errorPublicText(errorRecord.cause, visited);
	const aggregateText = Array.isArray(errorRecord.errors)
		? errorRecord.errors.map((entry) => errorPublicText(entry, visited)).join(' ')
		: '';
	return `${ownText} ${causeText} ${aggregateText}`.trim();
}

function expectNoPrivatePathLeak(error: unknown, privatePath: string): void {
	const publicText = errorPublicText(error);
	expect(publicText).not.toContain(privatePath);
}

async function expectRejectedOperation(operation: Promise<unknown>): Promise<unknown> {
	try {
		await operation;
	} catch (error: unknown) {
		return error;
	}
	throw new Error('Expected runtime-file artifact storage operation to reject.');
}

afterEach(async (): Promise<void> => {
	vi.doUnmock('node:fs/promises');
	vi.resetModules();
	await Promise.all(
		temporarySandboxRoots
			.splice(0)
			.map((sandboxRoot) => rm(sandboxRoot, { force: true, recursive: true })),
	);
});

describe('Gateway runtime file artifact storage backend', () => {
	it('commits staged bytes, returns exact bounded ranges, and retires the committed file', async () => {
		// Arrange
		const artifactsDirectoryPath = await createArtifactsDirectoryPath('artifact-storage-commit');
		const backend = await createBackend(artifactsDirectoryPath);
		const writer = await backend.createWriter('artifact-commit-1');
		const firstChunk = Buffer.from('0123', 'utf8');
		const secondChunk = Buffer.from('456789', 'utf8');

		// Act
		await writer.write(firstChunk);
		await writer.write(secondChunk);
		const commitResult = await writer.commit();
		const middleRange = await backend.readRange({
			artifactId: 'artifact-commit-1',
			maxBytes: 4,
			offsetBytes: 2,
		});
		await backend.remove('artifact-commit-1');
		const missingReadError = await expectRejectedOperation(
			backend.readRange({
				artifactId: 'artifact-commit-1',
				maxBytes: 1,
				offsetBytes: 0,
			}),
		);

		// Assert
		expect(commitResult).toBeUndefined();
		expect(Buffer.from(middleRange).toString('utf8')).toBe('2345');
		expect(await readdir(artifactsDirectoryPath)).toEqual([]);
		expectNoPrivatePathLeak(missingReadError, artifactsDirectoryPath);
	});

	it('discards a partial write and rejects traversal-shaped artifact identifiers without escape', async () => {
		// Arrange
		const artifactsDirectoryPath = await createArtifactsDirectoryPath('artifact-storage-cancel');
		const sandboxRoot = path.dirname(path.dirname(artifactsDirectoryPath));
		const outsidePath = path.join(sandboxRoot, 'outside-artifact');
		const backend = await createBackend(artifactsDirectoryPath);
		const writer = await backend.createWriter('artifact-cancel-1');
		await writer.write(Buffer.from('partial bytes', 'utf8'));

		// Act
		await writer.discard();
		const cancelledReadError = await expectRejectedOperation(
			backend.readRange({
				artifactId: 'artifact-cancel-1',
				maxBytes: 32,
				offsetBytes: 0,
			}),
		);
		const traversalError = await expectRejectedOperation(
			backend.createWriter('../../outside-artifact'),
		);

		// Assert
		expect(await readdir(artifactsDirectoryPath)).toEqual([]);
		await expect(stat(outsidePath)).rejects.toMatchObject({ code: 'ENOENT' });
		expectNoPrivatePathLeak(cancelledReadError, artifactsDirectoryPath);
		expectNoPrivatePathLeak(traversalError, artifactsDirectoryPath);
	});

	it('cleans a staged file after an injected disk-full commit failure without leaking its path', async () => {
		// Arrange
		const artifactsDirectoryPath = await createArtifactsDirectoryPath('artifact-storage-disk-full');
		const injectedSecret = 'artifact-storage-disk-full-credential';
		const actualFileSystem =
			await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
		vi.resetModules();
		vi.doMock('node:fs/promises', async () => ({
			...actualFileSystem,
			rename: async (sourcePath: string, destinationPath: string): Promise<void> => {
				if (path.dirname(destinationPath) === artifactsDirectoryPath) {
					throw Object.assign(
						new Error(`ENOSPC while committing ${destinationPath} with ${injectedSecret}`),
						{ code: 'ENOSPC' },
					);
				}
				await actualFileSystem.rename(sourcePath, destinationPath);
			},
		}));
		const backend = await createBackend(artifactsDirectoryPath);
		const writer = await backend.createWriter('artifact-disk-full-1');
		await writer.write(Buffer.from('bytes staged before commit failure', 'utf8'));

		// Act
		const commitError = await expectRejectedOperation(writer.commit());

		// Assert
		expect(await readdir(artifactsDirectoryPath)).toEqual([]);
		expectNoPrivatePathLeak(commitError, artifactsDirectoryPath);
		expect(errorPublicText(commitError)).not.toContain(injectedSecret);
	});

	it.each([{ failurePoint: 'write' }, { failurePoint: 'commit' }] as const)(
		'keeps failed $failurePoint cleanup observable to the store through discard',
		async ({ failurePoint }): Promise<void> => {
			// Arrange
			const artifactsDirectoryPath = await createArtifactsDirectoryPath(
				`artifact-storage-${failurePoint}-cleanup-failure`,
			);
			const injectedSecret = `artifact-storage-${failurePoint}-cleanup-credential`;
			const actualFileSystem =
				await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
			vi.resetModules();
			vi.doMock('node:fs/promises', async () => ({
				...actualFileSystem,
				rename: async (sourcePath: string, destinationPath: string): Promise<void> => {
					if (
						failurePoint === 'commit' &&
						path.dirname(destinationPath) === artifactsDirectoryPath
					) {
						throw Object.assign(
							new Error(`ENOSPC while committing ${destinationPath} with ${injectedSecret}`),
							{ code: 'ENOSPC' },
						);
					}
					await actualFileSystem.rename(sourcePath, destinationPath);
				},
				rm: async (
					filePath: string,
					options?: {
						readonly force?: boolean;
						readonly maxRetries?: number;
						readonly recursive?: boolean;
						readonly retryDelay?: number;
					},
				): Promise<void> => {
					if (
						path.dirname(filePath) === artifactsDirectoryPath &&
						path.basename(filePath).startsWith('.staged-')
					) {
						throw Object.assign(
							new Error(`EACCES while removing ${filePath} with ${injectedSecret}`),
							{ code: 'EACCES' },
						);
					}
					await actualFileSystem.rm(filePath, options);
				},
			}));
			const backend = await createBackend(artifactsDirectoryPath);
			const writer = await backend.createWriter(`artifact-${failurePoint}-cleanup-failure`);
			await writer.write(Buffer.from('persisted bytes before cleanup failure', 'utf8'));
			const cancellation = new AbortController();
			cancellation.abort();

			// Act
			const operationError = await expectRejectedOperation(
				failurePoint === 'write'
					? writer.write(Buffer.from('partially persisted bytes', 'utf8'), cancellation.signal)
					: writer.commit(),
			);
			const cleanupError = await expectRejectedOperation(writer.discard());

			// Assert
			expect(errorPublicText(cleanupError)).toContain('discard-failed');
			expect(await readdir(artifactsDirectoryPath)).toHaveLength(1);
			expectNoPrivatePathLeak(operationError, artifactsDirectoryPath);
			expectNoPrivatePathLeak(cleanupError, artifactsDirectoryPath);
			expect(errorPublicText(operationError)).not.toContain(injectedSecret);
			expect(errorPublicText(cleanupError)).not.toContain(injectedSecret);
		},
	);
});
