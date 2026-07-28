import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const packageRoot = path.resolve(import.meta.dirname, '..');
const forbiddenProductionDependencyPattern =
	/^@agent-vm\/(?:agent-portal-sdk|agent-vm|gateway-runtime|gondolin|managed-vm)|^@earendil-works|^(?:paramiko|ssh2)$/u;
const importSpecifierPattern = /(?:\bfrom\s+|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/gu;

async function collectProductionTypeScriptFiles(directoryPath: string): Promise<readonly string[]> {
	const directoryEntries = await readdir(directoryPath, { withFileTypes: true });
	const nestedFiles = await Promise.all(
		directoryEntries.map(async (directoryEntry): Promise<readonly string[]> => {
			const entryPath = path.join(directoryPath, directoryEntry.name);
			if (directoryEntry.isDirectory()) {
				return await collectProductionTypeScriptFiles(entryPath);
			}
			if (directoryEntry.isFile() && directoryEntry.name.endsWith('.ts')) {
				return directoryEntry.name.endsWith('.unit.test.ts') ? [] : [entryPath];
			}
			return [];
		}),
	);
	return nestedFiles.flat();
}

describe('Hermes Gateway package boundary', () => {
	it('has only the neutral Gateway lifecycle runtime dependency', async () => {
		const packageJson = JSON.parse(
			await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
		) as {
			readonly dependencies?: Readonly<Record<string, string>>;
			readonly name?: string;
		};

		expect(packageJson.name).toBe('@agent-vm/hermes-gateway');
		expect(packageJson.dependencies).toEqual({
			'@agent-vm/gateway-lifecycle': 'workspace:*',
		});
	});

	it('has no controller, runtime, VM-adapter, local-execution, or SSH import', async () => {
		const sourceFiles = await collectProductionTypeScriptFiles(path.join(packageRoot, 'src'));
		const forbiddenImports = (
			await Promise.all(
				sourceFiles.map(async (sourceFile): Promise<string | undefined> => {
					const source = await readFile(sourceFile, 'utf8');
					const importSpecifiers = [...source.matchAll(importSpecifierPattern)].map(
						(importMatch) => importMatch[1],
					);
					return importSpecifiers.some((importSpecifier) =>
						forbiddenProductionDependencyPattern.test(importSpecifier ?? ''),
					)
						? sourceFile
						: undefined;
				}),
			)
		).filter((sourceFile): sourceFile is string => sourceFile !== undefined);

		expect(forbiddenImports).toEqual([]);
	});
});
