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

function formatMetadataSection(filePath: string, content: string): string {
	return `${filePath} contents:\n${content}`;
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

export async function gatherContext(workDir: string): Promise<RepoContext> {
	const files = await collectFiles(workDir, workDir, 0, 3);
	const claudeMd = await readOptionalFile(join(workDir, 'CLAUDE.md'));
	const packageJson = await readOptionalFile(join(workDir, 'package.json'));
	const repoMetadataLines = files
		.filter((filePath) => filePath.endsWith('CLAUDE.md') || filePath.endsWith('package.json'))
		.slice(0, 20);
	const summarySections = [`Repository structure (${files.length} files):`, files.join('\n')];
	if (repoMetadataLines.length > 0) {
		summarySections.push('', 'Discovered repo metadata files:', repoMetadataLines.join('\n'));
	}
	if (claudeMd) {
		summarySections.push('', formatMetadataSection('CLAUDE.md', claudeMd));
	}
	if (packageJson) {
		summarySections.push('', formatMetadataSection('package.json', packageJson));
	}
	const nestedMetadataSections = await Promise.all(
		repoMetadataLines
			.filter((filePath) => filePath !== 'CLAUDE.md' && filePath !== 'package.json')
			.map(async (filePath): Promise<string | null> => {
				const content = await readOptionalFile(join(workDir, filePath));
				if (!content) {
					return null;
				}
				return formatMetadataSection(filePath, content);
			}),
	);
	for (const section of nestedMetadataSections) {
		if (section) {
			summarySections.push('', section);
		}
	}
	const summary = summarySections.join('\n');

	return {
		fileCount: files.length,
		summary,
		claudeMd,
		packageJson,
	};
}
