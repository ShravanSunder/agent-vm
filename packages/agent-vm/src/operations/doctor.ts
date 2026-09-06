import { access, lstat } from 'node:fs/promises';
import path from 'node:path';

import type {
	BuildGatewayVmRequirementsOptions,
	GatewayVmRequirements,
	GatewayZoneConfig,
} from '@agent-vm/gateway-lifecycle';
import { workerLifecycle } from '@agent-vm/worker-gateway';

import {
	loadManagedImageOverlay,
	type ManagedImageRelease,
	type ManagedImageSource,
} from '../build/managed-image-dockerfile.js';
import {
	emptyPackageOverrides,
	type EffectivePackageOverrides,
	type PackageOverrides,
	resolveEffectivePackageOverrides,
} from '../build/package-overrides.js';
import { buildZigInstallHint, checkManagedVmZigCompatibility } from '../build/zig-compatibility.js';
import {
	gatewayFrameworkCacheDirForSystemConfig,
	type LoadedSystemConfig,
	type SystemConfig,
} from '../config/system-config.js';
import { scanLegacyControllerRecordEvidence as scanGatewayStateAuthorityEvidenceDefault } from '../controller/durable-state/legacy-controller-record-evidence.js';
import { resolveManagedAgentRootPaths } from '../gateway/managed-agent-root-storage.js';
import { buildManagedAgentSecretAccessChecks } from './agent-secret-access-checks.js';
import { hasRuntimeConfigReferences, isRuntimeSystemConfigPath } from './runtime-config-paths.js';

export interface DoctorCheck {
	readonly name: string;
	readonly ok: boolean;
	readonly hint?: string;
	readonly value?: number | string;
}

export interface RunControllerDoctorOptions {
	readonly availableBinaries?: ReadonlySet<string>;
	readonly diskFreeBytes?: number;
	readonly dockerDaemonReady?: boolean;
	readonly env: NodeJS.ProcessEnv;
	readonly occupiedPorts?: ReadonlySet<number>;
	readonly nodeVersion: string;
	readonly requiredZigVersion?: string;
	readonly scanGatewayStateAuthorityEvidence?: typeof scanGatewayStateAuthorityEvidenceDefault;
	readonly systemConfig: SystemConfig;
	readonly totalMemoryBytes?: number;
	readonly workerGatewayVmRequirementsBuilder?: (
		options: BuildGatewayVmRequirementsOptions,
	) => Pick<GatewayVmRequirements, 'mounts'>;
	readonly zigVersion?: string;
}

export interface ControllerDoctorResult {
	readonly ok: boolean;
	readonly checks: DoctorCheck[];
}

function checkAnyBinary(
	name: string,
	binaryNames: readonly string[],
	installHint: string,
	availableBinaries: ReadonlySet<string>,
): DoctorCheck {
	const foundBinary = binaryNames.find((binaryName) => availableBinaries.has(binaryName));
	return {
		name,
		ok: foundBinary !== undefined,
		...(foundBinary ? { hint: foundBinary } : { hint: installHint }),
	};
}

function buildZigVersionCheck(
	zigVersion: string | undefined,
	requiredZigVersion: string | undefined,
): DoctorCheck | null {
	if (!zigVersion && !requiredZigVersion) {
		return null;
	}
	if (!zigVersion) {
		return {
			name: 'zig-version',
			ok: false,
			hint: buildZigInstallHint(requiredZigVersion),
		};
	}
	if (!requiredZigVersion) {
		return {
			name: 'zig-version',
			ok: true,
			value: zigVersion,
		};
	}
	const compatibility = checkManagedVmZigCompatibility({
		requiredVersion: requiredZigVersion,
		installedVersion: zigVersion,
	});
	return {
		name: 'zig-version',
		ok: compatibility.compatible,
		value: zigVersion,
		...(!compatibility.compatible ? { hint: compatibility.hint } : {}),
	};
}

