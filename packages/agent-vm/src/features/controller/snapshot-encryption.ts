import type { SnapshotEncryption } from './snapshot-manager.js';

interface AgeEncryptionDependencies {
	readonly resolvePassphrase: () => Promise<string>;
	readonly execFileAsync?: (
		cmd: string,
		args: readonly string[],
		options?: { env?: Record<string, string> },
	) => Promise<{ stdout: string; stderr: string }>;
}

export function createAgeEncryption(
	dependencies: AgeEncryptionDependencies,
): SnapshotEncryption {
	const execFileAsync =
		dependencies.execFileAsync ??
		(async (
			cmd: string,
			args: readonly string[],
			options?: { env?: Record<string, string> },
		): Promise<{ stdout: string; stderr: string }> => {
			const { execFile } = await import('node:child_process');
			const { promisify } = await import('node:util');
			const result = await promisify(execFile)(cmd, [...args], {
				...options,
				encoding: 'utf8',
			});
			return { stdout: String(result.stdout), stderr: String(result.stderr) };
		});

	return {
		encrypt: async (inputPath, outputPath) => {
			const passphrase = await dependencies.resolvePassphrase();
			await execFileAsync(
				'age',
				['--encrypt', '--passphrase', '--output', outputPath, inputPath],
				{ env: { ...process.env, AGE_PASSPHRASE: passphrase } },
			);
		},
		decrypt: async (inputPath, outputPath) => {
			const passphrase = await dependencies.resolvePassphrase();
			await execFileAsync(
				'age',
				['--decrypt', '--output', outputPath, inputPath],
				{ env: { ...process.env, AGE_PASSPHRASE: passphrase } },
			);
		},
	};
}
