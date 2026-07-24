import { describe, expect, it } from 'vitest';

import { validateManagedVmFinalizeMemoryMountRequest } from './managed-vm-contracts.js';

describe('validateManagedVmFinalizeMemoryMountRequest', () => {
	it('copies one complete canonical file inventory', () => {
		const callerContents = Uint8Array.from([1, 2, 3]);

		const validated = validateManagedVmFinalizeMemoryMountRequest({
			files: [
				{
					contents: callerContents,
					mode: 0o600,
					relativePath: 'nested/config.json',
				},
			],
			guestPath: '/run/agent-vm/structured-inputs',
		});
		callerContents[0] = 9;

		expect(validated).toEqual({
			files: [
				{
					contents: Uint8Array.from([1, 2, 3]),
					mode: 0o600,
					relativePath: 'nested/config.json',
				},
			],
			guestPath: '/run/agent-vm/structured-inputs',
		});
		expect(validated.files[0]?.contents).not.toBe(callerContents);
	});

	it.each([
		['empty path', ''],
		['absolute path', '/config.json'],
		['current-directory segment', './config.json'],
		['parent traversal', '../config.json'],
		['nested parent traversal', 'nested/../config.json'],
		['repeated separator', 'nested//config.json'],
		['trailing separator', 'nested/'],
		['backslash alias', 'nested\\config.json'],
		['NUL byte', 'nested/config.json\0ignored'],
	] as const)('rejects a noncanonical relative path: %s', (_scenario, relativePath) => {
		expect(() =>
			validateManagedVmFinalizeMemoryMountRequest({
				files: [{ contents: new Uint8Array(), mode: 0o600, relativePath }],
				guestPath: '/run/agent-vm/structured-inputs',
			}),
		).toThrow('canonical relative path');
	});

	it('rejects duplicate files and file-directory prefix collisions', () => {
		expect(() =>
			validateManagedVmFinalizeMemoryMountRequest({
				files: [
					{ contents: new Uint8Array(), mode: 0o600, relativePath: 'config.json' },
					{ contents: new Uint8Array(), mode: 0o600, relativePath: 'config.json' },
				],
				guestPath: '/run/agent-vm/structured-inputs',
			}),
		).toThrow('duplicate relative path');

		expect(() =>
			validateManagedVmFinalizeMemoryMountRequest({
				files: [
					{ contents: new Uint8Array(), mode: 0o600, relativePath: 'nested' },
					{ contents: new Uint8Array(), mode: 0o600, relativePath: 'nested/config.json' },
				],
				guestPath: '/run/agent-vm/structured-inputs',
			}),
		).toThrow('file-directory collision');
	});

	it.each([-1, 0o1000, 1.5, Number.NaN])('rejects invalid file mode %s', (mode) => {
		expect(() =>
			validateManagedVmFinalizeMemoryMountRequest({
				files: [{ contents: new Uint8Array(), mode, relativePath: 'config.json' }],
				guestPath: '/run/agent-vm/structured-inputs',
			}),
		).toThrow('permission mode');
	});

	it('rejects an invalid guest mount path or unsupported content value before returning inventory', () => {
		expect(() =>
			validateManagedVmFinalizeMemoryMountRequest({
				files: [],
				guestPath: 'run/agent-vm/structured-inputs',
			}),
		).toThrow('guest path must be absolute');
		expect(() =>
			validateManagedVmFinalizeMemoryMountRequest({
				files: [{ contents: 'not-bytes', mode: 0o600, relativePath: 'config.json' }],
				guestPath: '/run/agent-vm/structured-inputs',
			} as never),
		).toThrow('Uint8Array');
	});
});
