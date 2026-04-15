/* oxlint-disable eslint/no-await-in-loop -- smoke polling must be sequential against live services */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import type { SecretRef, SecretResolver } from '@shravansunder/gondolin-core';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { computeFingerprintFromConfigPath } from '../build/gondolin-image-builder.js';
import { scaffoldAgentVmProject } from '../cli/init-command.js';
import { loadSystemConfig } from '../config/system-config.js';
import { startControllerRuntime } from '../controller/controller-runtime.js';

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
): Promise<string | null> {
	const requiredFingerprint = await computeFingerprintFromConfigPath(gatewayBuildConfigPath);
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
): Promise<void> {
	const reusableImageDir = await findReusableGatewayImageDirectory(
		currentProjectRoot,
		gatewayBuildConfigPath,
	);
	if (!reusableImageDir) {
		return;
	}

	const requiredFingerprint = await computeFingerprintFromConfigPath(gatewayBuildConfigPath);
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
	hasCommand('qemu-system-x86_64');

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

async function postJsonWithLongTimeout(
	url: string,
	body: Record<string, unknown>,
): Promise<{ readonly statusCode: number; readonly json: unknown }> {
	return await new Promise((resolve, reject) => {
		const request = http.request(
			url,
			{
				method: 'POST',
				headers: {
					'content-type': 'application/json',
				},
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on('data', (chunk) => {
					chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
				});
				response.on('end', () => {
					try {
						resolve({
							statusCode: response.statusCode ?? 0,
							json: JSON.parse(Buffer.concat(chunks).toString('utf8')),
						});
					} catch (error) {
						reject(error);
					}
				});
			},
		);

		request.on('error', reject);
		request.write(JSON.stringify(body));
		request.end();
	});
}

const workerTaskResponseSchema = z.object({
	taskId: z.string().min(1),
	finalState: z
		.object({
			status: z.string(),
		})
		.passthrough(),
});

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
		await scaffoldAgentVmProject(
			{
				targetDir: tempRoot,
				zoneId: 'worker-smoke',
				gatewayType: 'worker',
			},
			{
				generateAgeIdentityKey: () => undefined,
			},
		);
		const scaffoldCachePath = path.join(os.tmpdir(), 'agent-vm-smoke-cache');
		await fs.mkdir(scaffoldCachePath, { recursive: true });
		const gatewayBuildConfigPath = path.join(tempRoot, 'images', 'gateway', 'build-config.json');
		await seedGatewayImageCacheIfAvailable(scaffoldCachePath, tempRoot, gatewayBuildConfigPath);
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
			workerZone.gateway.gatewayConfig,
			JSON.stringify({
				defaults: { provider: 'codex', model: 'gpt-5.4' },
				phases: {
					plan: { skills: [], maxReviewLoops: 0 },
					planReview: { skills: [] },
					work: { skills: [], maxReviewLoops: 0, maxVerificationRetries: 1 },
					workReview: { skills: [] },
					wrapup: { skills: [] },
				},
				mcpServers: [],
				verification: [{ name: 'verify', command: 'bash scripts/verify.sh' }],
				wrapupActions: [],
				branchPrefix: 'agent/',
				commitCoAuthor: 'agent-vm-worker <noreply@agent-vm>',
				idleTimeoutMs: 1_800_000,
				stateDir: '/state',
			}),
		);
		const previousLocalWorkerTarballPath = process.env.AGENT_VM_WORKER_TARBALL_PATH;
		process.env.AGENT_VM_WORKER_TARBALL_PATH = localWorkerTarballPath;
		try {
			runtime = await startControllerRuntime(
				{
					systemConfig,
					zoneId: 'worker-smoke',
				},
				{
					createSecretResolver: async (): Promise<SecretResolver> => ({
						resolve: async (_ref: SecretRef) => process.env.OPEN_AI_TEST_KEY ?? '',
						resolveAll: async (refs: Record<string, SecretRef>) =>
							Object.fromEntries(
								Object.keys(refs).map((key) => [key, process.env.OPEN_AI_TEST_KEY ?? '']),
							),
					}),
				},
			);
			await waitForControllerReady(controllerPort);

			const response = await postJsonWithLongTimeout(
				`http://127.0.0.1:${controllerPort}/zones/worker-smoke/worker-tasks`,
				{
					prompt: 'Create a file named READY.txt in the repository root containing exactly READY.',
					repos: [{ repoUrl: repoDir, baseBranch: 'main' }],
					context: { source: 'smoke-test' },
				},
			);

			if (response.statusCode !== 200) {
				throw new Error(
					`Worker smoke task request failed with ${response.statusCode}: ${JSON.stringify(response.json)}`,
				);
			}
			const body = workerTaskResponseSchema.parse(response.json);
			expect(body.taskId).toBeTruthy();
			if (body.finalState.status !== 'completed') {
				throw new Error(
					`Worker smoke task ended in ${body.finalState.status}: ${JSON.stringify(body.finalState)}`,
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
