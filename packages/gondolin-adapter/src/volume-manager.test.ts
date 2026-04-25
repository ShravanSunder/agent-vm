import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { ensureVolumeDir, resolveVolumeDirs } from './volume-manager.js';

const createdDirectories: string[] = [];

afterEach(() => {
	for (const directoryPath of createdDirectories.splice(0)) {
		fs.rmSync(directoryPath, { recursive: true, force: true });
	}
});

describe('volume-manager', () => {
	test('ensureVolumeDir creates a stable directory path', async () => {
		const cacheBasePath = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-vm-volume-cache-'));
		createdDirectories.push(cacheBasePath);

		const volumeDirectoryPath = await ensureVolumeDir(cacheBasePath, 'workspace-a', 'state');

		expect(volumeDirectoryPath).toBe(path.join(cacheBasePath, 'workspace-a', 'state'));
		expect(fs.existsSync(volumeDirectoryPath)).toBe(true);
	});

	test('resolveVolumeDirs maps named volumes to guest paths', async () => {
		const cacheBasePath = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-vm-volume-map-'));
		createdDirectories.push(cacheBasePath);

		expect(
			await resolveVolumeDirs(cacheBasePath, 'workspace-b', {
				state: { guestPath: '/state' },
				workspace: { guestPath: '/workspace' },
			}),
		).toEqual({
			state: {
				guestPath: '/state',
				hostDir: path.join(cacheBasePath, 'workspace-b', 'state'),
			},
			workspace: {
				guestPath: '/workspace',
				hostDir: path.join(cacheBasePath, 'workspace-b', 'workspace'),
			},
		});
	});
});
