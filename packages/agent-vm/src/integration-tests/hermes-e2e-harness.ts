import fs from 'node:fs/promises';
import path from 'node:path';

import { renderHermesManagedImageRecipe } from '@agent-vm/hermes-gateway';

import type { ImageArchitecture } from '../cli/init-command.js';
import type { LoadedSystemConfig } from '../config/system-config.js';
import {
	buildLocalPythonWheel,
	copyLocalPackageTarballsToDockerContext,
	createLocalDockerPackageTarball,
	localDockerPackageDependencyName,
	packLocalAgentVmPackageTarball,
	removeE2eLocalPackageTarballs,
	requireLocalPackageTarballPath,
	resolveE2eCacheRoot,
	scaffoldOpenClawE2eProject,
	useLocalToolVmMcpPortalPackageTarballs,
	type LocalDockerPackageTarball,
} from './e2e-harness.js';

interface HermesE2eZone extends Omit<LoadedSystemConfig['zones'][number], 'gateway'> {
	readonly gateway: Extract<
		LoadedSystemConfig['zones'][number]['gateway'],
		{ readonly type: 'hermes' }
	>;
}

export interface HermesE2eProject {
	readonly controllerPort: number;
	readonly gatewayPort: number;
	readonly systemConfig: LoadedSystemConfig;
	readonly tempRoot: string;
	readonly zone: HermesE2eZone;
}

export interface RenderHermesManagedE2eConfigurationOptions {
	readonly contextLength: number;
	readonly fakeModelHost: string;
	readonly fakeModelName: string;
	readonly webhookPort: number;
	readonly webhookRoute: string;
	readonly webhookSecret: string;
}

const hermesGatewayLocalPackageNames = [
	'agent-portal-sdk',
	'config-contracts',
	'control-protocol-contracts',
	'controller-execution-contracts',
	'gateway-control-contracts',
	'secret-management',
	'mcp-portal',
	'tool-portal',
	'gateway-runtime',
] as const;

function getHermesE2eZone(systemConfig: LoadedSystemConfig): HermesE2eProject['zone'] {
	const zone = systemConfig.zones[0];
	if (!zone || zone.gateway.type !== 'hermes') {
		throw new Error('Expected smoke system config to contain a Hermes zone.');
	}
	return { ...zone, gateway: zone.gateway };
}

function renderHermesLocalPackageManifest(tarballs: readonly LocalDockerPackageTarball[]): string {
	const packageSpecifiers = Object.fromEntries(
		tarballs.map((tarball) => [
			localDockerPackageDependencyName(tarball),
			`file:./${tarball.archiveName}`,
		]),
	);
	const gatewayRuntimeSpecifier = packageSpecifiers['@agent-vm/gateway-runtime'];
	if (gatewayRuntimeSpecifier === undefined) {
		throw new Error('Hermes local image package set requires @agent-vm/gateway-runtime.');
	}
	return `${JSON.stringify(
		{
			type: 'module',
			dependencies: { '@agent-vm/gateway-runtime': gatewayRuntimeSpecifier },
			pnpm: { overrides: packageSpecifiers },
		},
		null,
		'\t',
	)}\n`;
}

export function renderHermesManagedE2eConfiguration(
	options: RenderHermesManagedE2eConfigurationOptions,
): string {
	return [
		'plugins:',
		'  enabled:',
		'    - agent-vm-tool-portal',
		'  disabled: []',
		'model:',
		`  default: ${options.fakeModelName}`,
		'  provider: custom:hermes-e2e',
		`  context_length: ${String(options.contextLength)}`,
		'custom_providers:',
		'  - name: hermes-e2e',
		`    base_url: http://${options.fakeModelHost}/v1`,
		'    api_key: hermes-e2e-test-key',
		'    api_mode: chat_completions',
		`    model: ${options.fakeModelName}`,
		'    models:',
		`      ${options.fakeModelName}:`,
		`        context_length: ${String(options.contextLength)}`,
		'approvals:',
		"  mode: 'off'",
		'code_execution:',
		'  mode: project',
		'platform_toolsets:',
		'  webhook:',
		'    - terminal',
		'    - file',
		'    - code_execution',
		'gateway:',
		'  multiplex_profiles: true',
		'platforms:',
		'  webhook:',
		'    enabled: true',
		'    extra:',
		'      host: 127.0.0.1',
		`      port: ${String(options.webhookPort)}`,
		'      routes:',
		`        ${options.webhookRoute}:`,
		`          secret: ${options.webhookSecret}`,
		"          prompt: 'PROFILE={profile}'",
		'          deliver: log',
		'',
	].join('\n');
}

