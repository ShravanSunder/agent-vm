import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { renderHermesManagedImageRecipe } from '@agent-vm/hermes-gateway';

import type { ImageArchitecture } from '../cli/init-command-schemas.js';
import { scaffoldAgentVmProject } from '../cli/init-command.js';
import { loadSystemConfig, type LoadedSystemConfig } from '../config/system-config.js';
import {
	buildLocalPythonWheel,
	canRunManagedVmE2e,
	copyLocalPackageTarballsToDockerContext,
	createLocalDockerPackageTarball,
	findAvailablePort,
	localDockerPackageDependencyName,
	packLocalAgentVmPackageTarball,
	removeE2eLocalPackageTarballs,
	requireLocalPackageTarballPath,
	resolveE2eCacheRoot,
	useLocalToolVmMcpPortalPackageTarballs,
	type LocalDockerPackageTarball,
	type ManagedVmE2ePrerequisiteOptions,
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
	readonly acceptanceMarker?: string;
	readonly contextLength: number;
	readonly fakeModelBaseUrl?: string;
	readonly fakeModelHost: string;
	readonly fakeModelName: string;
}

export async function shouldRunHermesE2e(
	options: ManagedVmE2ePrerequisiteOptions & {
		readonly env?: Partial<Record<'AGENT_VM_HERMES_E2E', string>>;
	},
): Promise<boolean> {
	const env = options.env ?? process.env;
	if (env.AGENT_VM_HERMES_E2E !== '1') return false;
	const prerequisitesAvailable = await canRunManagedVmE2e(options);
	if (!prerequisitesAvailable) {
		throw new Error(
			'AGENT_VM_HERMES_E2E=1 explicitly requested live Hermes proof, but Docker, QEMU, or the pinned Zig version is unavailable.',
		);
	}
	return true;
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

export const hermesE2eRootApiServerKey = 'hermes-e2e-root-api-server-key';

export function hermesE2eProfileApiServerKey(agentId: string): string {
	return `hermes-e2e-${agentId}-profile-api-server-key`;
}

export function hermesE2eProfileApiServerKeyEnvironmentName(agentId: string): string {
	return `API_SERVER_KEY_${agentId.toUpperCase().replaceAll(/[^A-Z0-9]/gu, '_')}_E2E`;
}

export function buildHermesE2eProfileApiServerKeySecrets(
	agentIds: readonly string[],
): Readonly<Record<string, string>> {
	return Object.fromEntries(
		agentIds.map((agentId) => [
			hermesE2eProfileApiServerKeyEnvironmentName(agentId),
			hermesE2eProfileApiServerKey(agentId),
		]),
	);
}

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
	if (packageSpecifiers['@agent-vm/gateway-runtime'] === undefined) {
		throw new Error('Hermes local image package set requires @agent-vm/gateway-runtime.');
	}
	return `${JSON.stringify(
		{
			type: 'module',
			dependencies: packageSpecifiers,
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
		...(options.acceptanceMarker === undefined
			? []
			: [`agent_vm_acceptance_marker: ${options.acceptanceMarker}`]),
		'model:',
		`  default: ${options.fakeModelName}`,
		'  provider: custom:hermes-e2e',
		`  context_length: ${String(options.contextLength)}`,
		'custom_providers:',
		'  - name: hermes-e2e',
		`    base_url: ${options.fakeModelBaseUrl ?? `http://${options.fakeModelHost}/v1`}`,
		'    api_mode: chat_completions',
		`    model: ${options.fakeModelName}`,
		'    models:',
		`      ${options.fakeModelName}:`,
		`        context_length: ${String(options.contextLength)}`,
		'fallback_providers:',
		'  - provider: custom:hermes-e2e',
		`    model: ${options.fakeModelName}`,
		'provider_routing:',
		'  order:',
		'    - hermes-e2e',
		'approvals:',
		"  mode: 'off'",
		'code_execution:',
		'  mode: project',
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
					executablePath:
						'/opt/agent-vm/local-packages/node_modules/@agent-vm/gateway-runtime/dist/bin/gateway-runtime.js',
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
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), options.prefix));
	const controllerPort = await findAvailablePort();
	const gatewayPort = await findAvailablePort();
	await scaffoldAgentVmProject({
		agents: options.agents,
		architecture: options.architecture,
		gatewayType: 'hermes',
		secretsProvider: 'environment',
		targetDir: tempRoot,
		zoneId: options.zoneId,
	});
	const systemConfig = await loadSystemConfig(path.join(tempRoot, 'config', 'system.jsonc'));
	const scaffoldedZone = systemConfig.zones[0];
	if (scaffoldedZone === undefined || scaffoldedZone.gateway.type !== 'hermes') {
		throw new Error('Hermes E2E scaffold requires a Hermes zone.');
	}
	const hermesConfigurationPath = scaffoldedZone.gateway.config;
	const hermesManagedConfigurationDirectory = path.dirname(hermesConfigurationPath);
	const hermesImageDirectory = path.join(tempRoot, 'vm-images', 'gateways', 'hermes');
	await Promise.all([
		fs.mkdir(hermesManagedConfigurationDirectory, { recursive: true }),
		fs.mkdir(hermesImageDirectory, { recursive: true }),
	]);
	await fs.writeFile(
		hermesConfigurationPath,
		'plugins:\n  enabled:\n    - agent-vm-tool-portal\n  disabled: []\n',
		'utf8',
	);
	systemConfig.imageProfiles.gateways = {
		hermes: {
			buildConfig: path.join(hermesImageDirectory, 'build-config.jsonc'),
			type: 'hermes',
		},
	};
	Object.assign(systemConfig, {
		cacheDir: path.join(resolveE2eCacheRoot(), 'hermes'),
	});
	systemConfig.host.controllerPort = controllerPort;
	systemConfig.host.projectNamespace = 'agent-vm-tests-hermes';
	systemConfig.zones[0] = {
		...scaffoldedZone,
		agents: options.agents.map((agentId) => ({ id: agentId })),
		gateway: {
			config: hermesConfigurationPath,
			cpus: scaffoldedZone.gateway.cpus,
			imageProfile: 'hermes',
			memory: scaffoldedZone.gateway.memory,
			profileSecretProjectionsByAgent: Object.fromEntries(
				options.agents.map((agentId) => [
					agentId,
					{
						API_SERVER_KEY: hermesE2eProfileApiServerKeyEnvironmentName(agentId),
						DISCORD_BOT_TOKEN: `DISCORD_BOT_TOKEN_${agentId.toUpperCase()}`,
					},
				]),
			),
			port: gatewayPort,
			profilesByAgent: Object.fromEntries(options.agents.map((agentId) => [agentId, agentId])),
			runtimeRootfsSize: scaffoldedZone.gateway.runtimeRootfsSize,
			stateDir: scaffoldedZone.gateway.stateDir,
			type: 'hermes',
			zoneFilesDir: scaffoldedZone.gateway.zoneFilesDir,
			zoneRuntimeDir: scaffoldedZone.gateway.zoneRuntimeDir,
		},
		secrets: {
			API_SERVER_KEY: {
				audience: 'gateway',
				injection: 'env',
				source: 'config',
				value: hermesE2eRootApiServerKey,
			},
			...Object.fromEntries(
				options.agents.map((agentId) => {
					const environmentName = hermesE2eProfileApiServerKeyEnvironmentName(agentId);
					return [
						environmentName,
						{
							audience: 'gateway' as const,
							envVar: environmentName,
							injection: 'env' as const,
							source: 'environment' as const,
						},
					];
				}),
			),
		},
	};
	const zone = getHermesE2eZone(systemConfig);
	return {
		controllerPort,
		gatewayPort,
		systemConfig,
		tempRoot,
		zone,
	};
}
