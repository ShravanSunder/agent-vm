/* oxlint-disable eslint/no-await-in-loop -- smoke polling must be sequential against live services */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { SecretRef, SecretResolver } from '@agent-vm/secret-management';
import { afterAll, describe, expect, it } from 'vitest';

import { executeWorkerTask, prepareWorkerTask } from '../controller/worker-task-runner.js';
import {
	currentE2eArchitecture,
	prepareGatewayE2eProjectImages,
	prepareLocalWorkerPackageForGatewayImage,
	removeE2eLocalPackageTarballs,
	removeE2eTempRoot,
	scaffoldWorkerE2eProject,
	shouldRunWorkerGatewayE2e,
	startE2eControllerRuntime,
	type E2eHarnessRuntime,
	type WorkerE2eProject,
} from './e2e-harness.js';

const architecture = currentE2eArchitecture();
const runWorkerE2e = await shouldRunWorkerGatewayE2e({ architecture });

const describeWorkerE2e = runWorkerE2e ? describe : describe.skip;

async function createSampleRepo(baseDir: string): Promise<string> {
	const repoDir = path.join(baseDir, 'sample-repo');
	await fs.mkdir(path.join(repoDir, '.agent-vm'), { recursive: true });
	await fs.mkdir(path.join(repoDir, 'scripts'), { recursive: true });
	await fs.writeFile(path.join(repoDir, 'package.json'), JSON.stringify({ name: 'sample-repo' }));
	await fs.writeFile(
		path.join(repoDir, '.agent-vm', 'config.json'),
		JSON.stringify({
			verification: [{ name: 'verify', command: 'bash scripts/verify.sh' }],
		}),
	);
	await fs.writeFile(
		path.join(repoDir, 'scripts', 'verify.sh'),
		'#!/usr/bin/env bash\nset -euo pipefail\ntest -f READY.txt\ngrep -q "^READY$" READY.txt\n',
		{ mode: 0o755 },
	);

	execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'pipe' });
	execFileSync('git', ['config', 'user.email', 'smoke@example.com'], {
		cwd: repoDir,
		stdio: 'pipe',
	});
	execFileSync('git', ['config', 'user.name', 'smoke-test'], { cwd: repoDir, stdio: 'pipe' });
	execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repoDir, stdio: 'pipe' });
	execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
	execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-m', 'init'], {
		cwd: repoDir,
		stdio: 'pipe',
	});

	return repoDir;
}

describeWorkerE2e('e2e: real agent-vm-worker loop', () => {
	let harness: E2eHarnessRuntime | undefined;
	let localWorkerTarballPath: string | undefined;
	let project: WorkerE2eProject | undefined;

	afterAll(async () => {
		try {
			await harness?.close();
		} finally {
			await Promise.all([
				project ? removeE2eTempRoot(project.tempRoot) : Promise.resolve(),
				removeE2eLocalPackageTarballs([localWorkerTarballPath]),
			]);
		}
	});

	it('runs a real worker task to completed through the controller route', async () => {
		const repoRoot = path.resolve(process.cwd());

		project = await scaffoldWorkerE2eProject({
			architecture,
			prefix: 'worker-loop-e2e-',
			zoneId: 'worker-e2e',
		});
		const repoDir = await createSampleRepo(project.tempRoot);
		await prepareGatewayE2eProjectImages({ project });
		localWorkerTarballPath = await prepareLocalWorkerPackageForGatewayImage(repoRoot);

		project.zone.egressHosts = [
			...project.zone.egressHosts,
			{ host: 'github.com', audience: 'gateway' },
		];

		await fs.writeFile(
			project.zone.gateway.config,
			JSON.stringify({
				runtimeInstructions: 'Smoke test runtime instructions.',
				defaults: { provider: 'codex', model: 'gpt-5.4-mini' },
				phases: {
					plan: {
						skills: [],
						cycle: { kind: 'noReview' },
						agentInstructions: null,
						reviewerInstructions: null,
					},
					work: {
						skills: [],
						cycle: { kind: 'review', cycleCount: 1 },
						agentInstructions: null,
						reviewerInstructions: null,
					},
					wrapup: { skills: [], instructions: null },
				},
				mcpServers: [],
				verification: [{ name: 'verify', command: 'bash scripts/verify.sh' }],
				branchPrefix: 'agent/',
				stateDir: '/state',
			}),
		);
		const previousLocalWorkerTarballPath = process.env.AGENT_VM_WORKER_TARBALL_PATH;
		process.env.AGENT_VM_WORKER_TARBALL_PATH = localWorkerTarballPath;
		try {
			const secretResolver: SecretResolver = {
				resolve: async (_ref: SecretRef) => process.env.AGENT_VM_TEST_OPENAI_API_KEY ?? '',
				resolveAll: async (refs: Record<string, SecretRef>) =>
					Object.fromEntries(
						Object.keys(refs).map((key) => [key, process.env.AGENT_VM_TEST_OPENAI_API_KEY ?? '']),
					),
			};
			harness = await startE2eControllerRuntime({
				secrets: {
					AGENT_VM_TEST_OPENAI_API_KEY: process.env.AGENT_VM_TEST_OPENAI_API_KEY ?? '',
					'op://agent-vm/github-token/credential': process.env.AGENT_VM_TEST_OPENAI_API_KEY ?? '',
				},
				startOptions: {
					systemConfig: project.systemConfig,
					zoneIds: ['worker-e2e'],
				},
			});
			const repoUrl = pathToFileURL(repoDir).href;

			const prepared = await prepareWorkerTask({
				input: {
					requestTaskId: 'request-worker-e2e',
					prompt: 'Create a file named READY.txt in the repository root containing exactly READY.',
					repos: [{ repoUrl, baseBranch: 'main' }],
					context: { source: 'smoke-test' },
				},
				systemConfig: project.systemConfig,
				zoneId: 'worker-e2e',
			});
			const result = await executeWorkerTask(prepared, {
				secretResolver,
				systemConfig: project.systemConfig,
			});
			expect(result.taskId).toBeTruthy();
			const finalState = result.finalState as { readonly status?: string | undefined };
			if (finalState.status !== 'completed') {
				throw new Error(
					`Worker smoke task ended in ${finalState.status ?? 'unknown'}: ${JSON.stringify(result.finalState)}`,
				);
			}
		} finally {
			if (previousLocalWorkerTarballPath === undefined) {
				delete process.env.AGENT_VM_WORKER_TARBALL_PATH;
			} else {
				process.env.AGENT_VM_WORKER_TARBALL_PATH = previousLocalWorkerTarballPath;
			}
		}
	}, 900_000);
});
