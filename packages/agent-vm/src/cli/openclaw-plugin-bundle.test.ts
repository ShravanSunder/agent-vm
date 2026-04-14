import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
	openClawPluginVendorDirectory,
	syncBundledOpenClawPluginBundle,
} from './openclaw-plugin-bundle.js';

const createdDirectories: string[] = [];

afterEach(() => {
	for (const directoryPath of createdDirectories.splice(0)) {
		fs.rmSync(directoryPath, { force: true, recursive: true });
	}
});

function createTemporaryDirectory(prefix: string): string {
	const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	createdDirectories.push(temporaryDirectory);
	return temporaryDirectory;
}

describe('syncBundledOpenClawPluginBundle', () => {
	it('replaces an existing plugin directory instead of layering over stale files', async () => {
		const targetDirectory = createTemporaryDirectory('agent-vm-plugin-target-');
		const pluginTargetDirectory = path.join(targetDirectory, openClawPluginVendorDirectory);
		fs.mkdirSync(pluginTargetDirectory, { recursive: true });
		fs.writeFileSync(path.join(pluginTargetDirectory, 'openclaw.plugin.json'), '{"id":"old"}\n');
		fs.writeFileSync(path.join(pluginTargetDirectory, 'stale-file.txt'), 'stale\n');

		const pluginDistDirectory = createTemporaryDirectory('agent-vm-plugin-dist-');
		fs.writeFileSync(path.join(pluginDistDirectory, 'openclaw.plugin.json'), '{"id":"new"}\n');
		fs.writeFileSync(path.join(pluginDistDirectory, 'fresh-file.txt'), 'fresh\n');

		await syncBundledOpenClawPluginBundle(targetDirectory, {
			resolveBundledDistDirectory: async () => pluginDistDirectory,
		});

		expect(fs.readFileSync(path.join(pluginTargetDirectory, 'openclaw.plugin.json'), 'utf8')).toBe(
			'{"id":"new"}\n',
		);
		expect(fs.readFileSync(path.join(pluginTargetDirectory, 'fresh-file.txt'), 'utf8')).toBe(
			'fresh\n',
		);
		expect(fs.existsSync(path.join(pluginTargetDirectory, 'stale-file.txt'))).toBe(false);
	});

	it('surfaces cleanup failures instead of silently continuing with stale contents', async () => {
		const targetDirectory = createTemporaryDirectory('agent-vm-plugin-error-');
		const pluginTargetDirectory = path.join(targetDirectory, openClawPluginVendorDirectory);
		fs.mkdirSync(pluginTargetDirectory, { recursive: true });
		fs.writeFileSync(path.join(pluginTargetDirectory, 'openclaw.plugin.json'), '{"id":"old"}\n');

		await expect(
			syncBundledOpenClawPluginBundle(targetDirectory, {
				removeDirectory: async () => {
					throw new Error('permission denied');
				},
				resolveBundledDistDirectory: async () => '/tmp/unused-plugin-dist',
			}),
		).rejects.toThrow('permission denied');
	});
});
