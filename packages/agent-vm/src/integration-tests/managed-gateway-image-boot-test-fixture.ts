import { generateKeyPairSync } from 'node:crypto';
import path from 'node:path';

import {
	createGatewayRuntimeManagedToolPortalConfig,
	managedToolPortalConfigSchema,
	mcpConfigSchema,
} from '@agent-vm/config-contracts';
import {
	deriveGatewayRuntimeInputRevision,
	deriveGatewayRuntimePortalSemanticSnapshot,
} from '@agent-vm/gateway-control-contracts';
import type { ManagedVm, ManagedVmFinalizableMemoryFile } from '@agent-vm/managed-vm';

import { readPreparedManagedVmImage } from '../build/prepared-gondolin-image-cache.js';
import { createManagedVmRuntimeComposition } from '../composition/gondolin-managed-vm-provider.js';
import { prepareGatewayE2eProjectImages, removeE2eTempRoot } from './e2e-harness.js';
import {
	scaffoldHermesE2eProject,
	useLocalHermesGatewayImagePackages,
	type HermesE2eProject,
} from './hermes-e2e-harness.js';

export const managedGatewayBootInputGuestRoot = '/run/agent-vm/managed-gateway';
export const managedGatewayBootEnvironmentGuestRoot = '/run/agent-vm/managed-gateway-environment';

export type ManagedGatewayBootInputFileName = 'framework-service.json' | 'tool-portal-service.json';

type PreparedManagedGatewayImage = NonNullable<
	Awaited<ReturnType<typeof readPreparedManagedVmImage>>
>;

export interface ManagedGatewayImageBootFixture {
	readonly close: () => Promise<void>;
	readonly preparedImage: PreparedManagedGatewayImage;
	readonly project: HermesE2eProject;
	readonly vm: ManagedVm;
}

interface ManagedGatewayImageBootInputInventories {
	readonly environmentFiles: readonly ManagedVmFinalizableMemoryFile[];
	readonly structuredInputFiles: readonly ManagedVmFinalizableMemoryFile[];
}

function createToolPortalServiceConfig(
	verifierPublicKeyPem: string,
	identitySuffix?: string,
): object {
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
				frameworkIdentity: { kind: 'hermes', profileName: 'main' },
				toolPortalNamespaceNames: [],
				toolPortalProfileId: 'default',
			},
		],
		mcpConfig,
		surfaceEligibilityByProfile: { default: {} },
		toolPortalConfig,
	});
	const effectiveToolPortalConfig = createGatewayRuntimeManagedToolPortalConfig(toolPortalConfig);
	return {
		artifactLimits: {
			maximumArtifactBytes: 1_024,
			maximumArtifactCount: 8,
			maximumLifetimeMs: 60_000,
			maximumTotalBytes: 8_192,
		},
		attachment: {
			attachmentGeneration: 1,
			clientKind: 'hermes-managed-plugin',
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
		gatewayRuntimeInputRevision: deriveGatewayRuntimeInputRevision({
			mcpConfig,
			toolPortalConfig: effectiveToolPortalConfig,
		}),
		mcpConfigPath: `${managedGatewayBootInputGuestRoot}/mcp.config.json`,
		observability: { kind: 'disabled' },
		runtimeRoot: '/run/agent-vm/gateway-runtime',
		schemaVersion: 1,
		semanticSnapshot,
		serviceIdentity: {
			processEpoch: `process-epoch-${processIdentitySuffix}`,
			role: 'tool-portal',
			serviceId: `tool-portal-${processIdentitySuffix}`,
		},
		toolPortalConfig: effectiveToolPortalConfig,
	};
}

function createMemoryFile(relativePath: string, contents: string): ManagedVmFinalizableMemoryFile {
	return {
		contents: new TextEncoder().encode(contents),
		mode: 0o600,
		relativePath,
	};
}

