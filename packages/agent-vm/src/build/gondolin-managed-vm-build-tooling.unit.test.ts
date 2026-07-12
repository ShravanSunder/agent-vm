import fs from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
	createManagedVmBackendImageBuildTooling,
	managedVmImageAssetFileNames,
	resolveManagedVmBackendPackageSpec,
	resolveManagedVmMinimumZigVersion,
} from './gondolin-managed-vm-build-tooling.js';

describe('Gondolin managed VM build tooling boundary', () => {
	it('exports only build-time capabilities and primitive diagnostic projections', async () => {
		const source = await fs.readFile(new URL('./gondolin-managed-vm-build-tooling.ts', import.meta.url), 'utf8');

		expect(source).toContain("from '@agent-vm/gondolin-vm-adapter'");
		expect(source).not.toContain('ManagedVmProvider');
		expect(source).not.toContain('createGondolinManagedVmProvider');
		expect(createManagedVmBackendImageBuildTooling()).toEqual({
			buildImage: expect.any(Function),
			computeFingerprint: expect.any(Function),
		});
	});

	it('projects stable asset, package, and Zig metadata without backend objects', async () => {
		expect(managedVmImageAssetFileNames).toEqual([
			'manifest.json',
			'rootfs.ext4',
			'initramfs.cpio.lz4',
			'vmlinuz-virt',
		]);
		await expect(resolveManagedVmBackendPackageSpec()).resolves.toMatch(
			/^@earendil-works\/gondolin@/u,
		);
		await expect(resolveManagedVmMinimumZigVersion()).resolves.toMatch(/^\d+\.\d+\.\d+/u);
	});
});
