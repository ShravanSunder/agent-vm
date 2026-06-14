import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createEncryptedBackup } from './backup-create-operation.js';
import { restoreEncryptedBackup } from './backup-restore-operation.js';

type BackupOperationExecFileAsync = (command: string, args: readonly string[]) => Promise<void>;

async function createTemporaryDirectory(prefix: string): Promise<string> {
	return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function readDirectoryIfExists(directoryPath: string): Promise<readonly string[]> {
	try {
		return await fs.readdir(directoryPath);
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			return [];
		}
		throw error;
	}
}

async function expectPathMissing(filePath: string): Promise<void> {
	await expect(fs.access(filePath)).rejects.toThrow();
}

const failIfTarRunsAfterDecryptFailure: BackupOperationExecFileAsync = async () => {
	throw new Error('tar should not run after decrypt failure.');
};

function createFakeArchiveExecFile(onTarCreate: (tarPath: string) => Promise<void>) {
	return async (command: string, args: readonly string[]): Promise<void> => {
		if (command === 'cp' && args[0] === '-a') {
			const sourcePath = args[1];
			const targetPath = args[2];
			if (sourcePath === undefined || targetPath === undefined) {
				throw new Error('cp fixture requires source and target paths.');
			}
			await fs.cp(sourcePath, targetPath, { recursive: true });
			return;
		}

		if (command === 'tar' && args[0] === 'cf') {
			const tarPath = args[1];
			if (tarPath === undefined) {
				throw new Error('tar create fixture requires an output path.');
			}
			await onTarCreate(tarPath);
			return;
		}

		throw new Error(`Unexpected command in backup unit test: ${command} ${args.join(' ')}`);
	};
}

function createFakeRestoreExecFile(options: {
	readonly failCopyBasename?: string;
	readonly manifestJson?: string;
	readonly stateFiles: Readonly<Record<string, string>>;
	readonly zoneFiles?: Readonly<Record<string, string>>;
	readonly zoneId?: string;
}): BackupOperationExecFileAsync {
	return async (command: string, args: readonly string[]): Promise<void> => {
		if (command === 'tar' && args[0] === 'xf') {
			const extractDirectory = args[3];
			if (extractDirectory === undefined) {
				throw new Error('tar extract fixture requires an extract directory.');
			}
			const extractedStateDirectory = path.join(extractDirectory, 'state');
			await fs.mkdir(extractedStateDirectory, { recursive: true });
			await Promise.all(
				Object.entries(options.stateFiles).map(
					async ([fileName, content]) =>
						await fs.writeFile(path.join(extractedStateDirectory, fileName), content),
				),
			);
			if (options.zoneFiles !== undefined) {
				const extractedZoneFilesDirectory = path.join(extractDirectory, 'zone-files');
				await fs.mkdir(extractedZoneFilesDirectory, { recursive: true });
				await Promise.all(
					Object.entries(options.zoneFiles).map(
						async ([fileName, content]) =>
							await fs.writeFile(path.join(extractedZoneFilesDirectory, fileName), content),
					),
				);
			}
			await fs.writeFile(
				path.join(extractDirectory, 'manifest.json'),
				options.manifestJson ?? JSON.stringify({ zoneId: options.zoneId ?? 'sunfam' }),
			);
			return;
		}

		if (command === 'cp' && args[0] === '-a') {
			const sourcePath = args[1];
			const targetPath = args[2];
			if (sourcePath === undefined || targetPath === undefined) {
				throw new Error('cp fixture requires source and target paths.');
			}
			if (path.basename(sourcePath) === options.failCopyBasename) {
				throw new Error(`copy failed for ${options.failCopyBasename}`);
			}
			await fs.cp(sourcePath, targetPath, { recursive: true });
			return;
		}

		throw new Error(`Unexpected command in restore unit test: ${command} ${args.join(' ')}`);
	};
}

async function listPreRestoreDirectories(targetDirectory: string): Promise<readonly string[]> {
	const parentDirectory = path.dirname(targetDirectory);
	const prefix = `${path.basename(targetDirectory)}.pre-restore-`;
	return (await fs.readdir(parentDirectory))
		.filter((entryName) => entryName.startsWith(prefix))
		.map((entryName) => path.join(parentDirectory, entryName));
}