export async function useLocalHermesGatewayImagePackages(options: {
	readonly architecture: ImageArchitecture;
	readonly profileName: string;
	readonly projectRoot: string;
	readonly repoRoot: string;
	readonly systemConfig: LoadedSystemConfig;
}): Promise<void> {
	const gatewayProfile = options.systemConfig.imageProfiles.gateways[options.profileName];
	if (gatewayProfile === undefined || gatewayProfile.type !== 'hermes') {
		throw new Error(`Hermes gateway image profile '${options.profileName}' is not configured.`);
	}
	const dockerContextDirectory = path.dirname(gatewayProfile.buildConfig);
	const localArtifactDirectory = path.join(dockerContextDirectory, 'local-agent-vm');
	const wheelOutputDirectory = path.join(options.projectRoot, 'tmp', 'hermes-e2e-wheels');
	await Promise.all([
		fs.mkdir(localArtifactDirectory, { recursive: true }),
		fs.mkdir(wheelOutputDirectory, { recursive: true }),
	]);
	const packedTarballPaths = await Promise.all(
		hermesGatewayLocalPackageNames.map(async (packageName) => ({
			packageName,
			sourcePath: await packLocalAgentVmPackageTarball({
				packageName,
				repoRoot: options.repoRoot,
			}),
		})),
	);
	try {
		const localPackageTarballs = packedTarballPaths.map(({ packageName, sourcePath }) =>
			createLocalDockerPackageTarball({ packageName, sourcePath }),
		);
		const [agentPortalSdkWheelPath, hermesAdapterWheelPath] = await Promise.all([
			buildLocalPythonWheel({
				distributionFilePrefix: 'agent_vm_agent_portal_sdk-',
				outputDirectory: wheelOutputDirectory,
				packageDirectory: path.join(options.repoRoot, 'python', 'agent-vm-agent-portal-sdk'),
				repoRoot: options.repoRoot,
			}),
			buildLocalPythonWheel({
				distributionFilePrefix: 'agent_vm_hermes_adapter-',
				outputDirectory: wheelOutputDirectory,
				packageDirectory: path.join(options.repoRoot, 'python', 'agent-vm-hermes-adapter'),
				repoRoot: options.repoRoot,
			}),
		]);
		await copyLocalPackageTarballsToDockerContext({
			dockerContextDirectory: localArtifactDirectory,
			tarballs: localPackageTarballs,
		});
		const agentPortalSdkWheelFileName = path.basename(agentPortalSdkWheelPath);
		const hermesAdapterWheelFileName = path.basename(hermesAdapterWheelPath);
		await Promise.all([
			fs.copyFile(
				agentPortalSdkWheelPath,
				path.join(localArtifactDirectory, agentPortalSdkWheelFileName),
			),
			fs.copyFile(
				hermesAdapterWheelPath,
				path.join(localArtifactDirectory, hermesAdapterWheelFileName),
			),
			fs.writeFile(
				path.join(localArtifactDirectory, 'package.json'),
				renderHermesLocalPackageManifest(localPackageTarballs),
				'utf8',
			),
		]);
		const recipe = renderHermesManagedImageRecipe({
			artifactContext: {
				kind: 'local-artifact-context',
				gatewayRuntime: {
					packageArchiveFiles: localPackageTarballs.map(
						(tarball) => `local-agent-vm/${tarball.archiveName}`,
					),
					packageManifestFile: 'local-agent-vm/package.json',
				},
				pythonWheels: {
					agentPortalSdk: `local-agent-vm/${agentPortalSdkWheelFileName}`,
					hermesAdapter: `local-agent-vm/${hermesAdapterWheelFileName}`,
				},
			},
			buildTarget: {
				architecture: options.architecture,
				kind: 'gondolin-custom-dockerfile',
				ociImage: `agent-vm-hermes-e2e:${options.architecture}`,
				rootfsSizeMb: 4096,
			},
		});
		await Promise.all([
			fs.writeFile(path.join(dockerContextDirectory, 'Dockerfile'), recipe.dockerfile, 'utf8'),
			fs.writeFile(
				gatewayProfile.buildConfig,
				`${JSON.stringify(recipe.buildConfig, null, '\t')}\n`,
				'utf8',
			),
			useLocalToolVmMcpPortalPackageTarballs({
				localAgentPortalSdkTarballPath: requireLocalPackageTarballPath(
					packedTarballPaths,
					'agent-portal-sdk',
				),
				localConfigContractsTarballPath: requireLocalPackageTarballPath(
					packedTarballPaths,
					'config-contracts',
				),
				localMcpPortalTarballPath: requireLocalPackageTarballPath(packedTarballPaths, 'mcp-portal'),
				localSecretManagementTarballPath: requireLocalPackageTarballPath(
					packedTarballPaths,
					'secret-management',
				),
				projectRoot: options.projectRoot,
				systemConfig: options.systemConfig,
			}),
		]);
		gatewayProfile.dockerfile = path.join(dockerContextDirectory, 'Dockerfile');
		delete gatewayProfile.source;
	} finally {
		await removeE2eLocalPackageTarballs(packedTarballPaths.map((entry) => entry.sourcePath));
	}
}

