/* oxlint-disable eslint/no-await-in-loop -- smoke polling must be sequential against live services */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { SecretRef, SecretResolver } from '@agent-vm/gondolin-adapter';
import { afterAll, describe, expect, it } from 'vitest';

import { computeFingerprintFromConfigPath } from '../build/gondolin-image-builder.js';
import { scaffoldAgentVmProject } from '../cli/init-command.js';
import { loadSystemConfig } from '../config/system-config.js';
import { startControllerRuntime } from '../controller/controller-runtime.js';
import { executeWorkerTask, prepareWorkerTask } from '../controller/worker-task-runner.js';

function hasCommand(command: string): boolean {
	try {
		execFileSync('sh', ['-lc', `command -v ${command} >/dev/null`], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}

function rebuildWorkerPackages(repoRoot: string): void {
	execFileSync('pnpm', ['build'], {
		cwd: repoRoot,
		stdio: 'inherit',
	});
}

async function findReusableGatewayImageDirectory(
	currentProjectRoot: string,
	gatewayBuildConfigPath: string,
	systemCacheIdentifierPath: string,
): Promise<string | null> {
	const requiredFingerprint = await computeFingerprintFromConfigPath(
		gatewayBuildConfigPath,
		systemCacheIdentifierPath,
	);
	const tempRootEntries = await fs.readdir(os.tmpdir(), { withFileTypes: true });
	const smokeRunDirectories = tempRootEntries
		.filter((entry) => entry.isDirectory() && entry.name.startsWith('worker-loop-smoke-'))
		.map((entry) => path.join(os.tmpdir(), entry.name));

	for (const smokeRunDirectory of smokeRunDirectories) {
		if (smokeRunDirectory === currentProjectRoot) {
			continue;
		}
		const candidateImageDir = path.join(
			smokeRunDirectory,
			'cache',
			'images',
			'gateway',
			requiredFingerprint,
		);
		try {
			await fs.access(path.join(candidateImageDir, 'manifest.json'));
			await fs.access(path.join(candidateImageDir, 'rootfs.ext4'));
			await fs.access(path.join(candidateImageDir, 'initramfs.cpio.lz4'));
			await fs.access(path.join(candidateImageDir, 'vmlinuz-virt'));
			return candidateImageDir;
		} catch {
			continue;
		}
	}

	return null;
}

async function seedGatewayImageCacheIfAvailable(
	activeCacheDir: string,
	currentProjectRoot: string,
	gatewayBuildConfigPath: string,
	systemCacheIdentifierPath: string,
): Promise<void> {
	const reusableImageDir = await findReusableGatewayImageDirectory(
		currentProjectRoot,
		gatewayBuildConfigPath,
		systemCacheIdentifierPath,
	);
	if (!reusableImageDir) {
		return;
	}

	const requiredFingerprint = await computeFingerprintFromConfigPath(
		gatewayBuildConfigPath,
		systemCacheIdentifierPath,
	);
	const activeImageDir = path.join(activeCacheDir, 'images', 'gateway', requiredFingerprint);
	if (activeImageDir === reusableImageDir) {
		return;
	}

	await fs.rm(activeImageDir, { recursive: true, force: true });
	await fs.mkdir(path.dirname(activeImageDir), { recursive: true });
	await fs.symlink(reusableImageDir, activeImageDir, 'dir');
}

async function prepareLocalWorkerPackageForGatewayImage(repoRoot: string): Promise<string> {
	await fs.mkdir(path.join(repoRoot, 'tmp'), { recursive: true });
	const packDirectory = await fs.mkdtemp(path.join(repoRoot, 'tmp', 'agent-vm-worker-pack-'));
	execFileSync('pnpm', ['pack', '--pack-destination', packDirectory], {
		cwd: path.join(repoRoot, 'packages', 'agent-vm-worker'),
		stdio: 'pipe',
	});
	const packedTarballName = execFileSync('sh', ['-lc', 'ls *.tgz | tail -n 1'], {
		cwd: packDirectory,
		encoding: 'utf8',
		stdio: 'pipe',
	}).trim();
	if (packedTarballName.length === 0) {
		throw new Error('Failed to pack local agent-vm-worker tarball for smoke image.');
	}
	return path.join(packDirectory, packedTarballName);
}

const runWorkerSmoke =
	typeof process.env.OPEN_AI_TEST_KEY === 'string' &&
	process.env.OPEN_AI_TEST_KEY.length > 0 &&
	hasCommand('qemu-system-x86_64') &&
	hasCommand('zig');

const describeWorkerSmoke = runWorkerSmoke ? describe : describe.skip;

async function findAvailablePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (!address || typeof address === 'string') {
				server.close(() => reject(new Error('Failed to determine an available port.')));
				return;
			}
			server.close((error) => {
				if (error) {
					reject(error);
					return;
				}
				resolve(address.port);
			});
		});
	});
}

