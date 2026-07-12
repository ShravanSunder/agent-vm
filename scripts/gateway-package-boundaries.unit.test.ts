import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repositoryRoot = process.cwd();

async function collectTypeScriptFiles(directoryPath: string): Promise<readonly string[]> {
	const directoryEntries = await readdir(directoryPath, { withFileTypes: true });
	const nestedFiles = await Promise.all(
		directoryEntries.map(async (directoryEntry): Promise<readonly string[]> => {
			const entryPath = path.join(directoryPath, directoryEntry.name);
			if (directoryEntry.isDirectory()) {
				return await collectTypeScriptFiles(entryPath);
			}
			return directoryEntry.isFile() && entryPath.endsWith('.ts') ? [entryPath] : [];
		}),
	);
	return nestedFiles.flat();
}

describe('gateway package boundaries', () => {
	it('keeps gateway-contracts independent of Gondolin integration', async () => {
		const packageDirectory = path.join(repositoryRoot, 'packages/gateway-contracts');
		const packageManifest = JSON.parse(
			await readFile(path.join(packageDirectory, 'package.json'), 'utf8'),
		) as { readonly dependencies?: Readonly<Record<string, string>> };
		const sourceFiles = await collectTypeScriptFiles(path.join(packageDirectory, 'src'));
		const sourceText = (
			await Promise.all(sourceFiles.map(async (filePath) => await readFile(filePath, 'utf8')))
		).join('\n');

		expect(packageManifest.dependencies).not.toHaveProperty('@agent-vm/gondolin-adapter');
		expect(packageManifest.dependencies).not.toHaveProperty('@agent-vm/gondolin-gateway-types');
		expect(sourceText).not.toContain('@agent-vm/gondolin-adapter');
		expect(sourceText).not.toContain('@agent-vm/gondolin-gateway-types');
		expect(sourceText).not.toContain('ManagedVm');
	});

	it('isolates Gondolin gateway integration imports to the owning packages', async () => {
		const packagesDirectory = path.join(repositoryRoot, 'packages');
		const packageEntries = await readdir(packagesDirectory, { withFileTypes: true });
		const packageImportOwners = await Promise.all(
			packageEntries.map(async (packageEntry): Promise<string | undefined> => {
				if (!packageEntry.isDirectory()) return undefined;
				const sourceDirectory = path.join(packagesDirectory, packageEntry.name, 'src');
				let sourceFiles: readonly string[];
				try {
					sourceFiles = await collectTypeScriptFiles(sourceDirectory);
				} catch {
					return undefined;
				}
				const sourceText = (
					await Promise.all(sourceFiles.map(async (filePath) => await readFile(filePath, 'utf8')))
				).join('\n');
				return sourceText.includes('@agent-vm/gondolin-gateway-types')
					? packageEntry.name
					: undefined;
			}),
		);
		const importingPackages = packageImportOwners.filter(
			(packageName): packageName is string => packageName !== undefined,
		);

		expect(importingPackages.toSorted()).toEqual([
			'agent-vm',
			'openclaw-gateway',
			'worker-gateway',
		]);
	});

	it('does not expose internal lease manager types from the agent-vm root', async () => {
		const publicIndex = await readFile(
			path.join(repositoryRoot, 'packages/agent-vm/src/index.ts'),
			'utf8',
		);

		expect(publicIndex).not.toContain("export * from './controller/leases/lease-manager.js'");
	});
});