function shellSingleQuote(value: string): string {
	return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function renderEnvironment(environment: Readonly<Record<string, string>>): string {
	return `${Object.entries(environment)
		.toSorted(([leftName], [rightName]) => leftName.localeCompare(rightName))
		.map(([name, value]) => `export ${name}=${shellSingleQuote(value)}`)
		.join('\n')}\n`;
}

async function buildProtectedBootInputs(props: {
	readonly identitySuffix?: string;
	readonly omittedInputFileName?: ManagedGatewayBootInputFileName;
	readonly project: HermesE2eProject;
}): Promise<ManagedGatewayImageBootInputInventories> {
	const { publicKey } = generateKeyPairSync('ed25519');
	const verifierPublicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
	const frameworkBootInputs = {
		configuration: {},
		environment: {
			AGENT_VM_HERMES_MANAGED_CONFIG_PATH: '/run/agent-vm/managed-gateway/framework-service.json',
			HOME: '/home/hermes',
			PATH: '/opt/hermes/.venv/bin:/usr/local/bin:/usr/bin:/bin',
		},
	};
	const environmentFiles = [
		createMemoryFile(
			'framework.environment.sh',
			renderEnvironment(frameworkBootInputs.environment),
		),
		createMemoryFile(
			'tool-portal.environment.sh',
			'export HOME=/home/hermes\nexport PATH=/pnpm:/usr/local/bin:/usr/bin:/bin\n',
		),
	];
	const structuredInputContents = new Map<
		ManagedGatewayBootInputFileName | 'mcp.config.json',
		string
	>([
		['mcp.config.json', `${JSON.stringify({ providers: {}, schemaVersion: 1 })}\n`],
		['framework-service.json', `${JSON.stringify(frameworkBootInputs.configuration)}\n`],
		[
			'tool-portal-service.json',
			`${JSON.stringify(createToolPortalServiceConfig(verifierPublicKeyPem, props.identitySuffix))}\n`,
		],
	]);
	if (props.omittedInputFileName !== undefined) {
		structuredInputContents.delete(props.omittedInputFileName);
	}
	return {
		environmentFiles,
		structuredInputFiles: [...structuredInputContents].map(([fileName, contents]) =>
			createMemoryFile(fileName, contents),
		),
	};
}

export async function createManagedGatewayImageBootFixture(props: {
	readonly environmentMountAccess?: 'read-only' | 'read-write';
	readonly identitySuffix?: string;
	readonly omittedInputFileName?: ManagedGatewayBootInputFileName;
	readonly sessionLabel: string;
}): Promise<ManagedGatewayImageBootFixture> {
	const architecture = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
	const project = await scaffoldHermesE2eProject({
		agents: ['main'],
		architecture,
		prefix: 'agent-vm-e2e-harness-managed-gateway-image-boot-',
		zoneId: 'managed-gateway-image-boot',
	});
	let vm: ManagedVm | undefined;
	try {
		const profileName = project.zone.gateway.imageProfile;
		const gatewayProfile = project.systemConfig.imageProfiles.gateways[profileName];
		if (gatewayProfile === undefined || gatewayProfile.type !== 'hermes') {
			throw new Error(`Hermes image profile '${profileName}' is missing.`);
		}
		await useLocalHermesGatewayImagePackages({
			architecture,
			profileName,
			projectRoot: project.tempRoot,
			repoRoot: process.cwd(),
			systemConfig: project.systemConfig,
		});
		await prepareGatewayE2eProjectImages({ imageFamilies: ['gateway'], project });
		const preparedImage = await readPreparedManagedVmImage({
			buildConfigPath: gatewayProfile.buildConfig,
			cacheDir: path.join(project.systemConfig.cacheDir, 'gateway-images', profileName),
		});
		if (preparedImage === undefined) {
			throw new Error('Hermes image preparation did not publish a prepared-image receipt.');
		}
		const bootInputs = await buildProtectedBootInputs({
			project,
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
				[managedGatewayBootEnvironmentGuestRoot]: {
					access: props.environmentMountAccess ?? 'read-write',
					kind: 'finalizable-memory',
				},
				[managedGatewayBootInputGuestRoot]: {
					access: 'read-only',
					kind: 'finalizable-memory',
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
		if (vm.finalizeMemoryMount === undefined) {
			throw new Error(`Managed Gateway fixture VM '${vm.id}' lacks finalizable memory mounts.`);
		}
		await vm.finalizeMemoryMount({
			files: bootInputs.environmentFiles,
			guestPath: managedGatewayBootEnvironmentGuestRoot,
		});
		await vm.finalizeMemoryMount({
			files: bootInputs.structuredInputFiles,
			guestPath: managedGatewayBootInputGuestRoot,
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
	readonly environmentMountAccess?: 'read-only' | 'read-write';
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
