import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import {
	resolveGondolinMinimumZigVersion,
	type SecretRef,
	type SecretResolver,
} from '@agent-vm/gondolin-adapter';

import { computeFingerprintFromConfigPath } from '../build/gondolin-image-builder.js';
import { resolveManagedImageRelease } from '../build/managed-image-dockerfile.js';
import { isZigVersionAtLeast, resolveHostZigVersion } from '../build/zig-compatibility.js';
import { scaffoldAgentVmProject, type ImageArchitecture } from '../cli/init-command.js';
import { loadSystemConfig, type LoadedSystemConfig } from '../config/system-config.js';
import type {
	ControllerRuntime,
	ControllerRuntimeDependencies,
	StartControllerRuntimeOptions,
} from '../controller/controller-runtime-types.js';
import { startControllerRuntime } from '../controller/controller-runtime.js';
import { startGatewayZone } from '../gateway/gateway-zone-orchestrator.js';
import type { StartGatewayZoneOptions } from '../gateway/gateway-zone-support.js';

interface OpenClawSmokeZone extends Omit<LoadedSystemConfig['zones'][number], 'gateway'> {
	readonly gateway: Extract<
		LoadedSystemConfig['zones'][number]['gateway'],
		{ readonly type: 'openclaw' }
	>;
}

interface WorkerSmokeZone extends Omit<LoadedSystemConfig['zones'][number], 'gateway'> {
	readonly gateway: Extract<
		LoadedSystemConfig['zones'][number]['gateway'],
		{ readonly type: 'worker' }
	>;
}

interface LocalNpmPackageTarball {
	readonly packageDirectory: string;
	readonly packageName: string;
}

