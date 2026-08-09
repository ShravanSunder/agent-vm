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

describe('syncBundledOpenClawPluginBundle integration', () => {
	it('resolves the built plugin dist when the workspace entrypoint resolves to source', async () => {
		const targetDirectory = await fs.mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-plugin-default-resolver-'),
		);
		createdDirectories.push(targetDirectory);

		await syncBundledOpenClawPluginBundle(targetDirectory, 'openclaw');

		await expect(
			fs.access(
				path.join(
					targetDirectory,
					openClawPluginVendorDirectory('openclaw'),
					'openclaw.plugin.json',
				),
			),
		).resolves.toBeUndefined();
	});
});
