import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
	writeGatewayControlSessionMaterial,
	loadGatewayControlSessionMaterial,
	resolveGatewayControlSessionMaterialPath,
} from './gateway-control-session-material-store.js';
import {
	buildGatewayControlReadyHeaders,
	createGatewayControlSessionMaterial,
} from './gateway-control-session.js';

const createdDirectories: string[] = [];

afterEach(async () => {
	const directoriesToDelete = createdDirectories.splice(0);
	await Promise.all(
		directoriesToDelete.map(async (directoryPath) => {
			await rm(directoryPath, { force: true, recursive: true });
		}),
	);
});

async function createRuntimeDirectory(): Promise<string> {
	const directoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-control-material-'));
	createdDirectories.push(directoryPath);
	return directoryPath;
}

describe('gateway control session material store', () => {
	it('persists controller signing material under host runtime storage', async () => {
		const runtimeDirectory = await createRuntimeDirectory();
		const material = createGatewayControlSessionMaterial({
			controllerEpoch: 'epoch-a',
			zoneId: 'shravan',
		});

		await writeGatewayControlSessionMaterial(runtimeDirectory, material);

		const materialPath = resolveGatewayControlSessionMaterialPath(runtimeDirectory);
		const storedMaterialText = await readFile(materialPath, 'utf8');
		expect(storedMaterialText).toContain('BEGIN PRIVATE KEY');
		expect((await stat(materialPath)).mode & 0o777).toBe(0o600);

		const restoredMaterial = await loadGatewayControlSessionMaterial(runtimeDirectory);
		expect(restoredMaterial).not.toBeNull();
		if (restoredMaterial === null) {
			throw new Error('Expected restored gateway control session material.');
		}
		expect(
			buildGatewayControlReadyHeaders({
				material: restoredMaterial,
				now: () => 1,
				requestId: 'ready-request-a',
			}),
		).toEqual(
			buildGatewayControlReadyHeaders({
				material,
				now: () => 1,
				requestId: 'ready-request-a',
			}),
		);
	});

	it('returns null when no host runtime material exists for the zone', async () => {
		const runtimeDirectory = await createRuntimeDirectory();

		await expect(loadGatewayControlSessionMaterial(runtimeDirectory)).resolves.toBeNull();
	});
});