interface LocalDockerPackageTarball {
	readonly archiveName: string;
	readonly sourcePath: string;
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

export interface WorkerSmokeProject {
	readonly controllerPort: number;
	readonly gatewayPort: number;
	readonly systemConfig: LoadedSystemConfig;
	readonly tempRoot: string;
	readonly zone: WorkerSmokeZone;
}

export type GatewaySmokeKind = 'openclaw' | 'worker';

export type GatewaySmokeProject = OpenClawSmokeProject | WorkerSmokeProject;

export interface ScaffoldGatewaySmokeProjectOptions {
	readonly agents?: readonly string[];
	readonly architecture: ImageArchitecture;
	readonly kind: GatewaySmokeKind;
	readonly prefix: string;
	readonly zoneId: string;
}

export interface GondolinSmokePrerequisiteOptions {
	readonly architecture: ImageArchitecture;
	readonly commandExists?: (command: string) => boolean;
	readonly resolveRequiredZigVersion?: () => Promise<string>;
	readonly resolveZigVersion?: () => Promise<string | undefined>;
}

export interface StartSmokeControllerRuntimeOptions {
	readonly secrets: SmokeHarnessSecretMap;
	readonly startGatewayZone?: typeof startGatewayZone;
	readonly startHttpServer?: NonNullable<ControllerRuntimeDependencies['startHttpServer']>;
	readonly startOptions: StartControllerRuntimeOptions;
	readonly tcpHostsOverride?: StartGatewayZoneOptions['tcpHostsOverride'];
	readonly vfsMountsOverride?: StartGatewayZoneOptions['vfsMountsOverride'];
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

export async function canRunGondolinSmoke(
	options: GondolinSmokePrerequisiteOptions,
): Promise<boolean> {
	const commandExists = options.commandExists ?? hasCommand;
	if (
		!commandExists(qemuCommandForArchitecture(options.architecture)) ||
		!commandExists('docker')
	) {
		return false;
	}
	const requiredZigVersion = await (
		options.resolveRequiredZigVersion ?? resolveGondolinMinimumZigVersion
	)();
	const installedZigVersion = await (options.resolveZigVersion ?? resolveHostZigVersion)();
	return (
		installedZigVersion !== undefined &&
		isZigVersionAtLeast(installedZigVersion, requiredZigVersion)
	);
}

export async function shouldRunWorkerGatewaySmoke(options: {
	readonly architecture: ImageArchitecture;
	readonly commandExists?: (command: string) => boolean;
	readonly env?: Partial<Record<'AGENT_VM_WORKER_SMOKE' | 'OPEN_AI_TEST_KEY', string>>;
	readonly resolveRequiredZigVersion?: () => Promise<string>;
	readonly resolveZigVersion?: () => Promise<string | undefined>;
}): Promise<boolean> {
	const env = options.env ?? process.env;
	if (
		env.AGENT_VM_WORKER_SMOKE !== '1' ||
		typeof env.OPEN_AI_TEST_KEY !== 'string' ||
		env.OPEN_AI_TEST_KEY.length === 0
	) {
		return false;
	}
	return await canRunGondolinSmoke({
		architecture: options.architecture,
		...(options.commandExists ? { commandExists: options.commandExists } : {}),
		...(options.resolveRequiredZigVersion
			? { resolveRequiredZigVersion: options.resolveRequiredZigVersion }
			: {}),
		...(options.resolveZigVersion ? { resolveZigVersion: options.resolveZigVersion } : {}),
	});
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

function getWorkerSmokeZone(systemConfig: LoadedSystemConfig): WorkerSmokeProject['zone'] {
	const zone = systemConfig.zones[0];
	if (!zone || zone.gateway.type !== 'worker') {
		throw new Error('Expected smoke system config to contain a Worker Gateway zone.');
	}
	return { ...zone, gateway: zone.gateway };
}

async function packLocalPackageTarball(props: LocalNpmPackageTarball): Promise<string> {
	const packageJsonPath = path.join(props.packageDirectory, 'package.json');
	await fs.access(packageJsonPath);
	const packDirectory = await fs.mkdtemp(path.join(os.tmpdir(), `${props.packageName}-pack-`));
	execFileSync('pnpm', ['pack', '--pack-destination', packDirectory], {
		cwd: props.packageDirectory,
		stdio: 'pipe',
	});
	const packedTarballs = (await fs.readdir(packDirectory)).filter((fileName) =>
		fileName.endsWith('.tgz'),
	);
	const [packedTarballName] = packedTarballs;
	if (packedTarballName === undefined) {
		throw new Error(`Failed to pack local ${props.packageName} tarball for smoke image.`);
	}
	if (packedTarballs.length > 1) {
		throw new Error(`Expected pnpm pack for ${props.packageName} to produce exactly one tarball.`);
	}
	return path.join(packDirectory, packedTarballName);
}

async function copyLocalPackageTarballsToDockerContext(options: {
	readonly dockerContextDirectory: string;
	readonly tarballs: readonly LocalDockerPackageTarball[];
}): Promise<void> {
	await Promise.all(
		options.tarballs.map(async (tarball) => {
			await fs.copyFile(
				tarball.sourcePath,
				path.join(options.dockerContextDirectory, tarball.archiveName),
			);
		}),
	);
}

async function useLocalToolVmMcpPortalPackage(options: {
	readonly localConfigContractsTarballPath: string;
	readonly localMcpPortalTarballPath: string;
	readonly projectRoot: string;
	readonly systemConfig: LoadedSystemConfig;
}): Promise<void> {
	const managedImageRelease = await resolveManagedImageRelease();
	const baseImage = managedImageRelease.baseImages['tool-vm'];
	const toolVmProfiles = Object.entries(options.systemConfig.imageProfiles.toolVms);
	await Promise.all(
		toolVmProfiles.map(async ([profileName, toolVmProfile]): Promise<void> => {
			const dockerContextDirectory = path.join(
				options.projectRoot,
				'vm-images',
				'tool-vms',
				`${profileName}-local-mcp-portal`,
			);
			const dockerfilePath = path.join(dockerContextDirectory, 'Dockerfile');
			const localConfigContractsTarballName = 'config-contracts-local.tgz';
			const localTarballName = 'mcp-portal-local.tgz';
			await fs.rm(dockerContextDirectory, { force: true, recursive: true });
			await fs.mkdir(dockerContextDirectory, { recursive: true });
			await copyLocalPackageTarballsToDockerContext({
				dockerContextDirectory,
				tarballs: [
					{
						archiveName: localConfigContractsTarballName,
						sourcePath: options.localConfigContractsTarballPath,
					},
					{ archiveName: localTarballName, sourcePath: options.localMcpPortalTarballPath },
				],
			});
			await fs.writeFile(
				dockerfilePath,
				[
					`FROM ${baseImage.repository}:${baseImage.tag}`,
					'',
					'# Generated by the OpenClaw smoke harness from the local MCP Portal package.',
					'COPY config-contracts-local.tgz /tmp/config-contracts-local.tgz',
					'COPY mcp-portal-local.tgz /tmp/mcp-portal-local.tgz',
					'RUN mkdir -p /opt/agent-vm/local-packages && \\',
					'    npm install --omit=dev --no-audit --no-fund --prefix /opt/agent-vm/local-packages /tmp/config-contracts-local.tgz /tmp/mcp-portal-local.tgz && \\',
					'    rm -f /tmp/config-contracts-local.tgz /tmp/mcp-portal-local.tgz',
					'',
				].join('\n'),
				'utf8',
			);
			toolVmProfile.dockerfile = dockerfilePath;
			delete toolVmProfile.source;
		}),
	);
}

function localPackageTarballArchiveName(packageName: string): string {
	return `${packageName}-local.tgz`;
}

export async function useLocalOpenClawGatewayImagePackages(options: {
	readonly profileName: string;
	readonly projectRoot: string;
	readonly repoRoot: string;
	readonly systemConfig: LoadedSystemConfig;
}): Promise<void> {
	const gatewayProfile = options.systemConfig.imageProfiles.gateways[options.profileName];
	if (!gatewayProfile) {
		throw new Error(`Gateway image profile '${options.profileName}' is not configured.`);
	}
	const managedImageRelease = await resolveManagedImageRelease();
	const baseImage = managedImageRelease.baseImages['openclaw-gateway'];
	const dockerContextDirectory = path.join(
		options.projectRoot,
		'vm-images',
		'gateways',
		`${options.profileName}-local-packages`,
	);
	const dockerfilePath = path.join(dockerContextDirectory, 'Dockerfile');
	const localConfigContractsTarballPath = await packLocalPackageTarball({
		packageDirectory: path.join(options.repoRoot, 'packages', 'config-contracts'),
		packageName: 'config-contracts',
	});
	const localGondolinAdapterTarballPath = await packLocalPackageTarball({
		packageDirectory: path.join(options.repoRoot, 'packages', 'gondolin-adapter'),
		packageName: 'gondolin-adapter',
	});
	const localMcpPortalTarballPath = await packLocalPackageTarball({
		packageDirectory: path.join(options.repoRoot, 'packages', 'mcp-portal'),
		packageName: 'mcp-portal',
	});
	const localOpenClawAgentVmPluginTarballPath = await packLocalPackageTarball({
		packageDirectory: path.join(options.repoRoot, 'packages', 'openclaw-agent-vm-plugin'),
		packageName: 'openclaw-agent-vm-plugin',
	});
	const localOpenClawMcpPortalPluginTarballPath = await packLocalPackageTarball({
		packageDirectory: path.join(options.repoRoot, 'packages', 'openclaw-mcp-portal-plugin'),
		packageName: 'openclaw-mcp-portal-plugin',
	});
	const localPackageTarballs = [
		{
			archiveName: localPackageTarballArchiveName('config-contracts'),
			sourcePath: localConfigContractsTarballPath,
		},
		{
			archiveName: localPackageTarballArchiveName('gondolin-adapter'),
			sourcePath: localGondolinAdapterTarballPath,
		},
		{
			archiveName: localPackageTarballArchiveName('mcp-portal'),
			sourcePath: localMcpPortalTarballPath,
		},
		{
			archiveName: localPackageTarballArchiveName('openclaw-agent-vm-plugin'),
			sourcePath: localOpenClawAgentVmPluginTarballPath,
		},
		{
			archiveName: localPackageTarballArchiveName('openclaw-mcp-portal-plugin'),
			sourcePath: localOpenClawMcpPortalPluginTarballPath,
		},
	] satisfies readonly LocalDockerPackageTarball[];

	await fs.rm(dockerContextDirectory, { force: true, recursive: true });
	await fs.mkdir(dockerContextDirectory, { recursive: true });
	await copyLocalPackageTarballsToDockerContext({
		dockerContextDirectory,
		tarballs: localPackageTarballs,
	});
	await useLocalToolVmMcpPortalPackage({
		localConfigContractsTarballPath,
		localMcpPortalTarballPath,
		projectRoot: options.projectRoot,
		systemConfig: options.systemConfig,
	});

	await fs.writeFile(
		dockerfilePath,
		[
			`FROM ${baseImage.repository}:${baseImage.tag}`,
			'',
			'# Generated by the OpenClaw smoke harness from local package tarballs.',
			...localPackageTarballs.map(
				(tarball) => `COPY ${tarball.archiveName} /tmp/${tarball.archiveName}`,
			),
			'RUN mkdir -p /opt/agent-vm/local-packages && \\',
			'    npm install --omit=dev --no-audit --no-fund --prefix /opt/agent-vm/local-packages ' +
				localPackageTarballs.map((tarball) => `/tmp/${tarball.archiveName}`).join(' ') +
				' && \\',
			'    rm -f ' + localPackageTarballs.map((tarball) => `/tmp/${tarball.archiveName}`).join(' '),
			'RUN package_root="/opt/agent-vm/local-packages/node_modules" && \\',
			'    mkdir -p /home/openclaw/.openclaw/extensions /opt/agent-vm/portal/bin && \\',
			'    ln -sfn "$package_root/@agent-vm/openclaw-agent-vm-plugin/dist" /home/openclaw/.openclaw/extensions/gondolin && \\',
			'    ln -sfn "$package_root/@agent-vm/openclaw-mcp-portal-plugin/dist" /home/openclaw/.openclaw/extensions/mcp-portal && \\',
			'    printf \'%s\\n\' \'#!/bin/sh\' "exec node $package_root/@agent-vm/mcp-portal/dist/bin/portal-server.js \\"\\$@\\"" > /opt/agent-vm/portal/bin/agent-vm-mcp-portal-server && \\',
			'    chmod 0755 /opt/agent-vm/portal/bin/agent-vm-mcp-portal-server',
			'',
		].join('\n'),
		'utf8',
	);

	gatewayProfile.dockerfile = dockerfilePath;
	delete gatewayProfile.source;
}

export async function useLocalOpenClawPluginGatewayImage(options: {
	readonly profileName: string;
	readonly projectRoot: string;
	readonly repoRoot: string;
	readonly systemConfig: LoadedSystemConfig;
}): Promise<void> {
	await useLocalOpenClawGatewayImagePackages(options);
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

export async function prepareLocalWorkerPackageForGatewayImage(repoRoot: string): Promise<string> {
	await fs.mkdir(path.join(repoRoot, 'tmp'), { recursive: true });
	const packDirectory = await fs.mkdtemp(path.join(repoRoot, 'tmp', 'agent-vm-worker-pack-'));
	execFileSync('pnpm', ['pack', '--pack-destination', packDirectory], {
		cwd: path.join(repoRoot, 'packages', 'agent-vm-worker'),
		stdio: 'pipe',
	});
	const packedTarballs = (await fs.readdir(packDirectory)).filter((fileName) =>
		fileName.endsWith('.tgz'),
	);
	const [packedTarballName] = packedTarballs;
	if (packedTarballName === undefined) {
		throw new Error('Failed to pack local agent-vm-worker tarball for smoke image.');
	}
	if (packedTarballs.length > 1) {
		throw new Error('Expected pnpm pack to produce exactly one agent-vm-worker tarball.');
	}
	return path.join(packDirectory, packedTarballName);
}

export async function scaffoldWorkerSmokeProject(options: {
	readonly architecture: ImageArchitecture;
	readonly prefix: string;
	readonly zoneId: string;
}): Promise<WorkerSmokeProject> {
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), options.prefix));
	const controllerPort = await findAvailablePort();
	const gatewayPort = await findAvailablePort();
	await scaffoldAgentVmProject({
		architecture: options.architecture,
		gatewayType: 'worker',
		secretsProvider: '1password',
		targetDir: tempRoot,
		zoneId: options.zoneId,
	});
	const systemConfig = await loadSystemConfig(path.join(tempRoot, 'config', 'system.json'));
	systemConfig.host.controllerPort = controllerPort;
	systemConfig.host.projectNamespace = 'claw-tests-worker';
	systemConfig.cacheDir = path.join(tempRoot, 'cache');
	systemConfig.host.secretsProvider = {
		type: '1password',
		tokenSource: { type: 'env', envVar: 'OPEN_AI_TEST_KEY' },
	};
	const zone = getWorkerSmokeZone(systemConfig);
	zone.gateway.port = gatewayPort;
	return {
		controllerPort,
		gatewayPort,
		systemConfig,
		tempRoot,
		zone,
	};
}

export async function scaffoldGatewaySmokeProject(
	options: ScaffoldGatewaySmokeProjectOptions,
): Promise<GatewaySmokeProject> {
	if (options.kind === 'openclaw') {
		return await scaffoldOpenClawSmokeProject({
			architecture: options.architecture,
			prefix: options.prefix,
			zoneId: options.zoneId,
			...(options.agents ? { agents: options.agents } : {}),
		});
	}
	return await scaffoldWorkerSmokeProject({
		architecture: options.architecture,
		prefix: options.prefix,
		zoneId: options.zoneId,
	});
}

export async function writeOpenClawMcpPortalSmokeConfigs(options: {
	readonly agentId: string;
	readonly configDir: string;
	readonly namespace: string;
	readonly portalAccessHeaderName: string;
	readonly upstreamUrl: string;
}): Promise<void> {
	await fs.writeFile(
		path.join(options.configDir, 'mcp.config.jsonc'),
		`${JSON.stringify(
			{
				$schema: '../../schemas/mcp.schema.json',
				providers: {
					upstreamMock: {
						discovery: { summary: 'Mock upstream MCP server for smoke tests' },
						kind: 'mcp',
						namespace: options.namespace,
						transport: {
							kind: 'streamable-http',
							url: options.upstreamUrl,
						},
					},
				},
				schemaVersion: 1,
			},
			null,
			'\t',
		)}\n`,
		'utf8',
	);
	await fs.writeFile(
		path.join(options.configDir, 'mcp-portal.config.jsonc'),
		`${JSON.stringify(
			{
				$schema: '../../schemas/mcp-portal.schema.json',
				agents: {
					[options.agentId]: { profile: 'smoke' },
				},
				profiles: {
					smoke: {
						approval: {
							allowWithoutApprovalTools: [{ namespace: options.namespace, toolName: 'read_thing' }],
							alwaysAskTools: [{ namespace: options.namespace, toolName: 'write_thing' }],
							annotationPolicy: 'destructive-requires-approval',
							trustedAnnotationNamespaces: [],
							writeTools: [],
						},
						enabledNamespaces: [options.namespace],
						enabledToolsByNamespace: {
							[options.namespace]: ['read_thing', 'write_thing'],
						},
						hiddenToolsByNamespace: {},
						promptContext: { enabled: true, maxNamespaces: 12 },
					},
				},
				schemaVersion: 1,
				server: {
					accessHeader: {
						name: options.portalAccessHeaderName,
						secret: { name: 'MCP_PORTAL_SERVER_SECRET', source: 'environment' },
					},
					host: '127.0.0.1',
					port: 18790,
				},
			},
			null,
			'\t',
		)}\n`,
		'utf8',
	);
}

export async function startSmokeControllerRuntime(
	options: StartSmokeControllerRuntimeOptions,
): Promise<SmokeHarnessRuntime> {
	const restoreEnvironment = applySmokeEnvironment(options.secrets);
	const secretResolver = createSmokeSecretResolver(options.secrets);
	try {
		const runtime = await startControllerRuntime(options.startOptions, {
			createSecretResolver: async (): Promise<SecretResolver> => secretResolver,
			...(options.startHttpServer === undefined
				? {}
				: { startHttpServer: options.startHttpServer }),
			...(options.startGatewayZone === undefined &&
			options.tcpHostsOverride === undefined &&
			options.vfsMountsOverride === undefined
				? {}
				: {
						startGatewayZone: async (startGatewayOptions: StartGatewayZoneOptions) =>
							await (options.startGatewayZone ?? startGatewayZone)({
								...startGatewayOptions,
								tcpHostsOverride: {
									...startGatewayOptions.tcpHostsOverride,
									...options.tcpHostsOverride,
								},
								vfsMountsOverride: {
									...startGatewayOptions.vfsMountsOverride,
									...options.vfsMountsOverride,
								},
							}),
					}),
		});
		if (options.startHttpServer === undefined) {
			await waitForControllerReady(options.startOptions.systemConfig.host.controllerPort);
		}
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
