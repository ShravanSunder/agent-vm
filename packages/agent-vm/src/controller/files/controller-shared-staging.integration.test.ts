import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
	cleanupSharedStagingZoneAfterContainment,
	createControllerSharedStaging,
} from './controller-shared-staging.js';
import { createOperationFileRetentionBudget } from './operation-file-retention-budget.js';

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
	);
});

describe('controller run staging recovery', () => {
	it('cleans a contained zone across runs while preserving other zones and ordinary runtime files', async () => {
		// Arrange
		const root = await mkdtemp(path.join(os.tmpdir(), 'controller-staging-recovery-'));
		roots.push(root);
		await writeFile(path.join(root, 'sentinel'), 'ordinary runtime');
		const first = createControllerSharedStaging({
			controllerRuntimeDir: root,
			controllerEpoch: 'old-run',
			retentionBudget: createOperationFileRetentionBudget(),
			now: () => 0,
		});
		const oldZone = await first.getStore('zone-a', 'sun');
		const source = await oldZone.prepareOperation({
			producerId: 'producer',
			operationId: 'operation',
			maximumBytes: 128,
		});
		await writeFile(path.join(source, 'orphan'), 'old bytes');
		const other = await first.getStore('zone-b', 'ember');
		const otherSource = await other.prepareOperation({
			producerId: 'producer',
			operationId: 'operation',
			maximumBytes: 128,
		});
		await writeFile(path.join(otherSource, 'sentinel'), 'other zone');
		// Act
		await cleanupSharedStagingZoneAfterContainment({
			controllerRuntimeDir: root,
			zoneId: 'zone-a',
		});
		// Assert
		await expect(readFile(path.join(source, 'orphan'))).rejects.toMatchObject({ code: 'ENOENT' });
		expect(await readFile(path.join(otherSource, 'sentinel'), 'utf8')).toBe('other zone');
		expect(await readFile(path.join(root, 'sentinel'), 'utf8')).toBe('ordinary runtime');
		await cleanupSharedStagingZoneAfterContainment({
			controllerRuntimeDir: root,
			zoneId: 'zone-a',
		});
	});

	it('refuses a symlink cleanup root without touching its target', async () => {
		// Arrange
		const root = await mkdtemp(path.join(os.tmpdir(), 'controller-staging-symlink-'));
		roots.push(root);
		const target = path.join(root, 'unrelated');
		await mkdir(target);
		await writeFile(path.join(target, 'sentinel'), 'keep');
		await symlink(target, path.join(root, 'shared-staging'));
		// Act / Assert
		await expect(
			cleanupSharedStagingZoneAfterContainment({ controllerRuntimeDir: root, zoneId: 'zone' }),
		).rejects.toThrow('Unsafe');
		expect(await readdir(target)).toEqual(['sentinel']);
	});
});
