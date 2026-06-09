import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAgeBackupEncryption } from './backup-encryption.js';

async function generateTestIdentity(): Promise<string> {
	const { execFile } = await import('node:child_process');
	const { promisify } = await import('node:util');
	const output = await promisify(execFile)('age-keygen', [], { encoding: 'utf8' });
	const match =
		output.stderr.match(/AGE-SECRET-KEY-\S+/u) ?? output.stdout.match(/AGE-SECRET-KEY-\S+/u);
	if (!match) {
		throw new Error('Failed to generate age identity');
	}
	return match[0];
}

describe('createAgeBackupEncryption', () => {
	let tmpDir: string | undefined;

	afterEach(() => {
		if (tmpDir) {
			fs.rmSync(tmpDir, { recursive: true, force: true });
			tmpDir = undefined;
		}
	});

	it('encrypts and decrypts a file using an age identity key', async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'age-test-'));
		const identity = await generateTestIdentity();
		const inputPath = path.join(tmpDir, 'input.txt');
		const encryptedPath = path.join(tmpDir, 'output.age');
		const decryptedPath = path.join(tmpDir, 'decrypted.txt');
		fs.writeFileSync(inputPath, 'hello from age encryption test');

		const encryption = createAgeBackupEncryption({
			resolveIdentity: async () => identity,
		});

		await encryption.encrypt(inputPath, encryptedPath);
		expect(fs.existsSync(encryptedPath)).toBe(true);
		expect(fs.readFileSync(encryptedPath).length).toBeGreaterThan(0);
		expect(fs.readFileSync(encryptedPath, 'utf8')).not.toContain('hello from age');

		await encryption.decrypt(encryptedPath, decryptedPath);
		expect(fs.readFileSync(decryptedPath, 'utf8')).toBe('hello from age encryption test');
	});

	it('resolves the identity before each operation', async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'age-resolve-'));
		const identity = await generateTestIdentity();
		const resolveIdentity = vi.fn(async () => identity);
		const inputPath = path.join(tmpDir, 'input.txt');
		fs.writeFileSync(inputPath, 'test');

		const encryption = createAgeBackupEncryption({ resolveIdentity });

		await encryption.encrypt(inputPath, path.join(tmpDir, 'out1.age'));
		await encryption.decrypt(path.join(tmpDir, 'out1.age'), path.join(tmpDir, 'out1.txt'));

		expect(resolveIdentity).toHaveBeenCalledTimes(2);
	});
});
