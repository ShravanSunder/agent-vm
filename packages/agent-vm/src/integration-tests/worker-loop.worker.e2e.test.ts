/* oxlint-disable eslint/no-await-in-loop -- smoke polling must be sequential against live services */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { SecretRef, SecretResolver } from '@agent-vm/secret-management';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod/v4';

import { createManagedVmRuntimeComposition } from '../composition/gondolin-managed-vm-provider.js';
import type { WorkerControlRpcOperations } from '../controller/control-session/worker-control-domain-handler.js';
import { executeWorkerTask, prepareWorkerTask } from '../controller/worker-task-runner.js';
import {
	currentE2eArchitecture,
	prepareGatewayE2eProjectImages,
	prepareLocalWorkerPackageSetForGatewayImage,
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
const scriptedE2eExecutorEnvName = 'AGENT_VM_WORKER_SCRIPTED_E2E_EXECUTOR';
const scriptedE2eExecutorProvider = 'scripted-e2e';
const workerE2eFinalStateSchema = z
	.object({
		status: z.string().optional(),
	})
	.passthrough();
const managedVmRuntimeComposition = createManagedVmRuntimeComposition();

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

async function createGitRpcRepo(baseDir: string): Promise<string> {
	const repoDir = path.join(baseDir, 'git-rpc-repo');
	await fs.mkdir(path.join(repoDir, '.agent-vm'), { recursive: true });
	await fs.writeFile(path.join(repoDir, 'package.json'), JSON.stringify({ name: 'git-rpc-repo' }));
	await fs.writeFile(
		path.join(repoDir, '.agent-vm', 'config.json'),
		JSON.stringify({
			verification: [],
		}),
	);

	execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'pipe' });
	execFileSync('git', ['config', 'user.email', 'git-rpc@example.com'], {
		cwd: repoDir,
		stdio: 'pipe',
	});
	execFileSync('git', ['config', 'user.name', 'git-rpc-test'], { cwd: repoDir, stdio: 'pipe' });
	execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repoDir, stdio: 'pipe' });
	await fs.writeFile(path.join(repoDir, 'README.md'), 'git rpc e2e\n');
	execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
	execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-m', 'init'], {
		cwd: repoDir,
		stdio: 'pipe',
	});

	return repoDir;
}

function createWorkerLoopSecretResolver(fallbackValue: string): SecretResolver {
	const resolve = async (ref: SecretRef): Promise<string> => {
		switch (ref.source) {
			case 'config':
				return ref.value;
			case 'environment':
				return process.env[ref.ref] ?? fallbackValue;
			case '1password':
				return fallbackValue;
		}
		throw new Error('Unsupported secret source');
	};
	return {
		resolve,
		resolveAll: async (refs: Record<string, SecretRef>): Promise<Record<string, string>> =>
			Object.fromEntries(
				await Promise.all(
					Object.entries(refs).map(async ([key, ref]) => [key, await resolve(ref)] as const),
				),
			),
	};
}

async function writeScriptedWorkerConfig(configPath: string): Promise<void> {
	await fs.writeFile(
		configPath,
		JSON.stringify({
			runtimeInstructions: 'Scripted controller-backed Worker control git RPC proof.',
			defaults: { provider: scriptedE2eExecutorProvider, model: 'scripted' },
			phases: {
				plan: {
					provider: scriptedE2eExecutorProvider,
					model: 'scripted',
					skills: [],
					cycle: { kind: 'noReview' },
					agentInstructions: null,
					reviewerInstructions: null,
				},
				work: {
					provider: scriptedE2eExecutorProvider,
					model: 'scripted',
					skills: [],
					cycle: { kind: 'review', cycleCount: 1 },
					agentInstructions: null,
					reviewerInstructions: null,
				},
				wrapup: {
					provider: scriptedE2eExecutorProvider,
					model: 'scripted',
					skills: [],
					instructions: null,
				},
			},
			mcpServers: [],
			verification: [],
			branchPrefix: 'agent/',
			stateDir: '/state',
		}),
	);
}