function hasDockerBackedImageProfiles(systemConfig: SystemConfig): boolean {
	const gatewayProfiles = Object.values(systemConfig.imageProfiles.gateways);
	const toolVmProfiles = Object.values(systemConfig.imageProfiles.toolVms);
	const hasDockerBackedImageProfile = [...gatewayProfiles, ...toolVmProfiles].some(
		(profile) => profile.dockerfile !== undefined || profile.source !== undefined,
	);
	const hasManagedObservabilityStack =
		systemConfig.host.observability?.enabled === true &&
		systemConfig.host.observability.stack.mode === 'managed';
	return hasDockerBackedImageProfile || hasManagedObservabilityStack;
}

function buildDockerChecks(
	systemConfig: SystemConfig,
	availableBinaries: ReadonlySet<string>,
	dockerDaemonReady: boolean | undefined,
): readonly DoctorCheck[] {
	if (!hasDockerBackedImageProfiles(systemConfig)) {
		return [];
	}

	const dockerCliReady = availableBinaries.has('docker');
	return [
		{
			name: 'docker-cli',
			ok: dockerCliReady,
			...(dockerCliReady
				? { hint: 'docker' }
				: {
						hint: 'Install and start a Docker-compatible runtime. On macOS: brew install --cask orbstack && open -a OrbStack.',
					}),
		},
		{
			name: 'docker-daemon',
			ok: dockerCliReady && dockerDaemonReady === true,
			...(dockerCliReady && dockerDaemonReady === true
				? { hint: 'docker info' }
				: {
						hint: 'Start Docker/OrbStack and verify with: docker info',
					}),
		},
	];
}

function buildObservabilityEnabledCheck(systemConfig: SystemConfig): DoctorCheck {
	const observability = systemConfig.host.observability;
	if (observability?.enabled === true) {
		return {
			name: 'observability-enabled',
			ok: true,
			hint: observability.stack.mode,
		};
	}
	return {
		name: 'observability-enabled',
		ok: true,
		hint: 'Recommended: enable host.observability with stack.mode managed for a local Victoria stack, or stack.mode external plus stack.scrubbing.responsibility external-collector for a shared collector.',
	};
}

function isSameOrDescendantPath(childPath: string, parentPath: string): boolean {
	const relativePath = path.relative(path.resolve(parentPath), path.resolve(childPath));
	return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function pathsOverlap(firstPath: string, secondPath: string): boolean {
	return (
		isSameOrDescendantPath(firstPath, secondPath) || isSameOrDescendantPath(secondPath, firstPath)
	);
}

export function buildRuntimePathIsolationChecks(
	systemConfig: SystemConfig,
): readonly DoctorCheck[] {
	const failedChecks: DoctorCheck[] = [];
	if (pathsOverlap(systemConfig.controllerRuntimeDir, systemConfig.cacheDir)) {
		failedChecks.push({
			name: 'runtime-path-isolation-cacheDir',
			ok: false,
			hint: 'controllerRuntimeDir must not overlap cacheDir',
		});
	}
	for (const zone of systemConfig.zones) {
		if (pathsOverlap(systemConfig.controllerRuntimeDir, zone.gateway.stateDir)) {
			failedChecks.push({
				name: `runtime-path-isolation-stateDir-${zone.id}`,
				ok: false,
				hint: `controllerRuntimeDir must not overlap stateDir for zone '${zone.id}'`,
			});
		}
		if (
			zone.gateway.type === 'hermes' &&
			pathsOverlap(systemConfig.controllerRuntimeDir, zone.gateway.zoneFilesDir)
		) {
			failedChecks.push({
				name: `runtime-path-isolation-zoneFilesDir-${zone.id}`,
				ok: false,
				hint: `controllerRuntimeDir must not overlap zoneFilesDir for zone '${zone.id}'`,
			});
		}
	}
	return failedChecks.length > 0
		? failedChecks
		: [
				{
					name: 'runtime-path-isolation',
					ok: true,
					hint: systemConfig.controllerRuntimeDir,
				},
			];
}

export function buildRuntimePathIsolationCheck(systemConfig: SystemConfig): DoctorCheck {
	return (
		buildRuntimePathIsolationChecks(systemConfig)[0] ?? {
			name: 'runtime-path-isolation',
			ok: true,
			hint: systemConfig.controllerRuntimeDir,
		}
	);
}

type ManagedAgentRootDirectoryObservation = 'missing' | 'real-directory' | 'unsafe';

async function observeManagedAgentRootDirectory(
	directoryPath: string,
): Promise<ManagedAgentRootDirectoryObservation> {
	try {
		const status = await lstat(directoryPath);
		return status.isDirectory() && !status.isSymbolicLink() ? 'real-directory' : 'unsafe';
	} catch (error) {
		if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
			return 'missing';
		}
		return 'unsafe';
	}
}

