import { describe, expect, it, vi } from 'vitest';

import { createAgeEncryption } from './snapshot-encryption.js';

describe('createAgeEncryption', () => {
	it('calls age with the passphrase to encrypt a file', async () => {
		const execCommands: { cmd: string; args: string[] }[] = [];
		const encryption = createAgeEncryption({
			resolvePassphrase: async () => 'test-passphrase-32chars-minimum!',
			execFileAsync: async (
				cmd: string,
				args: readonly string[],
			) => {
				execCommands.push({ cmd, args: [...args] });
				return { stdout: '', stderr: '' };
			},
		});

		await encryption.encrypt('/tmp/input.tar', '/tmp/output.tar.age');

		expect(execCommands).toHaveLength(1);
		expect(execCommands[0]?.cmd).toBe('age');
		expect(execCommands[0]?.args).toContain('--encrypt');
		expect(execCommands[0]?.args).toContain('--passphrase');
		expect(execCommands[0]?.args).toContain('--output');
		expect(execCommands[0]?.args).toContain('/tmp/output.tar.age');
		expect(execCommands[0]?.args).toContain('/tmp/input.tar');
	});

	it('calls age with the passphrase to decrypt a file', async () => {
		const execCommands: { cmd: string; args: string[] }[] = [];
		const encryption = createAgeEncryption({
			resolvePassphrase: async () => 'test-passphrase-32chars-minimum!',
			execFileAsync: async (
				cmd: string,
				args: readonly string[],
			) => {
				execCommands.push({ cmd, args: [...args] });
				return { stdout: '', stderr: '' };
			},
		});

		await encryption.decrypt('/tmp/input.tar.age', '/tmp/output.tar');

		expect(execCommands).toHaveLength(1);
		expect(execCommands[0]?.cmd).toBe('age');
		expect(execCommands[0]?.args).toContain('--decrypt');
		expect(execCommands[0]?.args).toContain('--output');
		expect(execCommands[0]?.args).toContain('/tmp/output.tar');
		expect(execCommands[0]?.args).toContain('/tmp/input.tar.age');
	});

	it('resolves the passphrase before each operation', async () => {
		const resolvePassphrase = vi.fn(async () => 'my-secret');
		const encryption = createAgeEncryption({
			resolvePassphrase,
			execFileAsync: async () => ({ stdout: '', stderr: '' }),
		});

		await encryption.encrypt('/tmp/a', '/tmp/b');
		await encryption.decrypt('/tmp/b', '/tmp/c');

		expect(resolvePassphrase).toHaveBeenCalledTimes(2);
	});
});