async function waitForControllerReady(controllerPort: number): Promise<void> {
	for (let attempt = 0; attempt < 40; attempt += 1) {
		const response = await fetch(`http://127.0.0.1:${controllerPort}/controller-status`);
		if (response.ok) {
			return;
		}
		// Polling is intentionally sequential because the controller startup is stateful.
		// oxlint-disable-next-line eslint/no-await-in-loop
		await new Promise((resolve) => setTimeout(resolve, 500));
	}

	throw new Error('Controller did not become ready in time.');
}

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

describeWorkerSmoke('smoke: real agent-vm-worker loop', () => {
	let runtime: Awaited<ReturnType<typeof startControllerRuntime>> | undefined;

	afterAll(async () => {
		await runtime?.close();
	});

	it('runs a real worker task to completed through the controller route', async () => {
		const repoRoot = path.resolve(process.cwd());
		rebuildWorkerPackages(repoRoot);

		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-loop-smoke-'));
		const controllerPort = await findAvailablePort();
		const gatewayPort = await findAvailablePort();
		const repoDir = await createSampleRepo(tempRoot);
		await scaffoldAgentVmProject({
			targetDir: tempRoot,
			zoneId: 'worker-smoke',
			gatewayType: 'worker',
			architecture: 'aarch64',
			secretsProvider: '1password',
		});
		const scaffoldCachePath = path.join(os.tmpdir(), 'agent-vm-smoke-cache');
		await fs.mkdir(scaffoldCachePath, { recursive: true });
		const gatewayBuildConfigPath = path.join(
			tempRoot,
			'vm-images',
			'gateways',
			'worker',
			'build-config.json',
		);
		const systemCacheIdentifierPath = path.join(tempRoot, 'config', 'systemCacheIdentifier.json');
		await seedGatewayImageCacheIfAvailable(
			scaffoldCachePath,
			tempRoot,
			gatewayBuildConfigPath,
			systemCacheIdentifierPath,
		);
		const localWorkerTarballPath = await prepareLocalWorkerPackageForGatewayImage(repoRoot);

		const systemConfig = await loadSystemConfig(path.join(tempRoot, 'config', 'system.json'));
		systemConfig.cacheDir = scaffoldCachePath;
		systemConfig.host.controllerPort = controllerPort;
		systemConfig.host.projectNamespace = 'claw-tests-a1b2c3d4';
		systemConfig.host.secretsProvider = {
			type: '1password',
			tokenSource: { type: 'env', envVar: 'OPEN_AI_TEST_KEY' },
		};

		const workerZone = systemConfig.zones[0];
		if (!workerZone) {
			throw new Error('Expected a configured worker zone for the smoke test.');
		}
		workerZone.gateway.port = gatewayPort;
		workerZone.allowedHosts = [...workerZone.allowedHosts, 'github.com'];

		await fs.writeFile(
			workerZone.gateway.config,
			JSON.stringify({
				runtimeInstructions: 'Smoke test runtime instructions.',
				defaults: { provider: 'codex', model: 'gpt-5.4' },
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
				resolve: async (_ref: SecretRef) => process.env.OPEN_AI_TEST_KEY ?? '',
				resolveAll: async (refs: Record<string, SecretRef>) =>
					Object.fromEntries(
						Object.keys(refs).map((key) => [key, process.env.OPEN_AI_TEST_KEY ?? '']),
					),
			};
			runtime = await startControllerRuntime(
				{
					systemConfig,
					zoneId: 'worker-smoke',
				},
				{
					createSecretResolver: async (): Promise<SecretResolver> => secretResolver,
				},
			);
			await waitForControllerReady(controllerPort);
			const repoUrl = pathToFileURL(repoDir).href;

			const prepared = await prepareWorkerTask({
				input: {
					requestTaskId: 'request-worker-smoke',
					prompt: 'Create a file named READY.txt in the repository root containing exactly READY.',
					repos: [{ repoUrl, baseBranch: 'main' }],
					context: { source: 'smoke-test' },
				},
				systemConfig,
				zoneId: 'worker-smoke',
			});
			const result = await executeWorkerTask(prepared, { secretResolver, systemConfig });
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
