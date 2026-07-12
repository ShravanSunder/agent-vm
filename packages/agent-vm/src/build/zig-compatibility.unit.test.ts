import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	assertManagedVmZigCompatibility,
	buildZigInstallHint,
	buildZigUpgradeHint,
	checkManagedVmZigCompatibility,
	isZigVersionAtLeast,
	resolveManagedVmCompatibleZigVersion,
	resolveHostZigVersion,
} from './zig-compatibility.js';

const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));

vi.mock('execa', () => ({ execa: execaMock }));

describe('Zig compatibility', () => {
	beforeEach(() => {
		execaMock.mockReset();
	});

	it('resolves the required Gondolin Zig version through the supplied resolver', async () => {
		await expect(resolveManagedVmCompatibleZigVersion(async () => '0.15.2')).resolves.toBe(
			'0.15.2',
		);
	});

	it('resolves the host Zig version from the zig binary', async () => {
		execaMock.mockResolvedValue({ stdout: '0.15.2\n' });

		await expect(resolveHostZigVersion()).resolves.toBe('0.15.2');
		expect(execaMock).toHaveBeenCalledWith('zig', ['version']);
	});

	it('treats missing zig binary as an absent host Zig version', async () => {
		const missingBinaryError = Object.assign(new Error('spawn zig ENOENT'), {
			code: 'ENOENT',
		}) satisfies Error & { readonly code: string };
		execaMock.mockRejectedValue(missingBinaryError);

		await expect(resolveHostZigVersion()).resolves.toBeUndefined();
	});

	it('preserves non-missing zig execution failures', async () => {
		const permissionError = Object.assign(new Error('permission denied'), {
			code: 'EACCES',
		}) satisfies Error & { readonly code: string };
		execaMock.mockRejectedValue(permissionError);

		await expect(resolveHostZigVersion()).rejects.toThrow(
			'Failed to run zig version: permission denied',
		);
	});

	it('compares semantic Zig versions by major, minor, and patch', () => {
		expect(isZigVersionAtLeast('0.15.2', '0.15.2')).toBe(true);
		expect(isZigVersionAtLeast('0.15.3', '0.15.2')).toBe(true);
		expect(isZigVersionAtLeast('0.16.0-rc.1', '0.15.2')).toBe(true);
		expect(isZigVersionAtLeast('0.15.2-dev.1', '0.15.2')).toBe(false);
		expect(isZigVersionAtLeast('0.15.2-rc.1', '0.15.2')).toBe(false);
		expect(isZigVersionAtLeast('0.15.2', '0.15.2-rc.1')).toBe(true);
		expect(isZigVersionAtLeast('0.15.1', '0.15.2')).toBe(false);
		expect(isZigVersionAtLeast('not-a-version', '0.15.2')).toBe(false);
	});

	it('returns a compatible discriminated result for installed Zig versions that satisfy Gondolin', () => {
		expect(
			checkManagedVmZigCompatibility({
				installedVersion: '0.15.2',
				requiredVersion: '0.15.2',
			}),
		).toEqual({
			compatible: true,
			kind: 'compatible',
			requiredVersion: '0.15.2',
			installedVersion: '0.15.2',
			hint: 'found 0.15.2, required >= 0.15.2',
		});
	});

	it('returns a missing discriminated result when Zig is not installed', () => {
		expect(
			checkManagedVmZigCompatibility({
				requiredVersion: '0.15.2',
			}),
		).toEqual({
			compatible: false,
			kind: 'missing',
			requiredVersion: '0.15.2',
			hint: 'Install Zig >= 0.15.2. On macOS: brew install zig.',
		});
	});

	it('returns an incompatible discriminated result when Zig is too old', () => {
		expect(
			checkManagedVmZigCompatibility({
				installedVersion: '0.15.1',
				requiredVersion: '0.15.2',
			}),
		).toEqual({
			compatible: false,
			kind: 'incompatible',
			requiredVersion: '0.15.2',
			installedVersion: '0.15.1',
			hint: 'Requires Zig >= 0.15.2. On macOS: brew install zig.',
		});
	});

	it('keeps install and upgrade hints stable for CLI callers', () => {
		expect(buildZigInstallHint('0.15.2')).toBe(
			'Install Zig >= 0.15.2. On macOS: brew install zig.',
		);
		expect(buildZigInstallHint(undefined)).toBe(
			'Install Zig required by Gondolin. On macOS: brew install zig.',
		);
		expect(buildZigUpgradeHint('0.15.2')).toBe(
			'Requires Zig >= 0.15.2. On macOS: brew install zig.',
		);
	});

	it('throws install guidance when builds need Zig but none is installed', () => {
		expect(() =>
			assertManagedVmZigCompatibility({
				requiredVersion: '0.15.2',
			}),
		).toThrow('Install Zig >= 0.15.2. On macOS: brew install zig.');
	});

	it('throws upgrade guidance with the installed version when Zig is incompatible', () => {
		expect(() =>
			assertManagedVmZigCompatibility({
				installedVersion: '0.15.1',
				requiredVersion: '0.15.2',
			}),
		).toThrow('Requires Zig >= 0.15.2. On macOS: brew install zig. Current version: 0.15.1.');
	});
});
