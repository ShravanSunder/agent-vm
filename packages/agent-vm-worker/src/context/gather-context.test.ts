import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { gatherContext, readOptionalFile } from './gather-context.js';

describe('gather-context', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'context-test-'));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	describe('readOptionalFile', () => {
		it('reads existing file', async () => {
			await writeFile(join(tempDir, 'test.txt'), 'hello', 'utf-8');
			expect(await readOptionalFile(join(tempDir, 'test.txt'))).toBe('hello');
		});

		it('returns null for missing file', async () => {
			await expect(readOptionalFile(join(tempDir, 'missing.txt'))).resolves.toBeNull();
		});
	});

	describe('gatherContext', () => {
		it('gathers file tree and reads metadata', async () => {
			await writeFile(join(tempDir, 'package.json'), '{"name":"test"}', 'utf-8');
			await writeFile(join(tempDir, 'CLAUDE.md'), '# Project', 'utf-8');
			await mkdir(join(tempDir, 'src'), { recursive: true });
			await writeFile(join(tempDir, 'src', 'index.ts'), 'export {};', 'utf-8');

			const context = await gatherContext(tempDir);

			expect(context.fileCount).toBeGreaterThanOrEqual(3);
			expect(context.summary).toContain('src/index.ts');
			expect(context.packageJson).toContain('test');
			expect(context.claudeMd).toContain('Project');
		});

		it('skips node_modules and .git', async () => {
			await mkdir(join(tempDir, 'node_modules', 'pkg'), { recursive: true });
			await writeFile(join(tempDir, 'node_modules', 'pkg', 'index.js'), 'ignored', 'utf-8');
			await mkdir(join(tempDir, '.git'), { recursive: true });
			await writeFile(join(tempDir, '.git', 'config'), 'ignored', 'utf-8');
			await writeFile(join(tempDir, 'README.md'), 'hello', 'utf-8');

			const context = await gatherContext(tempDir);

			expect(context.summary).toContain('README.md');
			expect(context.summary).not.toContain('node_modules');
			expect(context.summary).not.toContain('.git');
		});

		it('includes repo-local metadata files from nested repos', async () => {
			await mkdir(join(tempDir, 'frontend', '.agent-vm'), { recursive: true });
			await mkdir(join(tempDir, 'backend', '.agent-vm'), { recursive: true });
			await writeFile(join(tempDir, 'frontend', 'package.json'), '{"name":"frontend"}', 'utf-8');
			await writeFile(join(tempDir, 'backend', 'CLAUDE.md'), '# Backend Repo', 'utf-8');

			const context = await gatherContext(tempDir);

			expect(context.summary).toContain('frontend/package.json');
			expect(context.summary).toContain('backend/CLAUDE.md');
			expect(context.summary).toContain('Discovered repo metadata files:');
		});
	});
});
