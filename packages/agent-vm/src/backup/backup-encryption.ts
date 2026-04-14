import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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

async function withTemporaryIdentityFile<TResult>(
	identityLine: string,
	runWithIdentityFile: (identityFilePath: string) => Promise<TResult>,
): Promise<TResult> {
	const temporaryIdentityPath = path.join(
		os.tmpdir(),
		`agent-vm-age-identity-${process.pid}-${Date.now()}.txt`,
	);
	await fs.writeFile(temporaryIdentityPath, `${identityLine}\n`, {
		encoding: 'utf8',
		mode: 0o600,
	});
	try {
		return await runWithIdentityFile(temporaryIdentityPath);
	} finally {
		await fs.rm(temporaryIdentityPath, { force: true });
	}
}

/**
 * Derive the public key (recipient) from an age identity key via a short-lived
 * 0600 temp file. `/dev/stdin` is not portable enough across CI runners.
 */
async function deriveRecipientFromIdentity(identityLine: string): Promise<string> {
	return await withTemporaryIdentityFile(identityLine, async (identityFilePath) =>
		(await runWithStdin('age-keygen', ['-y', identityFilePath])).trim(),
	);
}

/**
 * Age identity-key-based encryption for zone backups.
 *
 * Uses age public-key encryption: the identity key (AGE-SECRET-KEY-1...)
 * is stored in 1Password per zone. The public key (recipient) is derived
 * at encryption time via age-keygen -y.
 *
 * Secret keys are written only to a short-lived 0600 temp file for tool
 * compatibility, then deleted immediately after each operation.
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
			await withTemporaryIdentityFile(
				identity,
				async (identityFilePath) =>
					await runWithStdin('age', [
						'--decrypt',
						'--identity',
						identityFilePath,
						'--output',
						outputPath,
						inputPath,
					]),
			);
		},
	};
}
