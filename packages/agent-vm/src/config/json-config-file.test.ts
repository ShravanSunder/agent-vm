import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { loadJsonConfigFile } from './json-config-file.js';

const createdDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		createdDirectories
			.splice(0)
			.map(async (directoryPath) => await fs.rm(directoryPath, { force: true, recursive: true })),
	);
});

async function createTemporaryDirectory(): Promise<string> {
	const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-jsonc-'));
	createdDirectories.push(temporaryDirectory);
	return temporaryDirectory;
}

describe('loadJsonConfigFile', () => {
	it('loads JSONC with comments and trailing commas as unknown data', async () => {
		const temporaryDirectory = await createTemporaryDirectory();
		const configPath = path.join(temporaryDirectory, 'system.jsonc');
		await fs.writeFile(
			configPath,
			[
				'{',
				'  // host-level controller config',
				'  "host": {',
				'    "controllerPort": 18800,',
				'  },',
				'  /* durable paths */',
				'  "runtimeDir": "../runtime",',
				'}',
			].join('\n'),
			'utf8',
		);

		const parsedConfig = await loadJsonConfigFile(configPath);
		const schema = z.object({
			host: z.object({ controllerPort: z.number() }),
			runtimeDir: z.string(),
		});

		expect(schema.parse(parsedConfig)).toEqual({
			host: { controllerPort: 18800 },
			runtimeDir: '../runtime',
		});
	});

	it('reports JSONC parse errors with file and location context', async () => {
		const temporaryDirectory = await createTemporaryDirectory();
		const configPath = path.join(temporaryDirectory, 'broken.jsonc');
		await fs.writeFile(configPath, '{\n  "host":\n}\n', 'utf8');

		await expect(loadJsonConfigFile(configPath)).rejects.toThrow(
			new RegExp(`Invalid JSONC in ${configPath.replaceAll('/', '\\/')}: line 3, column 1:`),
		);
	});
});