export async function collectManagedAgentRootStorageChecks(
	systemConfig: SystemConfig,
): Promise<readonly DoctorCheck[]> {
	const checksByZone = await Promise.all(
		systemConfig.zones.map(async (zone): Promise<readonly DoctorCheck[]> => {
			if (zone.gateway.type !== 'hermes') {
				return [];
			}
			const zoneFilesDir = zone.gateway.zoneFilesDir;
			return await Promise.all(
				(zone.agents ?? []).map(async (agent): Promise<DoctorCheck> => {
					const rootPaths = resolveManagedAgentRootPaths({
						agentId: agent.id,
						zoneFilesDir,
					});
					const workspaceObservation = await observeManagedAgentRootDirectory(
						rootPaths.hostWorkspaceRoot,
					);
					return {
						name: `managed-agent-workspace-${zone.id}-${agent.id}`,
						ok: workspaceObservation !== 'unsafe',
						hint:
							workspaceObservation === 'missing'
								? 'pending controller materialization'
								: workspaceObservation === 'real-directory'
									? rootPaths.hostWorkspaceRoot
									: `workspace=${workspaceObservation}; the workspace must be a real directory or absent before controller materialization`,
					};
				}),
			);
		}),
	);
	return checksByZone.flat();
}

function isWorkerRootfsWorkMountPath(guestPath: string): boolean {
	return guestPath === '/work' || guestPath.startsWith('/work/');
}

function buildWorkerWorkRootfsChecks(
	systemConfig: SystemConfig,
	buildWorkerVmSpec: (
		options: BuildGatewayVmRequirementsOptions,
	) => Pick<GatewayVmRequirements, 'mounts'>,
): readonly DoctorCheck[] {
	return systemConfig.zones
		.filter((zone) => zone.gateway.type === 'worker')
		.map((zone) => {
			const gatewayZone: GatewayZoneConfig = {
				id: zone.id,
				gateway: {
					type: 'worker',
					cpus: zone.gateway.cpus,
					config: zone.gateway.config,
					memory: zone.gateway.memory,
					port: zone.gateway.port,
					stateDir: zone.gateway.stateDir,
				},
				secrets: zone.secrets,
				egressHosts: zone.egressHosts,
			};
			const vmSpec = buildWorkerVmSpec({
				controllerPort: systemConfig.host.controllerPort,
				gatewayCacheDir: gatewayFrameworkCacheDirForSystemConfig(systemConfig, zone.id),
				projectNamespace: systemConfig.host.projectNamespace,
				resolvedSecrets: {},
				zoneRuntimeDir: zone.gateway.zoneRuntimeDir,
				tcpPool: systemConfig.tcpPool,
				zone: gatewayZone,
			});
			const vfsWorkMount = Object.keys(vmSpec.mounts).find(isWorkerRootfsWorkMountPath);
			if (vfsWorkMount) {
				return {
					name: `worker-work-rootfs-${zone.id}`,
					ok: false,
					hint: `Worker zone '${zone.id}' mounts '${vfsWorkMount}' through VFS; /work must stay on rootfs/COW.`,
				} satisfies DoctorCheck;
			}
			return {
				name: `worker-work-rootfs-${zone.id}`,
				ok: true,
				hint: '/work stays on rootfs/COW',
			} satisfies DoctorCheck;
		});
}

