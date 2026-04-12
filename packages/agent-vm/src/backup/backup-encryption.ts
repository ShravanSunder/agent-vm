import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { BackupEncryption } from './backup-manager.js';

const execFileAsync = promisify(execFile);

interface AgeEncryptionDependencies {
	/** Resolves the age identity (secret key) string from 1Password.
	 *  Format: AGE-SECRET-KEY-1... (the full key line from age-keygen).
	 *  Store this in 1Password as a "password" field. Generate with: age-keygen */
	readonly resolveIdentity: () => Promise<string>;
}

async function deriveRecipientFromIdentity(identityLine: string): Promise<string> {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'age-identity-'));
	const identityPath = path.join(tmpDir, 'identity.txt');
	try {
		fs.writeFileSync(identityPath, identityLine + '\n', { mode: 0o600 });
		const result = await execFileAsync('age-keygen', ['-y', identityPath], {
			encoding: 'utf8',
		});
		return result.stdout.trim();
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

/**
 * Age identity-key-based encryption for zone backups.
 *
 * Uses age public-key encryption: the identity key (AGE-SECRET-KEY-1...)
 * is stored in 1Password per zone. The public key (recipient) is derived
 * at encryption time via age-keygen -y.
 *
 * Note: age's --passphrase mode requires an interactive TTY and cannot
 * be driven programmatically. Identity-key mode works non-interactively.
 * The 1Password vault item must store an actual age identity key, not
 * a human-readable passphrase.
 */
export function createAgeBackupEncryption(
	dependencies: AgeEncryptionDependencies,
): BackupEncryption {
	return {
		encrypt: async (inputPath, outputPath) => {
			const identity = await dependencies.resolveIdentity();
			const recipient = await deriveRecipientFromIdentity(identity);
			await execFileAsync(
				'age',
				['--encrypt', '--recipient', recipient, '--output', outputPath, inputPath],
				{
					encoding: 'utf8',
				},
			);
		},
		decrypt: async (inputPath, outputPath) => {
			const identity = await dependencies.resolveIdentity();
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'age-decrypt-'));
			const identityPath = path.join(tmpDir, 'identity.txt');
			try {
				fs.writeFileSync(identityPath, identity + '\n', { mode: 0o600 });
				await execFileAsync(
					'age',
					['--decrypt', '--identity', identityPath, '--output', outputPath, inputPath],
					{
						encoding: 'utf8',
					},
				);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		},
	};
}