export async function scaffoldHermesE2eProject(options: {
	readonly agents: readonly string[];
	readonly architecture: ImageArchitecture;
	readonly prefix: string;
	readonly zoneId: string;
}): Promise<HermesE2eProject> {
	if (options.agents.length === 0 || new Set(options.agents).size !== options.agents.length) {
		throw new Error('Hermes E2E projects require a non-empty unique agent cohort.');
	}
	const openClawProject = await scaffoldOpenClawE2eProject({
		agents: options.agents,
		architecture: options.architecture,
		prefix: options.prefix,
		zoneId: options.zoneId,
	});
	const openClawZone = openClawProject.systemConfig.zones[0];
	if (openClawZone === undefined || openClawZone.gateway.type !== 'openclaw') {
		throw new Error('Hermes E2E scaffold requires the internal OpenClaw base fixture.');
	}
	const configDirectory = path.dirname(openClawZone.gateway.config);
	const hermesConfigurationPath = path.join(configDirectory, 'hermes.yaml');
	const hermesImageDirectory = path.join(
		openClawProject.tempRoot,
		'vm-images',
		'gateways',
		'hermes',
	);
	await Promise.all([
		fs.mkdir(hermesImageDirectory, { recursive: true }),
		fs.writeFile(
			hermesConfigurationPath,
			'plugins:\n  enabled:\n    - agent-vm-tool-portal\n  disabled: []\n',
			'utf8',
		),
	]);
	openClawProject.systemConfig.imageProfiles.gateways = {
		hermes: {
			buildConfig: path.join(hermesImageDirectory, 'build-config.jsonc'),
			type: 'hermes',
		},
	};
	openClawProject.systemConfig.cacheDir = path.join(resolveE2eCacheRoot(), 'hermes');
	openClawProject.systemConfig.host.projectNamespace = 'agent-vm-tests-hermes';
	openClawProject.systemConfig.zones[0] = {
		...openClawZone,
		agents: options.agents.map((agentId) => ({ id: agentId })),
		gateway: {
			config: hermesConfigurationPath,
			cpus: openClawZone.gateway.cpus,
			imageProfile: 'hermes',
			memory: openClawZone.gateway.memory,
			port: openClawZone.gateway.port,
			profilesByAgent: Object.fromEntries(options.agents.map((agentId) => [agentId, agentId])),
			runtimeRootfsSize: openClawZone.gateway.runtimeRootfsSize,
			stateDir: openClawZone.gateway.stateDir,
			type: 'hermes',
			zoneFilesDir: openClawZone.gateway.zoneFilesDir,
		},
		secrets: {
			API_SERVER_KEY: {
				audience: 'gateway',
				injection: 'env',
				source: 'config',
				value: 'hermes-e2e-api-server-key',
			},
		},
	};
	const zone = getHermesE2eZone(openClawProject.systemConfig);
	return {
		controllerPort: openClawProject.controllerPort,
		gatewayPort: openClawProject.gatewayPort,
		systemConfig: openClawProject.systemConfig,
		tempRoot: openClawProject.tempRoot,
		zone,
	};
}
