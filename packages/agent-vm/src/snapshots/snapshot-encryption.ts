import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { SnapshotEncryption } from './snapshot-manager.js';

interface AgeEncryptionDependencies {
	/** Resolves the age identity (secret key) string, e.g. from 1Password.
	 *  Format: AGE-SECRET-KEY-1... (the full key line from age-keygen) */
	readonly resolveIdentity: () => Promise<string>;
}

/**
 * Runs `age` with recipient/identity key files instead of passphrase.
 * The official `age` binary does not support non-interactive passphrase input.
 * Using -R (recipient) for encryption and -i (identity) for decryption avoids
 * the terminal requirement entirely.
 */
async function runAge(args: readonly string[]): Promise<void> {
	const { execFile } = await import('node:child_process');
	const { promisify } = await import('node:util');
	const result = await promisify(execFile)('age', [...args], { encoding: 'utf8' });
	if (result.stderr && result.stderr.includes('error')) {
		throw new Error(`age error: ${result.stderr.trim()}`);
	}
}

async function deriveRecipientFromIdentity(identityLine: string): Promise<string> {
	// age-keygen output format: AGE-SECRET-KEY-1<base32>
	// We need to run age-keygen -y to derive the public key from the identity.
	// But to avoid shelling out, we can write the identity to a temp file and use -R.
	// Actually, `age` can encrypt to a recipient derived from an identity file using:
	// age -e -i identity.txt (since age 1.1+, -i can be used for encryption too — it auto-derives)
	// BUT that's not supported in all versions. Use age-keygen -y to derive.
	const { execFile } = await import('node:child_process');
	const { promisify } = await import('node:util');
	const execFileAsync = promisify(execFile);
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

export function createAgeEncryption(dependencies: AgeEncryptionDependencies): SnapshotEncryption {
	return {
		encrypt: async (inputPath, outputPath) => {
			const identity = await dependencies.resolveIdentity();
			const recipient = await deriveRecipientFromIdentity(identity);
			await runAge(['--encrypt', '--recipient', recipient, '--output', outputPath, inputPath]);
		},
		decrypt: async (inputPath, outputPath) => {
			const identity = await dependencies.resolveIdentity();
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'age-decrypt-'));
			const identityPath = path.join(tmpDir, 'identity.txt');
			try {
				fs.writeFileSync(identityPath, identity + '\n', { mode: 0o600 });
				await runAge(['--decrypt', '--identity', identityPath, '--output', outputPath, inputPath]);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		},
	};
}
