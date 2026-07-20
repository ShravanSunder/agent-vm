import { generateKeyPairSync } from 'node:crypto';
import { chmod, mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { managedToolPortalConfigSchema, mcpConfigSchema } from '@agent-vm/config-contracts';
import { deriveGatewayRuntimePortalSemanticSnapshot } from '@agent-vm/gateway-control-contracts';
import type { ManagedVm } from '@agent-vm/managed-vm';

import { readPreparedManagedVmImage } from '../build/prepared-gondolin-image-cache.js';
import { createManagedVmRuntimeComposition } from '../composition/gondolin-managed-vm-provider.js';
import {
	prepareGatewayE2eProjectImages,
	removeE2eTempRoot,
	scaffoldOpenClawE2eProject,
	useLocalOpenClawPluginGatewayImage,
} from './e2e-harness.js';

export const managedGatewayBootInputGuestRoot = '/run/agent-vm/managed-gateway';
export const managedGatewayBootInputStagingGuestRoot = '/run/agent-vm/managed-gateway-inputs';
export const managedGatewayBootSecretCanary = 'managed-gateway-image-boot-secret-canary';

export type ManagedGatewayBootInputFileName = 'framework-service.json' | 'tool-portal-service.json';

type OpenClawE2eProject = Awaited<ReturnType<typeof scaffoldOpenClawE2eProject>>;
type PreparedManagedGatewayImage = NonNullable<
	Awaited<ReturnType<typeof readPreparedManagedVmImage>>
>;

export interface ManagedGatewayImageBootFixture {
	readonly close: () => Promise<void>;
	readonly preparedImage: PreparedManagedGatewayImage;
	readonly project: OpenClawE2eProject;
	readonly vm: ManagedVm;
}

function serviceConfig(verifierPublicKeyPem: string, identitySuffix?: string): object {
	const gatewayIdentitySuffix = identitySuffix ?? 'image-boot';
	const processIdentitySuffix = identitySuffix ?? 'image-owned';
	const mcpConfig = mcpConfigSchema.parse({ providers: {}, schemaVersion: 1 });
	const toolPortalConfig = managedToolPortalConfigSchema.parse({
		agents: { main: { profile: 'default' } },
		mode: 'managed',
		profiles: { default: { namespaces: {} } },
		schemaVersion: 1,
	});
	const semanticSnapshot = deriveGatewayRuntimePortalSemanticSnapshot({
		agentProjections: [
			{
				agentId: 'main',
				frameworkIdentity: { agentId: 'main', kind: 'openclaw' },
				toolPortalProfileId: 'default',
			},
		],
		mcpConfig,
		surfaceEligibilityByProfile: { default: {} },
		toolPortalConfig,
	});
	return {
		artifactLimits: {
			maximumArtifactBytes: 1_024,
			maximumArtifactCount: 8,
			maximumLifetimeMs: 60_000,
			maximumTotalBytes: 8_192,
		},
		attachment: {
			attachmentGeneration: 1,
			clientKind: 'openclaw-managed-plugin',
			configuredAgentIds: ['main'],
			frameworkEpoch: `framework-epoch-${gatewayIdentitySuffix}`,
			gatewayEpoch: `gateway-epoch-${gatewayIdentitySuffix}`,
			projectionCohortDigest: semanticSnapshot.projectionCohortDigest,
			runtimeEpoch: `runtime-epoch-${gatewayIdentitySuffix}`,
		},
		controlEndpoint: {
			authority: {
				callerContextAgentAuthorityKeys: { main: 'main-authority-key' },
				callerContextProofKey: 'caller-context-proof-key',
				verifierPublicKeyPem,
			},
			identity: {
				bootId: `boot-${processIdentitySuffix}`,
				controllerEpoch: 'controller-epoch-image-owned',
				generationId: `generation-${processIdentitySuffix}`,
				peerId: 'peer-image-owned',
				processEpoch: `process-epoch-${processIdentitySuffix}`,
				zoneId: 'managed-gateway-image-boot',
			},
			listen: { host: '127.0.0.1', port: 18_790 },
		},
		mcpConfigPath: `${managedGatewayBootInputGuestRoot}/mcp.config.json`,
		runtimeRoot: '/run/agent-vm/gateway-runtime',
		schemaVersion: 1,
		semanticSnapshot,
		serviceIdentity: {
			processEpoch: `process-epoch-${processIdentitySuffix}`,
			role: 'tool-portal',
			serviceId: `tool-portal-${processIdentitySuffix}`,
		},
		toolPortalConfig,
	};
}

function openClawConfig(): object {
	return {
		channels: {},
		gateway: {
			auth: {
				mode: 'token',
				token: { id: 'OPENCLAW_GATEWAY_TOKEN', provider: 'default', source: 'env' },
			},
			bind: 'loopback',
			mode: 'local',
			port: 18_789,
		},
		plugins: {
			allow: ['memory-core'],
			entries: { 'memory-core': { enabled: true } },
			slots: { memory: 'memory-core' },
		},
	};
}

async function writeProtectedBootInputs(props: {
	readonly hostDirectory: string;
	readonly identitySuffix?: string;
	readonly omittedInputFileName?: ManagedGatewayBootInputFileName;
}): Promise<void> {
	await mkdir(props.hostDirectory, { mode: 0o700, recursive: true });
	await chmod(props.hostDirectory, 0o700);
	const { publicKey } = generateKeyPairSync('ed25519');
	const verifierPublicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
	const inputFiles = new Map<string, string>([
		[
			'framework.environment.sh',
			[
				'export HOME=/home/openclaw',
				'export OPENCLAW_HOME=/home/openclaw',
				`export OPENCLAW_CONFIG_PATH=${managedGatewayBootInputGuestRoot}/framework-service.json`,
				'export OPENCLAW_STATE_DIR=/home/openclaw/.openclaw',
				`export OPENCLAW_GATEWAY_TOKEN=${managedGatewayBootSecretCanary}`,
				'export PATH=/pnpm:/usr/local/bin:/usr/bin:/bin',
				'',
			].join('\n'),
		],
		['mcp.config.json', `${JSON.stringify({ providers: {}, schemaVersion: 1 })}\n`],
		['framework-service.json', `${JSON.stringify(openClawConfig())}\n`],
		[
			'tool-portal-service.json',
			`${JSON.stringify(serviceConfig(verifierPublicKeyPem, props.identitySuffix))}\n`,
		],
		[
			'tool-portal.environment.sh',
			'export HOME=/home/openclaw\nexport PATH=/pnpm:/usr/local/bin:/usr/bin:/bin\n',
		],
	]);
	if (props.omittedInputFileName !== undefined) {
		inputFiles.delete(props.omittedInputFileName);
	}
	await Promise.all(
		[...inputFiles].map(async ([fileName, contents]) => {
			const filePath = path.join(props.hostDirectory, fileName);
			await writeFile(filePath, contents, { mode: 0o600 });
			await chmod(filePath, 0o600);
			const fileStatus = await stat(filePath);
			if (!fileStatus.isFile() || (fileStatus.mode & 0o777) !== 0o600) {
				throw new Error(`Managed Gateway boot input '${fileName}' is not a mode-0600 file.`);
			}
		}),
	);
}

export async function createManagedGatewayImageBootFixture(props: {
	readonly identitySuffix?: string;
	readonly omittedInputFileName?: ManagedGatewayBootInputFileName;
	readonly sessionLabel: string;
}): Promise<ManagedGatewayImageBootFixture> {
	const project = await scaffoldOpenClawE2eProject({
		agents: ['main'],
		architecture: process.arch === 'arm64' ? 'aarch64' : 'x86_64',
		prefix: 'agent-vm-e2e-harness-managed-gateway-image-boot-',
		zoneId: 'managed-gateway-image-boot',
	});
	let vm: ManagedVm | undefined;
	try {
		const profileName = project.zone.gateway.imageProfile;
		const gatewayProfile = project.systemConfig.imageProfiles.gateways[profileName];
		if (gatewayProfile === undefined) {
			throw new Error(`OpenClaw image profile '${profileName}' is missing.`);
		}
		await useLocalOpenClawPluginGatewayImage({
			profileName,
			projectRoot: project.tempRoot,
			repoRoot: process.cwd(),
			systemConfig: project.systemConfig,
		});
		await prepareGatewayE2eProjectImages({ project });
		const preparedImage = await readPreparedManagedVmImage({
			buildConfigPath: gatewayProfile.buildConfig,
			cacheDir: path.join(project.systemConfig.cacheDir, 'gateway-images', profileName),
		});
		if (preparedImage === undefined) {
			throw new Error(
				'OpenClaw managed image preparation did not publish a prepared-image receipt.',
			);
		}
		const bootInputHostDirectory = path.join(project.tempRoot, 'managed-gateway-boot-inputs');
		await writeProtectedBootInputs({
			hostDirectory: bootInputHostDirectory,
			...(props.identitySuffix === undefined ? {} : { identitySuffix: props.identitySuffix }),
			...(props.omittedInputFileName === undefined
				? {}
				: { omittedInputFileName: props.omittedInputFileName }),
		});
		vm = await createManagedVmRuntimeComposition().managedVmFactory.createManagedVm({
			allowedHosts: [],
			environment: {},
			imageReference: preparedImage.imagePath,
			mediatedSecrets: [],
			mounts: {
				[managedGatewayBootInputStagingGuestRoot]: {
					access: 'read-only',
					hostPath: bootInputHostDirectory,
					kind: 'host-directory',
				},
			},
			resources: {
				cpuCount: project.zone.gateway.cpus,
				memory: project.zone.gateway.memory,
			},
			rootfsMode: 'cow',
			...(project.zone.gateway.runtimeRootfsSize === undefined
				? {}
				: { runtimeRootfsSize: project.zone.gateway.runtimeRootfsSize }),
			sessionLabel: props.sessionLabel,
			tcpHosts: [],
		});
		return {
			close: async (): Promise<void> => {
				await vm?.close();
				await removeE2eTempRoot(project.tempRoot);
			},
			preparedImage,
			project,
			vm,
		};
	} catch (error: unknown) {
		await vm?.close();
		await removeE2eTempRoot(project.tempRoot);
		throw error;
	}
}

export async function startManagedGatewayImageBootFixture(props: {
	readonly identitySuffix?: string;
	readonly omittedInputFileName?: ManagedGatewayBootInputFileName;
	readonly sessionLabel: string;
}): Promise<ManagedGatewayImageBootFixture> {
	const fixture = await createManagedGatewayImageBootFixture(props);
	try {
		await fixture.vm.start();
		return fixture;
	} catch (error: unknown) {
		await fixture.close();
		throw error;
	}
}
