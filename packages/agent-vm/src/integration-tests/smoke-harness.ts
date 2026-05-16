import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import type { SecretRef, SecretResolver } from '@agent-vm/gondolin-adapter';

import { computeFingerprintFromConfigPath } from '../build/gondolin-image-builder.js';
import { resolveManagedImageRelease } from '../build/managed-image-dockerfile.js';
import { scaffoldAgentVmProject, type ImageArchitecture } from '../cli/init-command.js';
import { loadSystemConfig, type LoadedSystemConfig } from '../config/system-config.js';
import type {
	ControllerRuntime,
	StartControllerRuntimeOptions,
} from '../controller/controller-runtime-types.js';
import { startControllerRuntime } from '../controller/controller-runtime.js';

interface OpenClawSmokeZone extends Omit<LoadedSystemConfig['zones'][number], 'gateway'> {
	readonly gateway: Extract<
		LoadedSystemConfig['zones'][number]['gateway'],
		{ readonly type: 'openclaw' }
	>;
}

export interface SmokeHarnessSecretMap {
	readonly [secretKey: string]: string;
}

export interface SmokeHarnessRuntime {
	readonly controllerUrl: string;
	readonly runtime: ControllerRuntime;
	readonly systemConfig: LoadedSystemConfig;
	readonly tempRoot: string;
	close(): Promise<void>;
}

export interface OpenClawSmokeProject {
	readonly controllerPort: number;
	readonly gatewayPort: number;
	readonly systemConfig: LoadedSystemConfig;
	readonly tempRoot: string;
	readonly zone: OpenClawSmokeZone;
}

