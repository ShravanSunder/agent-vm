import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
	initRepoResources,
	updateRepoResources,
	validateRepoResources,
} from './resources-commands.js';

describe('repo resource commands', () => {
	it('scaffolds repo resource files using the current contract names', async () => {
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-init-'));
		const result = await initRepoResources({ targetDir });

		expect(result.created).toEqual(
			expect.arrayContaining([
				'.agent-vm/repo-resources.ts',
				'.agent-vm/repo-resources.d.ts',
				'.agent-vm/run-setup.sh',
				'.agent-vm/docker-compose.yml',
				'.agent-vm/AGENTS.md',
				'.agent-vm/README.md',
			]),
		);
		await expect(
			fs.access(path.join(targetDir, '.agent-vm', 'resources-post-hook.ts')),
		).rejects.toThrow(/ENOENT/u);
	});

	it('generates repo-facing docs with CLI installation and update guidance', async () => {
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-docs-'));

		await initRepoResources({ targetDir });

		const readme = await fs.readFile(path.join(targetDir, '.agent-vm', 'README.md'), 'utf8');
		const agents = await fs.readFile(path.join(targetDir, '.agent-vm', 'AGENTS.md'), 'utf8');
		expect(readme).toContain('pnpm -g install @agent-vm/agent-vm');
		expect(readme).toContain('agent-vm resources update');
		expect(agents).toContain('pnpm -g install @agent-vm/agent-vm');
		expect(agents).toContain('Run agent-vm resources update');
	});

	it('does not overwrite user-owned files when init is rerun', async () => {
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-init-rerun-'));
		await initRepoResources({ targetDir });
		await fs.writeFile(
			path.join(targetDir, '.agent-vm', 'repo-resources.ts'),
			'export const custom = true;\n',
			'utf8',
		);

		const result = await initRepoResources({ targetDir });

		await expect(
			fs.readFile(path.join(targetDir, '.agent-vm', 'repo-resources.ts'), 'utf8'),
		).resolves.toBe('export const custom = true;\n');
		expect(result.skipped).toContain('.agent-vm/repo-resources.ts');
	});

	it('updates only generated declaration and docs files', async () => {
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-update-'));
		await initRepoResources({ targetDir });
		await fs.writeFile(
			path.join(targetDir, '.agent-vm', 'run-setup.sh'),
			'#!/usr/bin/env bash\necho custom\n',
			'utf8',
		);

		const result = await updateRepoResources({ targetDir });

		expect(result.updated).toEqual([
			'.agent-vm/repo-resources.d.ts',
			'.agent-vm/AGENTS.md',
			'.agent-vm/README.md',
		]);
		await expect(
			fs.readFile(path.join(targetDir, '.agent-vm', 'run-setup.sh'), 'utf8'),
		).resolves.toBe('#!/usr/bin/env bash\necho custom\n');
	});

	it('validates current repo resource files and rejects stale resource hook files', async () => {
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-validate-'));
		await initRepoResources({ targetDir });

		await expect(validateRepoResources({ targetDir })).resolves.toMatchObject({
			valid: true,
		});

		await fs.writeFile(
			path.join(targetDir, '.agent-vm', 'resources-post-hook.ts'),
			'export {};\n',
			'utf8',
		);
		await expect(validateRepoResources({ targetDir })).rejects.toThrow(/resources-post-hook/u);
	});
});
