import { spawn } from 'node:child_process';

import type { BackupEncryption } from './backup-manager.js';

interface AgeEncryptionDependencies {
	/** Resolves the age identity (secret key) string from 1Password.
	 *  Format: AGE-SECRET-KEY-1... (the full key line from age-keygen).
	 *  Store this in 1Password as a "password" field. Generate with: age-keygen */
	readonly resolveIdentity: () => Promise<string>;
}

/**
 * Run a command with optional stdin input. Returns stdout as a string.
 * Rejects if the process exits non-zero.
 */
function runWithStdin(
	command: string,
	args: readonly string[],
	stdinInput?: string,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';

		child.stdout.on('data', (data: Buffer) => {
			stdout += data.toString('utf8');
		});
		child.stderr.on('data', (data: Buffer) => {
			stderr += data.toString('utf8');
		});

		child.on('close', (code) => {
			if (code !== 0) {
				reject(new Error(`${command} failed (exit ${code}): ${stderr.trim()}`));
				return;
			}
			resolve(stdout);
		});

		if (stdinInput !== undefined) {
			child.stdin.write(stdinInput);
			child.stdin.end();
		} else {
			child.stdin.end();
		}
	});
}

/**
 * Derive the public key (recipient) from an age identity key via stdin.
 * No temp files — the secret key stays in memory.
 */
async function deriveRecipientFromIdentity(identityLine: string): Promise<string> {
	const stdout = await runWithStdin('age-keygen', ['-y', '/dev/stdin'], identityLine + '\n');
	return stdout.trim();
}

/**
 * Age identity-key-based encryption for zone backups.
 *
 * Uses age public-key encryption: the identity key (AGE-SECRET-KEY-1...)
 * is stored in 1Password per zone. The public key (recipient) is derived
 * at encryption time via age-keygen -y.
 *
 * Secret keys are never written to disk — they're passed via stdin
 * using /dev/stdin as the identity file path.
 */
export function createAgeBackupEncryption(
	dependencies: AgeEncryptionDependencies,
): BackupEncryption {
	return {
		encrypt: async (inputPath, outputPath) => {
			const identity = await dependencies.resolveIdentity();
			const recipient = await deriveRecipientFromIdentity(identity);
			await runWithStdin('age', [
				'--encrypt',
				'--recipient',
				recipient,
				'--output',
				outputPath,
				inputPath,
			]);
		},
		decrypt: async (inputPath, outputPath) => {
			const identity = await dependencies.resolveIdentity();
			await runWithStdin(
				'age',
				['--decrypt', '--identity', '/dev/stdin', '--output', outputPath, inputPath],
				identity + '\n',
			);
		},
	};
}