describe('backup plaintext cleanup', () => {
	it('rejects backupDir nested in stateDir before archiving', async () => {
		const rootDirectory = await createTemporaryDirectory('agent-vm-backup-boundary-unit-');
		try {
			const cacheDir = path.join(rootDirectory, 'cache');
			const runtimeDir = path.join(rootDirectory, 'runtime');
			const stateDir = path.join(rootDirectory, 'state', 'sunfam');
			const backupDir = path.join(stateDir, 'backups');
			await fs.mkdir(stateDir, { recursive: true });

			let commandCount = 0;

			await expect(
				createEncryptedBackup({
					backupDir,
					cacheDir,
					encryption: { decrypt: async () => {}, encrypt: async () => {} },
					execFileAsync: async () => {
						commandCount += 1;
					},
					runtimeDir,
					stateDir,
					zoneId: 'sunfam',
				}),
			).rejects.toThrow(/backupDir .* must not overlap stateDir/u);

			expect(commandCount).toBe(0);
		} finally {
			await fs.rm(rootDirectory, { recursive: true, force: true });
		}
	});

	it('rejects backupDir nested in zoneFilesDir before archiving', async () => {
		const rootDirectory = await createTemporaryDirectory('agent-vm-backup-boundary-unit-');
		try {
			const cacheDir = path.join(rootDirectory, 'cache');
			const runtimeDir = path.join(rootDirectory, 'runtime');
			const stateDir = path.join(rootDirectory, 'state', 'sunfam');
			const zoneFilesDir = path.join(rootDirectory, 'zone-files', 'sunfam');
			const backupDir = path.join(zoneFilesDir, 'backups');
			await fs.mkdir(stateDir, { recursive: true });
			await fs.mkdir(zoneFilesDir, { recursive: true });

			let commandCount = 0;

			await expect(
				createEncryptedBackup({
					backupDir,
					cacheDir,
					encryption: { decrypt: async () => {}, encrypt: async () => {} },
					execFileAsync: async () => {
						commandCount += 1;
					},
					runtimeDir,
					stateDir,
					zoneFilesDir,
					zoneId: 'sunfam',
				}),
			).rejects.toThrow(/backupDir .* must not overlap zoneFilesDir/u);

			expect(commandCount).toBe(0);
		} finally {
			await fs.rm(rootDirectory, { recursive: true, force: true });
		}
	});

	it('removes the intermediate plaintext tar when encryption fails', async () => {
		const rootDirectory = await createTemporaryDirectory('agent-vm-backup-create-unit-');
		try {
			const backupDir = path.join(rootDirectory, 'backups');
			const cacheDir = path.join(rootDirectory, 'cache');
			const runtimeDir = path.join(rootDirectory, 'runtime');
			const stateDir = path.join(rootDirectory, 'state', 'sunfam');
			await fs.mkdir(stateDir, { recursive: true });
			await fs.writeFile(path.join(stateDir, 'session.json'), '{"token":"secret"}\n');

			let plaintextTarPath: string | null = null;
			const execFileAsync = createFakeArchiveExecFile(async (tarPath) => {
				plaintextTarPath = tarPath;
				await fs.writeFile(tarPath, 'plaintext state archive');
			});

			await expect(
				createEncryptedBackup({
					backupDir,
					cacheDir,
					encryption: {
						decrypt: async () => {},
						encrypt: async () => {
							throw new Error('age encryption failed');
						},
					},
					execFileAsync,
					runtimeDir,
					stateDir,
					zoneId: 'sunfam',
				}),
			).rejects.toThrow('age encryption failed');

			expect(plaintextTarPath).not.toBeNull();
			if (plaintextTarPath !== null) {
				expect(path.dirname(plaintextTarPath)).not.toBe(backupDir);
				await expectPathMissing(plaintextTarPath);
			}
			expect(
				(await readDirectoryIfExists(backupDir)).filter((entry) => entry.endsWith('.tar')),
			).toEqual([]);
		} finally {
			await fs.rm(rootDirectory, { recursive: true, force: true });
		}
	});

	it('does not publish a partial encrypted artifact when encryption writes then fails', async () => {
		const rootDirectory = await createTemporaryDirectory('agent-vm-backup-create-unit-');
		try {
			const backupDir = path.join(rootDirectory, 'backups');
			const cacheDir = path.join(rootDirectory, 'cache');
			const runtimeDir = path.join(rootDirectory, 'runtime');
			const stateDir = path.join(rootDirectory, 'state', 'sunfam');
			await fs.mkdir(stateDir, { recursive: true });
			await fs.writeFile(path.join(stateDir, 'session.json'), '{"token":"secret"}\n');

			let encryptedOutputPath: string | null = null;

			await expect(
				createEncryptedBackup({
					backupDir,
					cacheDir,
					encryption: {
						decrypt: async () => {},
						encrypt: async (_inputPath, outputPath) => {
							encryptedOutputPath = outputPath;
							await fs.writeFile(outputPath, 'partial encrypted archive');
							throw new Error('age encryption failed after write');
						},
					},
					execFileAsync: createFakeArchiveExecFile(async (tarPath) => {
						await fs.writeFile(tarPath, 'plaintext state archive');
					}),
					runtimeDir,
					stateDir,
					zoneId: 'sunfam',
				}),
			).rejects.toThrow('age encryption failed after write');

			expect(encryptedOutputPath).not.toBeNull();
			if (encryptedOutputPath !== null) {
				await expectPathMissing(encryptedOutputPath);
			}
			expect(
				(await readDirectoryIfExists(backupDir)).filter((entry) => entry.endsWith('.tar.age')),
			).toEqual([]);
		} finally {
			await fs.rm(rootDirectory, { recursive: true, force: true });
		}
	});

	it('decrypts into a temporary path and removes partial plaintext when decrypt fails', async () => {
		const rootDirectory = await createTemporaryDirectory('agent-vm-backup-restore-unit-');
		try {
			const backupDir = path.join(rootDirectory, 'backups');
			const stateDir = path.join(rootDirectory, 'state', 'sunfam');
			const backupPath = path.join(backupDir, 'sunfam__2026-06-11T00-00-00-000Z.tar.age');
			await fs.mkdir(backupDir, { recursive: true });
			await fs.mkdir(stateDir, { recursive: true });
			await fs.writeFile(backupPath, 'encrypted archive');

			let decryptedTarPath: string | null = null;

			await expect(
				restoreEncryptedBackup({
					backupPath,
					encryption: {
						decrypt: async (_inputPath, outputPath) => {
							decryptedTarPath = outputPath;
							await fs.writeFile(outputPath, 'partial plaintext archive');
							throw new Error('age decrypt failed');
						},
						encrypt: async () => {},
					},
					execFileAsync: failIfTarRunsAfterDecryptFailure,
					stateDir,
				}),
			).rejects.toThrow('age decrypt failed');

			expect(decryptedTarPath).not.toBeNull();
			if (decryptedTarPath !== null) {
				expect(decryptedTarPath).not.toBe(`${backupPath}.decrypted.tar`);
				await expectPathMissing(decryptedTarPath);
			}
			expect(await readDirectoryIfExists(backupDir)).toEqual([path.basename(backupPath)]);
		} finally {
			await fs.rm(rootDirectory, { recursive: true, force: true });
		}
	});
});