function buildZoneToolVmProfileChecks(systemConfig: SystemConfig): readonly DoctorCheck[] {
	return systemConfig.zones.flatMap((zone) => {
		if (zone.gateway.type !== 'hermes') {
			return [];
		}
		const agentToolVmProfileChecks = Object.entries(zone.agentToolVmProfiles ?? {}).map(
			([agentId, toolVmProfileId]) =>
				({
					name: `zone-agent-tool-vm-profile-${zone.id}-${agentId}`,
					ok: true,
					hint: toolVmProfileId,
				}) satisfies DoctorCheck,
		);
		return [
			zone.defaultToolVmProfile
				? {
						name: `zone-default-tool-vm-profile-${zone.id}`,
						ok: true,
						hint: zone.defaultToolVmProfile,
					}
				: {
						name: `zone-default-tool-vm-profile-${zone.id}`,
						ok: false,
						hint: 'missing defaultToolVmProfile',
					},
			...agentToolVmProfileChecks,
		] as const satisfies readonly DoctorCheck[];
	});
}

function buildLegacyDockerfileImageProfileChecks(
	systemConfig: SystemConfig,
): readonly DoctorCheck[] {
	const gatewayChecks = Object.entries(systemConfig.imageProfiles.gateways)
		.filter(([, profile]) => profile.type !== 'hermes' && profile.dockerfile !== undefined)
		.map(
			([profileName]) =>
				({
					name: `legacy-dockerfile-image-profile-gateway-${profileName}`,
					ok: false,
					hint: 'Run agent-vm migrate images to switch this profile to a managed base overlay.',
				}) satisfies DoctorCheck,
		);
	const toolVmChecks = Object.entries(systemConfig.imageProfiles.toolVms)
		.filter(([, profile]) => profile.dockerfile !== undefined)
		.map(
			([profileName]) =>
				({
					name: `legacy-dockerfile-image-profile-toolVm-${profileName}`,
					ok: false,
					hint: 'Run agent-vm migrate images to switch this profile to a managed base overlay.',
				}) satisfies DoctorCheck,
		);
	return [...gatewayChecks, ...toolVmChecks];
}

function formatImageProfileHint(profile: {
	readonly type: string;
	readonly source?: { readonly kind: 'managedBase'; readonly base: string } | undefined;
}): string {
	if (!profile.source) {
		return `type=${profile.type}`;
	}
	return `type=${profile.type} source=${profile.source.kind} base=${profile.source.base}`;
}

function formatPackageOverrideEntries(
	effectivePackageOverrides: EffectivePackageOverrides,
): readonly string[] {
	return effectivePackageOverrides.npm.map(
		(packageEntry) => `${packageEntry.name}@${packageEntry.version}[${packageEntry.source}]`,
	);
}

function formatPackageOverrideHint(props: {
	readonly effectivePackageOverrides: EffectivePackageOverrides;
	readonly overlayPath?: string | undefined;
}): string {
	const packageEntries = formatPackageOverrideEntries(props.effectivePackageOverrides);
	const packageSummary = packageEntries.length > 0 ? packageEntries.join(',') : 'none';
	return props.overlayPath
		? `${packageSummary}; overlay ${props.overlayPath}`
		: `${packageSummary}; no overlay`;
}

async function buildManagedPackageOverrideCheck(props: {
	readonly checkName: string;
	readonly managedPackageOverrides: PackageOverrides;
	readonly source: ManagedImageSource;
}): Promise<DoctorCheck> {
	let overlayPackageOverrides = emptyPackageOverrides();
	if (props.source.overlay) {
		try {
			const overlay = await loadManagedImageOverlay(props.source.overlay);
			overlayPackageOverrides = overlay.packageOverrides;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				name: props.checkName,
				ok: false,
				hint: `Cannot read package overrides from ${props.source.overlay}: ${message}`,
			};
		}
	}
	try {
		const effectivePackageOverrides = resolveEffectivePackageOverrides({
			base: props.source.base,
			managed: props.managedPackageOverrides,
			overlay: overlayPackageOverrides,
		});
		return {
			name: props.checkName,
			ok: true,
			hint: formatPackageOverrideHint({
				effectivePackageOverrides,
				overlayPath: props.source.overlay,
			}),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			name: props.checkName,
			ok: false,
			hint: message,
		};
	}
}

