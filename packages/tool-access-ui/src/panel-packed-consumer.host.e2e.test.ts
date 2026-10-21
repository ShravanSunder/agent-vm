import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';
const executeFile = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
// Prerequisite: pnpm build. The consumer is isolated from workspace path aliases and dependencies.
it('packs and imports the browser package, fixture and CSS outside the workspace', async (): Promise<void> => {
	const temporaryRoot = await mkdtemp(path.join(tmpdir(), '2026-10-tool-access-ui-consumer-'));
	try {
		const tarball = path.join(temporaryRoot, 'panel.tgz');
		await executeFile(
			'pnpm',
			['--filter', '@agent-collaboration/tool-access-ui', 'pack', '--out', tarball],
			{ cwd: repositoryRoot },
		);
		await writeFile(
			path.join(temporaryRoot, 'package.json'),
			JSON.stringify({ private: true, type: 'module' }),
		);
		await executeFile('pnpm', ['--dir', temporaryRoot, 'add', '--ignore-scripts', tarball], {
			cwd: repositoryRoot,
		});
		const consumer = await readFile(
			new URL('../contract-fixtures/packed-consumer.ts', import.meta.url),
			'utf8',
		);
		await writeFile(path.join(temporaryRoot, 'consumer.ts'), consumer);
		const result = await executeFile(process.execPath, [path.join(temporaryRoot, 'consumer.ts')], {
			cwd: temporaryRoot,
		});
		expect(result.stdout).toContain('Packed panel + fixture + CSS passed');
	} finally {
		await rm(temporaryRoot, { recursive: true, force: true });
	}
}, 120_000);
