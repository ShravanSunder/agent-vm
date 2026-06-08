import { describe, expect, it } from 'vitest';

import { parseLsofPortOwnerOutput, readTcpListenPortOwner } from './port-owner.js';

describe('parseLsofPortOwnerOutput', () => {
	it('parses pid and command from lsof field output', () => {
		expect(parseLsofPortOwnerOutput('p12345\ncqemu-system-aarch64\n')).toEqual({
			command: 'qemu-system-aarch64',
			pid: 12_345,
		});
	});

	it('returns null for empty lsof output', () => {
		expect(parseLsofPortOwnerOutput('')).toBeNull();
	});

	it('returns null for missing pid or command fields', () => {
		expect(parseLsofPortOwnerOutput('p12345\n')).toBeNull();
		expect(parseLsofPortOwnerOutput('cqemu-system-aarch64\n')).toBeNull();
	});
});

describe('readTcpListenPortOwner', () => {
	it('maps missing lsof to an actionable host dependency error', async () => {
		await expect(
			readTcpListenPortOwner(19_500, {
				execFile: async () => {
					const error = new Error('spawn lsof ENOENT') as Error & { code: string };
					error.code = 'ENOENT';
					throw error;
				},
			}),
		).rejects.toThrow(/requires 'lsof' on PATH/u);
	});

	it('returns null when lsof reports no listener', async () => {
		await expect(
			readTcpListenPortOwner(19_500, {
				execFile: async () => {
					const error = new Error('no listener') as Error & { code: number };
					error.code = 1;
					throw error;
				},
			}),
		).resolves.toBeNull();
	});
});