export async function collectManagedImagePackageOverrideDoctorChecks(props: {
	readonly managedImageRelease: ManagedImageRelease;
	readonly systemConfig: LoadedSystemConfig | SystemConfig;
}): Promise<readonly DoctorCheck[]> {
	const gatewayChecks = await Promise.all(
		Object.entries(props.systemConfig.imageProfiles.gateways).map(
			async ([profileName, profile]) => {
				if (profile.source?.kind !== 'managedBase') {
					return [];
				}
				const managedBaseImage = props.managedImageRelease.baseImages[profile.source.base];
				const check = await buildManagedPackageOverrideCheck({
					checkName: `gateway-package-overrides-${profileName}`,
					managedPackageOverrides: managedBaseImage.packageOverrides,
					source: profile.source,
				});
				return [check];
			},
		),
	);
	const toolVmChecks = await Promise.all(
		Object.entries(props.systemConfig.imageProfiles.toolVms).map(async ([profileName, profile]) => {
			if (profile.source?.kind !== 'managedBase') {
				return [];
			}
			const managedBaseImage = props.managedImageRelease.baseImages[profile.source.base];
			const check = await buildManagedPackageOverrideCheck({
				checkName: `tool-vm-package-overrides-${profileName}`,
				managedPackageOverrides: managedBaseImage.packageOverrides,
				source: profile.source,
			});
			return [check];
		}),
	);
	return [...gatewayChecks.flat(), ...toolVmChecks.flat()];
}

export async function collectVmHostSystemDoctorCheck(
	systemConfig: LoadedSystemConfig,
): Promise<DoctorCheck | null> {
	if (isRuntimeSystemConfigPath(systemConfig)) {
		const requiredRuntimeFiles = [
			'/usr/local/bin/start.sh',
			'/etc/systemd/system/agent-vm-controller.service',
		] as const;
		for (const requiredRuntimeFile of requiredRuntimeFiles) {
			try {
				// oxlint-disable-next-line no-await-in-loop -- report the first missing file in stable order
				await access(requiredRuntimeFile);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					name: 'vm-host-system',
					ok: false,
					hint: `Cannot access ${requiredRuntimeFile}: ${message}`,
				};
			}
		}
		return {
			name: 'vm-host-system',
			ok: true,
			hint: '/etc/agent-vm runtime host files',
		};
	}

	const vmHostSystemPath = path.resolve(
		path.dirname(systemConfig.systemConfigPath),
		'..',
		'vm-host-system',
	);
	const shouldRequireCheckoutHostFiles = hasRuntimeConfigReferences(systemConfig);
	try {
		await access(vmHostSystemPath);
	} catch (error) {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
			if (!shouldRequireCheckoutHostFiles) {
				return null;
			}
			const message = error instanceof Error ? error.message : 'unknown error';
			return {
				name: 'vm-host-system',
				ok: false,
				hint: `Cannot access ${vmHostSystemPath}: ${message}`,
			};
		}
		const message = error instanceof Error ? error.message : String(error);
		return {
			name: 'vm-host-system',
			ok: false,
			hint: `Cannot access ${vmHostSystemPath}: ${message}`,
		};
	}
	const requiredFiles = ['Dockerfile', 'start.sh', 'agent-vm-controller.service'] as const;
	for (const requiredFile of requiredFiles) {
		const requiredFilePath = path.join(vmHostSystemPath, requiredFile);
		try {
			// oxlint-disable-next-line no-await-in-loop -- report the first missing file in stable order
			await access(requiredFilePath);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				name: 'vm-host-system',
				ok: false,
				hint: `Cannot access ${requiredFilePath}: ${message}`,
			};
		}
	}

	return {
		name: 'vm-host-system',
		ok: true,
		hint: vmHostSystemPath,
	};
}

type GatewayStateAuthorityEvidence = Awaited<
	ReturnType<typeof scanGatewayStateAuthorityEvidenceDefault>
>[number];