describeWorkerE2e('e2e: real agent-vm-worker loop', () => {
	let harness: E2eHarnessRuntime | undefined;
	let localWorkerTarballPaths: readonly string[] = [];
	let project: WorkerE2eProject | undefined;

	afterAll(async () => {
		try {
			await harness?.close();
		} finally {
			await Promise.all([
				project ? removeE2eTempRoot(project.tempRoot) : Promise.resolve(),
				removeE2eLocalPackageTarballs(localWorkerTarballPaths),
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
		const localWorkerTarballs = await prepareLocalWorkerPackageSetForGatewayImage(repoRoot);
		localWorkerTarballPaths = localWorkerTarballs.map((tarball) => tarball.sourcePath);

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
		const previousLocalWorkerPackageTarballs = process.env.AGENT_VM_WORKER_PACKAGE_TARBALLS_JSON;
		process.env.AGENT_VM_WORKER_PACKAGE_TARBALLS_JSON = JSON.stringify(localWorkerTarballs);
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
				controllerEpoch: 'worker-smoke-e2e-controller-epoch',
				managedVmFactory: managedVmRuntimeComposition.managedVmFactory,
				managedVmImages: managedVmRuntimeComposition.managedVmImages,
				secretResolver,
				systemConfig: project.systemConfig,
			});
			expect(result.taskId).toBeTruthy();
			const finalState = workerE2eFinalStateSchema.parse(result.finalState);
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
			if (previousLocalWorkerPackageTarballs === undefined) {
				delete process.env.AGENT_VM_WORKER_PACKAGE_TARBALLS_JSON;
			} else {
				process.env.AGENT_VM_WORKER_PACKAGE_TARBALLS_JSON = previousLocalWorkerPackageTarballs;
			}
		}
	}, 900_000);

	it('dispatches worker git RPCs through the controller-backed control session', async () => {
		const repoRoot = path.resolve(process.cwd());

		project = await scaffoldWorkerE2eProject({
			architecture,
			prefix: 'worker-loop-git-rpc-e2e-',
			zoneId: 'worker-git-rpc-e2e',
		});
		const repoDir = await createGitRpcRepo(project.tempRoot);
		await prepareGatewayE2eProjectImages({ project });
		const localWorkerTarballs = await prepareLocalWorkerPackageSetForGatewayImage(repoRoot);
		localWorkerTarballPaths = localWorkerTarballs.map((tarball) => tarball.sourcePath);

		const workerZone = project.systemConfig.zones.find(
			(candidateZone) => candidateZone.id === 'worker-git-rpc-e2e',
		);
		if (workerZone === undefined || workerZone.gateway.type !== 'worker') {
			throw new Error('Expected worker-git-rpc-e2e system config to contain a Worker zone.');
		}
		workerZone.secrets = {
			...workerZone.secrets,
			[scriptedE2eExecutorEnvName]: {
				source: 'config',
				value: '1',
				injection: 'env',
				audience: 'gateway',
			},
		};
		workerZone.egressHosts = [
			...workerZone.egressHosts,
			{ host: 'github.com', audience: 'gateway' },
		];

		await writeScriptedWorkerConfig(workerZone.gateway.config);
		const previousLocalWorkerTarballPath = process.env.AGENT_VM_WORKER_TARBALL_PATH;
		const previousLocalWorkerPackageTarballs = process.env.AGENT_VM_WORKER_PACKAGE_TARBALLS_JSON;
		process.env.AGENT_VM_WORKER_PACKAGE_TARBALLS_JSON = JSON.stringify(localWorkerTarballs);
		try {
			const secretResolver = createWorkerLoopSecretResolver(
				process.env.AGENT_VM_TEST_OPENAI_API_KEY ?? '',
			);
			harness = await startE2eControllerRuntime({
				secrets: {
					AGENT_VM_TEST_OPENAI_API_KEY: process.env.AGENT_VM_TEST_OPENAI_API_KEY ?? '',
					'op://agent-vm/github-token/credential': process.env.AGENT_VM_TEST_OPENAI_API_KEY ?? '',
				},
				startOptions: {
					systemConfig: project.systemConfig,
					zoneIds: ['worker-git-rpc-e2e'],
				},
			});
			const repoUrl = pathToFileURL(repoDir).href;

			const prepared = await prepareWorkerTask({
				input: {
					requestTaskId: 'request-worker-git-rpc-e2e',
					prompt: 'Run the deterministic controller-backed Worker control git RPC proof.',
					repos: [{ repoUrl, baseBranch: 'main' }],
					context: { source: 'worker-git-rpc-e2e' },
				},
				systemConfig: project.systemConfig,
				zoneId: 'worker-git-rpc-e2e',
			});

			const pushedBranches: Array<{
				readonly branchName: string;
				readonly expectedHead?: string;
				readonly repoUrl: string;
				readonly taskId: string;
			}> = [];
			const pulledDefaults: Array<{
				readonly currentBranch?: string | null;
				readonly currentHead?: string;
				readonly repoUrl: string;
				readonly taskId: string;
				readonly worktreeDirty?: boolean;
			}> = [];
			const operations: WorkerControlRpcOperations = {
				pushTaskBranches: async (taskId, input) => {
					for (const branch of input.branches) {
						pushedBranches.push({
							branchName: branch.branchName,
							...(branch.expectedHead === undefined ? {} : { expectedHead: branch.expectedHead }),
							repoUrl: branch.repoUrl,
							taskId,
						});
					}
					return {
						results: input.branches.map((branch) => ({
							branch: branch.branchName,
							...(branch.expectedHead === undefined ? {} : { localHead: branch.expectedHead }),
							repoUrl: branch.repoUrl,
							success: true,
						})),
					};
				},
				pullDefaultForTask: async (taskId, input) => {
					pulledDefaults.push({
						...(input.currentBranch === undefined ? {} : { currentBranch: input.currentBranch }),
						...(input.currentHead === undefined ? {} : { currentHead: input.currentHead }),
						repoUrl: input.repoUrl,
						taskId,
						...(input.worktreeDirty === undefined ? {} : { worktreeDirty: input.worktreeDirty }),
					});
					return {
						commitsSinceForkPoint: [],
						...(input.currentBranch === undefined ? {} : { currentBranch: input.currentBranch }),
						currentBranchSync: {
							branch: input.currentBranch ?? 'agent/scripted-e2e',
							localHead: input.currentHead ?? 'local-head',
							remoteHead: input.currentHead ?? 'local-head',
							status: 'up-to-date',
							upstreamTrackingRef: `origin/${input.currentBranch ?? 'agent/scripted-e2e'}`,
						},
						defaultBranch: 'main',
						divergence: { aheadOfDefault: 0, behindDefault: 0, forkPoint: 'fork-sha' },
						fetchedCommits: [],
						kind: 'advanced',
						localDefaultHead: input.currentHead ?? 'local-main-sha',
						message: 'Default branch refreshed by controller-backed Worker control e2e.',
						remoteDefaultHead: input.currentHead ?? 'remote-main-sha',
						repoUrl: input.repoUrl,
						success: true,
					};
				},
			};
			const result = await executeWorkerTask(prepared, {
				controllerEpoch: 'worker-git-rpc-e2e-controller-epoch',
				managedVmFactory: managedVmRuntimeComposition.managedVmFactory,
				managedVmImages: managedVmRuntimeComposition.managedVmImages,
				controlSession: {
					controllerEpoch: 'worker-git-rpc-e2e-controller-epoch',
					operations,
				},
				secretResolver,
				systemConfig: project.systemConfig,
			});
			expect(result.taskId).toBeTruthy();
			const finalState = workerE2eFinalStateSchema.parse(result.finalState);
			if (finalState.status !== 'completed') {
				throw new Error(
					`Worker git RPC task ended in ${finalState.status ?? 'unknown'}: ${JSON.stringify({
						finalState: result.finalState,
						pulledDefaults,
						pushedBranches,
					})}`,
				);
			}
			expect(pushedBranches).toEqual([
				expect.objectContaining({
					branchName: `agent/${prepared.taskId}`,
					repoUrl,
					taskId: prepared.taskId,
				}),
			]);
			expect(pulledDefaults).toEqual([
				expect.objectContaining({
					currentBranch: `agent/${prepared.taskId}`,
					repoUrl,
					taskId: prepared.taskId,
				}),
			]);
		} finally {
			if (previousLocalWorkerTarballPath === undefined) {
				delete process.env.AGENT_VM_WORKER_TARBALL_PATH;
			} else {
				process.env.AGENT_VM_WORKER_TARBALL_PATH = previousLocalWorkerTarballPath;
			}
			if (previousLocalWorkerPackageTarballs === undefined) {
				delete process.env.AGENT_VM_WORKER_PACKAGE_TARBALLS_JSON;
			} else {
				process.env.AGENT_VM_WORKER_PACKAGE_TARBALLS_JSON = previousLocalWorkerPackageTarballs;
			}
		}
	}, 900_000);
});
