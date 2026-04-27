import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { findPackageJsonPathFromStart } from '../build/runtime-versions.js';

const packageVersionJsonSchema = z.object({
	version: z.string().min(1),
});

export async function resolveCliVersion(
	startPath: string = fileURLToPath(import.meta.url),
): Promise<string> {
	const packageJsonPath = await findPackageJsonPathFromStart(startPath);
	try {
		const packageJson = packageVersionJsonSchema.parse(
			JSON.parse(await fs.readFile(packageJsonPath, 'utf8')),
		);
		return packageJson.version;
	} catch (error) {
		throw new Error(
			`Failed to read CLI package version from ${packageJsonPath}: ${
				error instanceof Error ? error.message : String(error)
			}`,
			{ cause: error },
		);
	}
}