export function hasCommand(command: string): boolean {
	try {
		execFileSync('sh', ['-lc', `command -v ${command} >/dev/null`], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}

export function currentSmokeArchitecture(): ImageArchitecture {
	return process.arch === 'arm64' ? 'aarch64' : 'x86_64';
}

export function qemuCommandForArchitecture(architecture: ImageArchitecture): string {
	return architecture === 'aarch64' ? 'qemu-system-aarch64' : 'qemu-system-x86_64';
}

export function canRunGondolinSmoke(architecture: ImageArchitecture): boolean {
	return (
		hasCommand(qemuCommandForArchitecture(architecture)) &&
		hasCommand('zig') &&
		hasCommand('docker')
	);
}

export function shouldRunWorkerGatewaySmoke(options: {
	readonly architecture: ImageArchitecture;
	readonly commandExists?: (command: string) => boolean;
	readonly env?: Partial<Record<'AGENT_VM_WORKER_LOOP_SMOKE' | 'OPEN_AI_TEST_KEY', string>>;
}): boolean {
	const env = options.env ?? process.env;
	const commandExists = options.commandExists ?? hasCommand;
	return (
		env.AGENT_VM_WORKER_LOOP_SMOKE === '1' &&
		typeof env.OPEN_AI_TEST_KEY === 'string' &&
		env.OPEN_AI_TEST_KEY.length > 0 &&
		commandExists(qemuCommandForArchitecture(options.architecture)) &&
		commandExists('zig') &&
		commandExists('docker')
	);
}

export function rebuildWorkspacePackages(repoRoot: string): void {
	execFileSync('pnpm', ['build'], {
		cwd: repoRoot,
		stdio: 'inherit',
	});
}

export async function findAvailablePort(): Promise<number> {
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

export async function waitForControllerReady(controllerPort: number): Promise<void> {
	for (let attempt = 0; attempt < 40; attempt += 1) {
		// oxlint-disable-next-line eslint/no-await-in-loop -- readiness polling is sequential
		const response = await fetch(`http://127.0.0.1:${controllerPort}/controller-status`).catch(
			() => null,
		);
		if (response?.ok) {
			return;
		}
		// oxlint-disable-next-line eslint/no-await-in-loop -- readiness polling is sequential
		await new Promise((resolve) => setTimeout(resolve, 500));
	}

	throw new Error('Controller did not become ready in time.');
}

export async function findReusableGatewayImageDirectory(
	currentProjectRoot: string,
	gatewayBuildConfigPath: string,
): Promise<string | null> {
	const requiredFingerprint = await computeFingerprintFromConfigPath(gatewayBuildConfigPath);
	const tempRootEntries = await fs.readdir(os.tmpdir(), { withFileTypes: true });
	const smokeRunDirectories = tempRootEntries
		.filter((entry) => entry.isDirectory() && entry.name.includes('-smoke-'))
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
			// oxlint-disable-next-line eslint/no-await-in-loop -- intentionally searches cache candidates
			await fs.access(path.join(candidateImageDir, 'manifest.json'));
			// oxlint-disable-next-line eslint/no-await-in-loop -- intentionally searches cache candidates
			await fs.access(path.join(candidateImageDir, 'rootfs.ext4'));
			// oxlint-disable-next-line eslint/no-await-in-loop -- intentionally searches cache candidates
			await fs.access(path.join(candidateImageDir, 'initramfs.cpio.lz4'));
			// oxlint-disable-next-line eslint/no-await-in-loop -- intentionally searches cache candidates
			await fs.access(path.join(candidateImageDir, 'vmlinuz-virt'));
			return candidateImageDir;
		} catch {
			continue;
		}
	}

	return null;
}

export async function seedGatewayImageCacheIfAvailable(options: {
	readonly activeCacheDir: string;
	readonly currentProjectRoot: string;
	readonly gatewayBuildConfigPath: string;
}): Promise<void> {
	const reusableImageDir = await findReusableGatewayImageDirectory(
		options.currentProjectRoot,
		options.gatewayBuildConfigPath,
	);
	if (!reusableImageDir) {
		return;
	}

	const requiredFingerprint = await computeFingerprintFromConfigPath(
		options.gatewayBuildConfigPath,
	);
	const activeImageDir = path.join(
		options.activeCacheDir,
		'images',
		'gateway',
		requiredFingerprint,
	);
	if (activeImageDir === reusableImageDir) {
		return;
	}

	await fs.rm(activeImageDir, { recursive: true, force: true });
	await fs.mkdir(path.dirname(activeImageDir), { recursive: true });
	await fs.symlink(reusableImageDir, activeImageDir, 'dir');
}

export function createSmokeSecretResolver(secrets: SmokeHarnessSecretMap): SecretResolver {
	const resolve = async (ref: SecretRef): Promise<string> => {
		const secretKey = ref.ref;
		const secret = secrets[secretKey] ?? process.env[secretKey];
		if (secret === undefined) {
			throw new Error(`Smoke secret '${secretKey}' is not configured.`);
		}
		return secret;
	};
	return {
		resolve,
		resolveAll: async (refs: Record<string, SecretRef>) => {
			const resolvedSecrets: Record<string, string> = {};
			for (const [secretName, ref] of Object.entries(refs)) {
				// oxlint-disable-next-line eslint/no-await-in-loop -- keeps deterministic secret errors
				resolvedSecrets[secretName] = await resolve(ref);
			}
			return resolvedSecrets;
		},
	};
}

function applySmokeEnvironment(secrets: SmokeHarnessSecretMap): () => void {
	const previousValues = new Map<string, string | undefined>();
	for (const [secretName, secretValue] of Object.entries(secrets)) {
		previousValues.set(secretName, process.env[secretName]);
		process.env[secretName] = secretValue;
	}
	return () => {
		for (const [secretName, previousValue] of previousValues) {
			if (previousValue === undefined) {
				delete process.env[secretName];
			} else {
				process.env[secretName] = previousValue;
			}
		}
	};
}

export function getOpenClawSmokeZone(
	systemConfig: LoadedSystemConfig,
): OpenClawSmokeProject['zone'] {
	const zone = systemConfig.zones[0];
	if (!zone || zone.gateway.type !== 'openclaw') {
		throw new Error('Expected smoke system config to contain an OpenClaw zone.');
	}
	return { ...zone, gateway: zone.gateway };
}

export async function useLocalOpenClawPluginGatewayImage(options: {
	readonly profileName: string;
	readonly projectRoot: string;
	readonly repoRoot: string;
	readonly systemConfig: LoadedSystemConfig;
}): Promise<void> {
	const gatewayProfile = options.systemConfig.imageProfiles.gateways[options.profileName];
	if (!gatewayProfile) {
		throw new Error(`Gateway image profile '${options.profileName}' is not configured.`);
	}
	const pluginDistDirectory = path.join(
		options.repoRoot,
		'packages',
		'openclaw-agent-vm-plugin',
		'dist',
	);
	await fs.access(path.join(pluginDistDirectory, 'openclaw.plugin.json'));
	const managedImageRelease = await resolveManagedImageRelease();
	const baseImage = managedImageRelease.baseImages['openclaw-gateway'];
	const dockerContextDirectory = path.join(
		options.projectRoot,
		'vm-images',
		'gateways',
		`${options.profileName}-local-plugin`,
	);
	const pluginArchivePath = path.join(dockerContextDirectory, 'gondolin-dist.tgz');
	const dockerfilePath = path.join(dockerContextDirectory, 'Dockerfile');

	await fs.rm(dockerContextDirectory, { force: true, recursive: true });
	await fs.mkdir(dockerContextDirectory, { recursive: true });
	execFileSync('tar', ['--no-xattrs', '-czf', pluginArchivePath, '-C', pluginDistDirectory, '.'], {
		env: { ...process.env, COPYFILE_DISABLE: '1' },
		stdio: 'inherit',
	});
	await fs.writeFile(
		dockerfilePath,
		[
			`FROM ${baseImage.repository}:${baseImage.tag}`,
			'',
			'# Generated by the OpenClaw zone-git smoke harness from the local plugin dist.',
			'COPY gondolin-dist.tgz /tmp/gondolin-dist.tgz',
			'RUN mkdir -p /pnpm/global/5/node_modules/@openclaw',
			'RUN rm -rf /home/openclaw/.openclaw/extensions/gondolin && \\',
			'    mkdir -p /home/openclaw/.openclaw/extensions/gondolin && \\',
			'    tar -xzf /tmp/gondolin-dist.tgz -C /home/openclaw/.openclaw/extensions/gondolin && \\',
			'    chown -R root:root /home/openclaw/.openclaw/extensions/gondolin && \\',
			'    rm -f /tmp/gondolin-dist.tgz',
			'',
		].join('\n'),
		'utf8',
	);

	gatewayProfile.dockerfile = dockerfilePath;
	delete gatewayProfile.source;
}

export async function scaffoldOpenClawSmokeProject(options: {
	readonly agents?: readonly string[];
	readonly architecture: ImageArchitecture;
	readonly prefix: string;
	readonly zoneId: string;
}): Promise<OpenClawSmokeProject> {
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), options.prefix));
	const controllerPort = await findAvailablePort();
	const gatewayPort = await findAvailablePort();
	await scaffoldAgentVmProject({
		architecture: options.architecture,
		gatewayType: 'openclaw',
		secretsProvider: 'environment',
		targetDir: tempRoot,
		zoneId: options.zoneId,
		...(options.agents ? { agents: options.agents } : {}),
	});
	const systemConfig = await loadSystemConfig(path.join(tempRoot, 'config', 'system.json'));
	systemConfig.host.controllerPort = controllerPort;
	systemConfig.host.projectNamespace = 'claw-tests-zone-git';
	systemConfig.cacheDir = path.join(tempRoot, 'cache');
	const zone = getOpenClawSmokeZone(systemConfig);
	zone.gateway.port = gatewayPort;
	return {
		controllerPort,
		gatewayPort,
		systemConfig,
		tempRoot,
		zone,
	};
}

export async function startSmokeControllerRuntime(options: {
	readonly secrets: SmokeHarnessSecretMap;
	readonly startOptions: StartControllerRuntimeOptions;
}): Promise<SmokeHarnessRuntime> {
	const restoreEnvironment = applySmokeEnvironment(options.secrets);
	const secretResolver = createSmokeSecretResolver(options.secrets);
	try {
		const runtime = await startControllerRuntime(options.startOptions, {
			createSecretResolver: async (): Promise<SecretResolver> => secretResolver,
		});
		await waitForControllerReady(options.startOptions.systemConfig.host.controllerPort);
		return {
			controllerUrl: `http://127.0.0.1:${options.startOptions.systemConfig.host.controllerPort}`,
			runtime,
			systemConfig: options.startOptions.systemConfig,
			tempRoot: path.dirname(path.dirname(options.startOptions.systemConfig.systemConfigPath)),
			close: async () => {
				try {
					await runtime.close();
				} finally {
					restoreEnvironment();
				}
			},
		};
	} catch (error) {
		restoreEnvironment();
		throw error;
	}
}
