import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
	finalizeRepoResourceSetupInSubprocess,
	loadRepoResourceDescriptionContract,
} from './repo-resource-contract-loader.js';

describe('repo resource contract loader', () => {
	it('returns an empty description contract when repo-resources.ts is missing', async () => {
		const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-resource-missing-'));
		const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

		try {
			const description = await loadRepoResourceDescriptionContract({
				repoDir,
				repoId: 'repo-a',
				repoUrl: 'https://github.com/example/repo-a.git',
			});

			expect(description).toEqual({
				setupCommand: '.agent-vm/run-setup.sh',
				requires: {},
				provides: {},
			});
			expect(stderrSpy).toHaveBeenCalledWith(
				expect.stringContaining(
					'[repo-resource-contract-loader] repo-a: no .agent-vm/repo-resources.ts; treating repo resources as empty.',
				),
			);
		} finally {
			stderrSpy.mockRestore();
		}
	});

	it('loads describeRepoResources from repo TypeScript in a Node subprocess', async () => {
		const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-resource-load-'));
		await fs.mkdir(path.join(repoDir, '.agent-vm'), { recursive: true });
		await fs.writeFile(
			path.join(repoDir, '.agent-vm', 'repo-resources.ts'),
			`
export function describeRepoResources(): RepoResourcesDescription {
\treturn {
\t\trequires: {
\t\t\tpg: { binding: { host: 'pg.local', port: 5432 }, env: {} },
\t\t},
\t\tprovides: {
\t\t\tpg: { type: 'compose', service: 'pg' },
\t\t},
\t};
}
`,
			'utf8',
		);

		const description = await loadRepoResourceDescriptionContract({
			repoDir,
			repoId: 'repo-a',
			repoUrl: 'https://github.com/example/repo-a.git',
		});

		expect(description.provides.pg?.service).toBe('pg');
	});

	it('runs finalizeRepoResourceSetup with selected resources and validates the final schema', async () => {
		const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-resource-finalize-'));
		const outputDir = path.join(repoDir, 'resource-output');
		await fs.mkdir(path.join(repoDir, '.agent-vm'), { recursive: true });
		await fs.writeFile(
			path.join(repoDir, '.agent-vm', 'repo-resources.ts'),
			`
export function describeRepoResources(): RepoResourcesDescription {
\treturn { requires: {}, provides: {} };
}

export async function finalizeRepoResourceSetup(
\tinput: FinalizeRepoResourceSetupInput,
): Promise<RepoResourcesFinal> {
\treturn {
\t\tresources: Object.fromEntries(
\t\t\tObject.entries(input.selectedResources).map(([name, resource]) => [
\t\t\t\tname,
\t\t\t\t{
\t\t\t\t\tbinding: resource.binding,
\t\t\t\t\ttarget: resource.target,
\t\t\t\t\tenv: { DATABASE_URL: \`postgres://\${resource.binding.host}:\${resource.binding.port}/app\` },
\t\t\t\t},
\t\t\t]),
\t\t),
\t\tgenerated: [{ kind: 'directory', path: 'unstructured' }],
\t};
}
`,
			'utf8',
		);

		const final = await finalizeRepoResourceSetupInSubprocess({
			repoDir,
			input: {
				repoId: 'repo-a',
				repoUrl: 'https://github.com/example/repo-a.git',
				repoDir,
				outputDir,
				selectedResources: {
					pg: {
						binding: { host: 'pg.local', port: 5432 },
						target: { host: '172.30.0.5', port: 5432 },
					},
				},
			},
		});

		expect(final.resources.pg?.env.DATABASE_URL).toBe('postgres://pg.local:5432/app');
		expect(final.generated).toEqual([{ kind: 'directory', path: 'unstructured' }]);
	});

	it('does not inherit controller secrets into repo contract subprocesses', async () => {
		const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-resource-env-'));
		await fs.mkdir(path.join(repoDir, '.agent-vm'), { recursive: true });
		await fs.writeFile(
			path.join(repoDir, '.agent-vm', 'repo-resources.ts'),
			`
export function describeRepoResources(): RepoResourcesDescription {
\tif (process.env.AGENT_VM_SECRET_LEAK_TEST) {
\t\tthrow new Error('controller env leaked into repo contract');
\t}
\treturn { requires: {}, provides: {} };
}
`,
			'utf8',
		);
		process.env.AGENT_VM_SECRET_LEAK_TEST = 'do-not-leak';
		try {
			await expect(
				loadRepoResourceDescriptionContract({
					repoDir,
					repoId: 'repo-a',
					repoUrl: 'https://github.com/example/repo-a.git',
				}),
			).resolves.toEqual({
				setupCommand: '.agent-vm/run-setup.sh',
				requires: {},
				provides: {},
			});
		} finally {
			delete process.env.AGENT_VM_SECRET_LEAK_TEST;
		}
	});

	it('fails loudly when a repo contract subprocess produces no JSON stdout', async () => {
		const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-resource-empty-'));
		await fs.mkdir(path.join(repoDir, '.agent-vm'), { recursive: true });
		await fs.writeFile(
			path.join(repoDir, '.agent-vm', 'repo-resources.ts'),
			`
export function describeRepoResources(): RepoResourcesDescription {
\tprocess.exit(0);
}
`,
			'utf8',
		);

		await expect(
			loadRepoResourceDescriptionContract({
				repoDir,
				repoId: 'repo-a',
				repoUrl: 'https://github.com/example/repo-a.git',
			}),
		).rejects.toThrow(/produced no stdout/u);
	});

	it('includes repo contract subprocess stderr in load failures', async () => {
		const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-resource-stderr-'));
		await fs.mkdir(path.join(repoDir, '.agent-vm'), { recursive: true });
		await fs.writeFile(
			path.join(repoDir, '.agent-vm', 'repo-resources.ts'),
			`
export function describeRepoResources(): RepoResourcesDescription {
\tconsole.error('schema build exploded');
\tprocess.exit(1);
}
`,
			'utf8',
		);

		await expect(
			loadRepoResourceDescriptionContract({
				repoDir,
				repoId: 'repo-a',
				repoUrl: 'https://github.com/example/repo-a.git',
			}),
		).rejects.toThrow(/schema build exploded/u);
	});
});
