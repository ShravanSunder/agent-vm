import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
	openClawPluginVendorDirectory,
	syncBundledOpenClawPluginBundle,
} from './openclaw-plugin-bundle.js';

const createdDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		createdDirectories
			.splice(0)
			.map(async (directoryPath) => await fs.rm(directoryPath, { force: true, recursive: true })),
	);
});

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function createTemporaryDirectory(prefix: string): Promise<string> {
	const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	createdDirectories.push(temporaryDirectory);
	return temporaryDirectory;
}

describe('syncBundledOpenClawPluginBundle', () => {
	it('replaces an existing plugin directory instead of layering over stale files', async () => {
		const targetDirectory = await createTemporaryDirectory('agent-vm-plugin-target-');
		const pluginTargetDirectory = path.join(
			targetDirectory,
			openClawPluginVendorDirectory('openclaw-heavy'),
		);
		await fs.mkdir(pluginTargetDirectory, { recursive: true });
		await fs.writeFile(path.join(pluginTargetDirectory, 'openclaw.plugin.json'), '{"id":"old"}\n');
		await fs.writeFile(path.join(pluginTargetDirectory, 'stale-file.txt'), 'stale\n');

		const pluginDistDirectory = await createTemporaryDirectory('agent-vm-plugin-dist-');
		await fs.writeFile(path.join(pluginDistDirectory, 'openclaw.plugin.json'), '{"id":"new"}\n');
		await fs.writeFile(path.join(pluginDistDirectory, 'fresh-file.txt'), 'fresh\n');

		await syncBundledOpenClawPluginBundle(targetDirectory, 'openclaw-heavy', {
			resolveBundledDistDirectory: async () => pluginDistDirectory,
		});

		await expect(
			fs.readFile(path.join(pluginTargetDirectory, 'openclaw.plugin.json'), 'utf8'),
		).resolves.toBe('{"id":"new"}\n');
		await expect(
			fs.readFile(path.join(pluginTargetDirectory, 'fresh-file.txt'), 'utf8'),
		).resolves.toBe('fresh\n');
		await expect(pathExists(path.join(pluginTargetDirectory, 'stale-file.txt'))).resolves.toBe(
			false,
		);
	});

	it('surfaces cleanup failures instead of silently continuing with stale contents', async () => {
		const targetDirectory = await createTemporaryDirectory('agent-vm-plugin-error-');
		const pluginTargetDirectory = path.join(
			targetDirectory,
			openClawPluginVendorDirectory('openclaw'),
		);
		await fs.mkdir(pluginTargetDirectory, { recursive: true });
		await fs.writeFile(path.join(pluginTargetDirectory, 'openclaw.plugin.json'), '{"id":"old"}\n');

		await expect(
			syncBundledOpenClawPluginBundle(targetDirectory, 'openclaw', {
				removeDirectory: async () => {
					throw new Error('permission denied');
				},
				resolveBundledDistDirectory: async () => '/tmp/unused-plugin-dist',
			}),
		).rejects.toThrow('permission denied');
	});
});