function buildGatewayStateAuthorityChecks(
	evidenceByZone: readonly {
		readonly evidence: readonly GatewayStateAuthorityEvidence[];
		readonly zoneId: string;
	}[],
): readonly DoctorCheck[] {
	const failedChecks = evidenceByZone.flatMap(({ evidence, zoneId }) =>
		evidence.map(
			(gatewayStateEvidence, evidenceIndex) =>
				({
					name: `legacy-controller-record-evidence-${zoneId}-${String(evidenceIndex)}`,
					ok: false,
					hint: `family=${gatewayStateEvidence.family} kind=${gatewayStateEvidence.kind} path=${gatewayStateEvidence.absolutePath}; move controller-owned records to controllerStateDir and remove legacy Gateway-state evidence`,
				}) satisfies DoctorCheck,
		),
	);
	return failedChecks.length > 0
		? failedChecks
		: [
				{
					name: 'legacy-controller-record-evidence',
					ok: true,
					hint: 'No legacy controller records exist under Gateway state directories.',
				},
			];
}

export async function runControllerDoctor(
	options: RunControllerDoctorOptions,
): Promise<ControllerDoctorResult> {
	const scanGatewayStateAuthorityEvidence =
		options.scanGatewayStateAuthorityEvidence ?? scanGatewayStateAuthorityEvidenceDefault;
	const evidenceByZone: {
		readonly evidence: readonly GatewayStateAuthorityEvidence[];
		readonly zoneId: string;
	}[] = [];
	for (const zone of options.systemConfig.zones) {
		// oxlint-disable-next-line no-await-in-loop -- stable zone ordering makes operator checks deterministic.
		const evidence = await scanGatewayStateAuthorityEvidence({
			gatewayStateDirectoryPath: path.resolve(zone.gateway.stateDir),
		});
		if (evidence.length > 0) {
			evidenceByZone.push({ evidence, zoneId: zone.id });
		}
	}
	const gatewayStateAuthorityChecks = buildGatewayStateAuthorityChecks(evidenceByZone);
	const managedAgentRootStorageChecks = await collectManagedAgentRootStorageChecks(
		options.systemConfig,
	);
	const nodeMajorVersion = Number.parseInt(
		options.nodeVersion.replace(/^v/u, '').split('.')[0] ?? '0',
		10,
	);
	const occupiedPorts = options.occupiedPorts ?? new Set<number>();
	const diskFreeBytes = options.diskFreeBytes ?? Number.POSITIVE_INFINITY;
	const totalMemoryBytes = options.totalMemoryBytes ?? Number.POSITIVE_INFINITY;
	const availableBinaries = options.availableBinaries ?? new Set<string>();
	const dockerChecks = buildDockerChecks(
		options.systemConfig,
		availableBinaries,
		options.dockerDaemonReady,
	);
	const workerGatewayVmRequirementsBuilder =
		options.workerGatewayVmRequirementsBuilder ??
		((buildOptions: BuildGatewayVmRequirementsOptions): Pick<GatewayVmRequirements, 'mounts'> =>
			workerLifecycle.buildVmRequirements(buildOptions));
	const workerWorkRootfsChecks = buildWorkerWorkRootfsChecks(
		options.systemConfig,
		workerGatewayVmRequirementsBuilder,
	);
	const configuredGatewayBytes = options.systemConfig.zones.reduce((totalBytes, zone) => {
		const memoryMatch = /^(\d+)([GgMm])$/u.exec(zone.gateway.memory);
		if (!memoryMatch) {
			return totalBytes;
		}
		const numericValue = Number.parseInt(memoryMatch[1] ?? '0', 10);
		const multiplier =
			(memoryMatch[2] ?? '').toLowerCase() === 'g' ? 1024 * 1024 * 1024 : 1024 * 1024;
		return totalBytes + numericValue * multiplier;
	}, 0);
	const tokenSource = options.systemConfig.host.secretsProvider?.tokenSource;
	const zigVersionCheck = buildZigVersionCheck(options.zigVersion, options.requiredZigVersion);
	const tokenSourceReady = (() => {
		if (!tokenSource) {
			return true;
		}
		switch (tokenSource.type) {
			case 'env': {
				const envVar = tokenSource.envVar ?? 'OP_SERVICE_ACCOUNT_TOKEN';
				return typeof options.env[envVar] === 'string' && options.env[envVar].length > 0;
			}
			case 'keychain':
				return availableBinaries.has('security');
			default:
				return false;
		}
	})();

	const checks: DoctorCheck[] = [
		{
			name: 'node-version',
			ok: nodeMajorVersion >= 24,
			...(nodeMajorVersion < 24 ? { hint: 'Requires Node.js >= 24. Install via nvm or fnm.' } : {}),
		},
		...(zigVersionCheck ? [zigVersionCheck] : []),
		...(tokenSource
			? [
					{
						name: '1password-token-source',
						ok: tokenSourceReady,
						...(!tokenSourceReady && tokenSource.type === 'env'
							? {
									hint: `Set ${tokenSource.envVar ?? 'OP_SERVICE_ACCOUNT_TOKEN'} environment variable`,
								}
							: {}),
					} satisfies DoctorCheck,
				]
			: []),
		buildObservabilityEnabledCheck(options.systemConfig),
		checkAnyBinary(
			'qemu',
			['qemu-system-aarch64', 'qemu-system-x86_64'],
			'Install QEMU (for example: brew install qemu).',
			availableBinaries,
		),
		checkAnyBinary(
			'qemu-img',
			['qemu-img'],
			'Install qemu-img (for example: brew install qemu).',
			availableBinaries,
		),
		checkAnyBinary(
			'mke2fs',
			[
				'mke2fs',
				'mkfs.ext4',
				'/opt/homebrew/opt/e2fsprogs/sbin/mke2fs',
				'/usr/local/opt/e2fsprogs/sbin/mke2fs',
			],
			'Install e2fsprogs (for example: brew install e2fsprogs).',
			availableBinaries,
		),
		checkAnyBinary(
			'debugfs',
			[
				'debugfs',
				'/opt/homebrew/opt/e2fsprogs/sbin/debugfs',
				'/usr/local/opt/e2fsprogs/sbin/debugfs',
			],
			'Install e2fsprogs (for example: brew install e2fsprogs).',
			availableBinaries,
		),
		checkAnyBinary('cpio', ['cpio'], 'Install cpio.', availableBinaries),
		checkAnyBinary(
			'lz4',
			['lz4'],
			'Install lz4 (for example: brew install lz4).',
			availableBinaries,
		),
		...dockerChecks,
		...gatewayStateAuthorityChecks,
		...managedAgentRootStorageChecks,
		...buildRuntimePathIsolationChecks(options.systemConfig),
		...workerWorkRootfsChecks,
		{
			name: 'controller-port',
			ok:
				options.systemConfig.host.controllerPort > 0 &&
				!occupiedPorts.has(options.systemConfig.host.controllerPort),
			value: options.systemConfig.host.controllerPort,
		},
		...options.systemConfig.zones.map(
			(zone) =>
				({
					name: `gateway-port-${zone.id}`,
					ok: zone.gateway.port > 0 && !occupiedPorts.has(zone.gateway.port),
					value: zone.gateway.port,
				}) satisfies DoctorCheck,
		),
		...Object.entries(options.systemConfig.imageProfiles.gateways).map(
			([profileName, profile]) =>
				({
					name: `gateway-image-profile-${profileName}`,
					ok: true,
					hint: formatImageProfileHint(profile),
				}) satisfies DoctorCheck,
		),
		...Object.entries(options.systemConfig.imageProfiles.toolVms).map(
			([profileName]) =>
				({
					name: `tool-vm-image-profile-${profileName}`,
					ok: true,
				}) satisfies DoctorCheck,
		),
		...buildZoneToolVmProfileChecks(options.systemConfig),
		...buildManagedAgentSecretAccessChecks(options.systemConfig),
		...buildLegacyDockerfileImageProfileChecks(options.systemConfig),
		...options.systemConfig.zones.map(
			(zone) =>
				({
					name: `gateway-image-profile-selected-${zone.id}`,
					ok: true,
					hint: zone.gateway.imageProfile,
				}) satisfies DoctorCheck,
		),
		{
			name: 'disk-space',
			ok: diskFreeBytes >= 10 * 1024 * 1024 * 1024,
			...(diskFreeBytes < 10 * 1024 * 1024 * 1024
				? { hint: 'Need at least 10GB free disk space' }
				: {}),
		},
		{
			name: 'memory-budget',
			ok: totalMemoryBytes >= configuredGatewayBytes,
		},
	];

	return {
		ok: checks.every((check) => check.ok),
		checks,
	};
}
