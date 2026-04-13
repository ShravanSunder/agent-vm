import * as fs from 'node:fs/promises';
import { join, relative } from 'node:path';

export interface RepoContext {
	readonly fileCount: number;
	readonly summary: string;
	readonly claudeMd: string | null;
	readonly packageJson: string | null;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);

async function collectFiles(
	dir: string,
	baseDir: string,
	depth: number,
	maxDepth: number,
): Promise<string[]> {
	if (depth > maxDepth) return [];

	const entries = await fs.readdir(dir, { withFileTypes: true });
	const nested = await Promise.all(
		entries
			.filter((entry) => !SKIP_DIRS.has(entry.name))
			.map(async (entry) => {
				const fullPath = join(dir, entry.name);
				if (entry.isDirectory()) {
					return await collectFiles(fullPath, baseDir, depth + 1, maxDepth);
				}
				return [relative(baseDir, fullPath)];
			}),
	);

	return nested.flat();
}

export async function readOptionalFile(filePath: string): Promise<string | null> {
	try {
		return await fs.readFile(filePath, 'utf-8');
	} catch (error) {
		if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
			return null;
		}
		throw error;
	}
}

export async function gatherContext(workspaceDir: string): Promise<RepoContext> {
	const files = await collectFiles(workspaceDir, workspaceDir, 0, 3);
	const claudeMd = await readOptionalFile(join(workspaceDir, 'CLAUDE.md'));
	const packageJson = await readOptionalFile(join(workspaceDir, 'package.json'));
	const summary = `Repository structure (${files.length} files):\n${files.join('\n')}`;

	return {
		fileCount: files.length,
		summary,
		claudeMd,
		packageJson,
	};
}