describe('staged backup restore', () => {
	it('leaves live state unchanged when incoming copy fails', async () => {
		const rootDirectory = await createTemporaryDirectory('agent-vm-backup-staged-fail-unit-');
		try {
			const backupPath = path.join(rootDirectory, 'sunfam__2026-06-11T00-00-00-000Z.tar.age');
			const stateDir = path.join(rootDirectory, 'state', 'sunfam');
			await fs.mkdir(stateDir, { recursive: true });
			await fs.writeFile(backupPath, 'encrypted archive');
			await fs.writeFile(path.join(stateDir, 'session.json'), 'old state\n');

			await expect(
				restoreEncryptedBackup({
					backupPath,
					encryption: {
						decrypt: async (_inputPath, outputPath) => {
							await fs.writeFile(outputPath, 'plaintext archive');
						},
						encrypt: async () => {},
					},
					execFileAsync: createFakeRestoreExecFile({
						failCopyBasename: '02-fail.json',
						stateFiles: {
							'01-new.json': 'new state\n',
							'02-fail.json': 'copy should fail\n',
						},
					}),
					stateDir,
				}),
			).rejects.toThrow('copy failed for 02-fail.json');

			expect(await fs.readFile(path.join(stateDir, 'session.json'), 'utf8')).toBe('old state\n');
			await expectPathMissing(path.join(stateDir, '01-new.json'));
			expect(await listPreRestoreDirectories(stateDir)).toEqual([]);
		} finally {
			await fs.rm(rootDirectory, { recursive: true, force: true });
		}
	});

	it('swaps restored state through an incoming directory and retains pre-restore state', async () => {
		const rootDirectory = await createTemporaryDirectory('agent-vm-backup-staged-swap-unit-');
		try {
			const backupPath = path.join(rootDirectory, 'sunfam__2026-06-11T00-00-00-000Z.tar.age');
			const stateDir = path.join(rootDirectory, 'state', 'sunfam');
			await fs.mkdir(stateDir, { recursive: true });
			await fs.writeFile(backupPath, 'encrypted archive');
			await fs.writeFile(path.join(stateDir, 'session.json'), 'old state\n');

			const result = await restoreEncryptedBackup({
				backupPath,
				encryption: {
					decrypt: async (_inputPath, outputPath) => {
						await fs.writeFile(outputPath, 'plaintext archive');
					},
					encrypt: async () => {},
				},
				execFileAsync: createFakeRestoreExecFile({
					stateFiles: {
						'session.json': 'new state\n',
					},
				}),
				stateDir,
			});

			expect(result.zoneId).toBe('sunfam');
			expect(await fs.readFile(path.join(stateDir, 'session.json'), 'utf8')).toBe('new state\n');
			const preRestoreDirectories = await listPreRestoreDirectories(stateDir);
			expect(preRestoreDirectories).toHaveLength(1);
			expect(
				await fs.readFile(path.join(preRestoreDirectories[0] ?? '', 'session.json'), 'utf8'),
			).toBe('old state\n');
		} finally {
			await fs.rm(rootDirectory, { recursive: true, force: true });
		}
	});

	it('leaves live state unchanged when the manifest is invalid', async () => {
		const rootDirectory = await createTemporaryDirectory('agent-vm-backup-manifest-fail-unit-');
		try {
			const backupPath = path.join(rootDirectory, 'sunfam__2026-06-11T00-00-00-000Z.tar.age');
			const stateDir = path.join(rootDirectory, 'state', 'sunfam');
			await fs.mkdir(stateDir, { recursive: true });
			await fs.writeFile(backupPath, 'encrypted archive');
			await fs.writeFile(path.join(stateDir, 'session.json'), 'old state\n');

			await expect(
				restoreEncryptedBackup({
					backupPath,
					encryption: {
						decrypt: async (_inputPath, outputPath) => {
							await fs.writeFile(outputPath, 'plaintext archive');
						},
						encrypt: async () => {},
					},
					execFileAsync: createFakeRestoreExecFile({
						manifestJson: '{"zoneId":""}',
						stateFiles: {
							'session.json': 'new state\n',
						},
					}),
					stateDir,
				}),
			).rejects.toThrow(/manifest.*zoneId/u);

			expect(await fs.readFile(path.join(stateDir, 'session.json'), 'utf8')).toBe('old state\n');
			expect(await listPreRestoreDirectories(stateDir)).toEqual([]);
		} finally {
			await fs.rm(rootDirectory, { recursive: true, force: true });
		}
	});

	it('rolls back state when zone-files staging fails during a dual-directory restore', async () => {
		const rootDirectory = await createTemporaryDirectory('agent-vm-backup-dual-fail-unit-');
		try {
			const backupPath = path.join(rootDirectory, 'sunfam__2026-06-11T00-00-00-000Z.tar.age');
			const stateDir = path.join(rootDirectory, 'state', 'sunfam');
			const zoneFilesDir = path.join(rootDirectory, 'zone-files', 'sunfam');
			await fs.mkdir(stateDir, { recursive: true });
			await fs.mkdir(zoneFilesDir, { recursive: true });
			await fs.writeFile(backupPath, 'encrypted archive');
			await fs.writeFile(path.join(stateDir, 'session.json'), 'old state\n');
			await fs.writeFile(path.join(zoneFilesDir, 'config.json'), 'old zone files\n');

			await expect(
				restoreEncryptedBackup({
					backupPath,
					encryption: {
						decrypt: async (_inputPath, outputPath) => {
							await fs.writeFile(outputPath, 'plaintext archive');
						},
						encrypt: async () => {},
					},
					execFileAsync: createFakeRestoreExecFile({
						failCopyBasename: 'config.json',
						stateFiles: {
							'session.json': 'new state\n',
						},
						zoneFiles: {
							'config.json': 'new zone files\n',
						},
					}),
					stateDir,
					zoneFilesDir,
				}),
			).rejects.toThrow('copy failed for config.json');

			expect(await fs.readFile(path.join(stateDir, 'session.json'), 'utf8')).toBe('old state\n');
			expect(await fs.readFile(path.join(zoneFilesDir, 'config.json'), 'utf8')).toBe(
				'old zone files\n',
			);
			expect(await listPreRestoreDirectories(stateDir)).toEqual([]);
			expect(await listPreRestoreDirectories(zoneFilesDir)).toEqual([]);
		} finally {
			await fs.rm(rootDirectory, { recursive: true, force: true });
		}
	});
});
