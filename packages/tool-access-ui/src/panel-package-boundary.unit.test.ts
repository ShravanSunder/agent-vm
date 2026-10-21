import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
const sourceRoot = fileURLToPath(new URL('.', import.meta.url));
async function productionSources(directory: string): Promise<readonly string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	return (
		await Promise.all(
			entries.map(async (entry): Promise<readonly string[]> => {
				const target = `${directory}/${entry.name}`;
				if (entry.isDirectory()) return await productionSources(target);
				return /\.(ts|tsx)$/.test(entry.name) && !entry.name.includes('.test.') ? [target] : [];
			}),
		)
	).flat();
}
export function forbiddenPanelImport(specifier: string): boolean {
	return !/^(?:@tool-access-ui\/|@base-ui\/react\/|react(?:-dom)?(?:\/|$)|lucide-react$|sonner$|next-themes$|class-variance-authority$|cn$)/.test(
		specifier,
	);
}
describe('panel package boundary', (): void => {
	it('keeps production imports within React, the registry and panel views', async (): Promise<void> => {
		const sources = await productionSources(sourceRoot);
		expect(sources.length).toBeGreaterThan(10);
		const contents = await Promise.all(
			sources.map((sourcePath): Promise<string> => readFile(sourcePath, 'utf8')),
		);
		for (const source of contents) {
			for (const match of source.matchAll(/(?:from\s+|import\s*\()\s*['"]([^'"]+)['"]/g))
				expect(forbiddenPanelImport(match[1] ?? '')).toBe(false);
			expect(source).not.toMatch(
				/\b(?:fetch\s*\(|process\.env|localStorage\.|sessionStorage\.|document\.cookie\s*=)/,
			);
		}
	});
	it('rejects host, credentials and Node dependencies, including type-only specifiers', (): void => {
		for (const specifier of [
			'node:fs',
			'fs',
			'@agent-vm/agent-vm',
			'@agent-collaboration/tool-host-node',
			'@agent-vm/secret-management',
		])
			expect(forbiddenPanelImport(specifier)).toBe(true);
		expect(forbiddenPanelImport('react')).toBe(false);
		expect(forbiddenPanelImport('@tool-access-ui/panel-state/models/panel-view-types')).toBe(false);
	});
});
