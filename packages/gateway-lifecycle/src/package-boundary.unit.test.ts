import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const packageRoot = path.resolve(import.meta.dirname, '..');
const oldPackageRoot = path.resolve(packageRoot, '../gateway-interface');
const forbiddenProductionDependencyPattern =
	/@agent-vm\/(?:agent-vm|gondolin(?:-vm)?-adapter)|@earendil-works\/gondolin/u;

async function collectTypeScriptFiles(directoryPath: string): Promise<readonly string[]> {
	const directoryEntries = await readdir(directoryPath, { withFileTypes: true });
	const nestedFiles = await Promise.all(
		directoryEntries.map(async (directoryEntry): Promise<readonly string[]> => {
			const entryPath = path.join(directoryPath, directoryEntry.name);
			if (directoryEntry.isDirectory()) {
				return await collectTypeScriptFiles(entryPath);
			}
			if (directoryEntry.isFile() && directoryEntry.name.endsWith('.ts')) {
				return [entryPath];
			}
			return [];
		}),
	);
	return nestedFiles.flat();
}

describe('gateway lifecycle package boundary', () => {
	it('has physically removed the old package', async () => {
		await expect(access(oldPackageRoot)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('depends on managed-vm without a concrete adapter or controller dependency', async () => {
		const packageJson = JSON.parse(
			await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
		) as {
			readonly dependencies?: Readonly<Record<string, string>>;
			readonly name?: string;
		};

		expect(packageJson.name).toBe('@agent-vm/gateway-lifecycle');
		expect(packageJson.dependencies).toHaveProperty('@agent-vm/managed-vm', 'workspace:*');
		expect(Object.keys(packageJson.dependencies ?? {})).not.toContain('@agent-vm/gondolin-adapter');
		expect(Object.keys(packageJson.dependencies ?? {})).not.toContain(
			'@agent-vm/gondolin-vm-adapter',
		);
		expect(Object.keys(packageJson.dependencies ?? {})).not.toContain('@agent-vm/agent-vm');
	});

	it('contains no production import of concrete VM or controller packages', async () => {
		const sourceFiles = (await collectTypeScriptFiles(path.join(packageRoot, 'src'))).filter(
			(sourceFile) => !sourceFile.endsWith('.unit.test.ts'),
		);
		const forbiddenImports = (
			await Promise.all(
				sourceFiles.map(async (sourceFile): Promise<string | undefined> => {
					const source = await readFile(sourceFile, 'utf8');
					return forbiddenProductionDependencyPattern.test(source) ? sourceFile : undefined;
				}),
			)
		).filter((sourceFile): sourceFile is string => sourceFile !== undefined);

		expect(forbiddenImports).toEqual([]);
	});
});
