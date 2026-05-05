import { access } from 'node:fs/promises';
import path from 'node:path';

import type {
	BuildGatewayVmSpecOptions,
	GatewayVmSpec,
	GatewayZoneConfig,
} from '@agent-vm/gateway-interface';
import { workerLifecycle } from '@agent-vm/worker-gateway';

import { loadSystemCacheIdentifier } from '../config/system-cache-identifier.js';
import type { LoadedSystemConfig, SystemConfig } from '../config/system-config.js';
import { isRuntimeSystemConfigPath } from './runtime-config-paths.js';

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
	readonly systemConfig: SystemConfig;
	readonly totalMemoryBytes?: number;
	readonly workerGatewayVmSpecBuilder?: (
		options: BuildGatewayVmSpecOptions,
	) => Pick<GatewayVmSpec, 'vfsMounts'>;
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

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseVersionParts(version: string): readonly number[] | null {
	const versionMatch = /^(\d+)\.(\d+)\.(\d+)/u.exec(version.trim());
	if (!versionMatch) {
		return null;
	}
	return [versionMatch[1], versionMatch[2], versionMatch[3]].map((part) =>
		Number.parseInt(part ?? '0', 10),
	);
}

export function isVersionAtLeast(version: string, minimumVersion: string): boolean {
	const versionParts = parseVersionParts(version);
	const minimumVersionParts = parseVersionParts(minimumVersion);
	if (!versionParts || !minimumVersionParts) {
		return false;
	}
	for (const [index, minimumVersionPart] of minimumVersionParts.entries()) {
		const versionPart = versionParts[index] ?? 0;
		if (versionPart > minimumVersionPart) {
			return true;
		}
		if (versionPart < minimumVersionPart) {
			return false;
		}
	}
	return true;
}

export function buildZigInstallHint(requiredZigVersion: string | undefined): string {
	return requiredZigVersion
		? `Install Zig >= ${requiredZigVersion}. On macOS: brew install zig.`
		: 'Install Zig required by Gondolin. On macOS: brew install zig.';
}

export function buildZigUpgradeHint(requiredZigVersion: string): string {
	return `Requires Zig >= ${requiredZigVersion}. On macOS: brew install zig.`;
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
	const ok = isVersionAtLeast(zigVersion, requiredZigVersion);
	return {
		name: 'zig-version',
		ok,
		value: zigVersion,
		...(!ok ? { hint: buildZigUpgradeHint(requiredZigVersion) } : {}),
	};
}

function hasDockerBackedImageProfiles(systemConfig: SystemConfig): boolean {
	const gatewayProfiles = Object.values(systemConfig.imageProfiles.gateways);
	const toolVmProfiles = Object.values(systemConfig.imageProfiles.toolVms);
	return [...gatewayProfiles, ...toolVmProfiles].some(
		(profile) => profile.dockerfile !== undefined || profile.source !== undefined,
	);
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

function hasOpenClawZones(systemConfig: SystemConfig): boolean {
	return systemConfig.zones.some((zone) => zone.gateway.type === 'openclaw');
}

function buildOpenClawCliCheck(
	systemConfig: SystemConfig,
	availableBinaries: ReadonlySet<string>,
): readonly DoctorCheck[] {
	if (!hasOpenClawZones(systemConfig)) {
		return [];
	}
	const openClawCliReady = availableBinaries.has('openclaw');
	return [
		{
			name: 'openclaw-cli',
			ok: openClawCliReady,
			...(openClawCliReady
				? { hint: 'openclaw' }
				: {
						hint: 'Install OpenClaw in this catalog for local schema validation: pnpm add -D openclaw@2026.5.2.',
					}),
		},
	];
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
	if (pathsOverlap(systemConfig.runtimeDir, systemConfig.cacheDir)) {
		failedChecks.push({
			name: 'runtime-path-isolation-cacheDir',
			ok: false,
			hint: 'runtimeDir must not overlap cacheDir',
		});
	}
	for (const zone of systemConfig.zones) {
		if (pathsOverlap(systemConfig.runtimeDir, zone.gateway.stateDir)) {
			failedChecks.push({
				name: `runtime-path-isolation-stateDir-${zone.id}`,
				ok: false,
				hint: `runtimeDir must not overlap stateDir for zone '${zone.id}'`,
			});
		}
		if (
			zone.gateway.type === 'openclaw' &&
			pathsOverlap(systemConfig.runtimeDir, zone.gateway.zoneFilesDir)
		) {
			failedChecks.push({
				name: `runtime-path-isolation-zoneFilesDir-${zone.id}`,
				ok: false,
				hint: `runtimeDir must not overlap zoneFilesDir for zone '${zone.id}'`,
			});
		}
	}
	return failedChecks.length > 0
		? failedChecks
		: [
				{
					name: 'runtime-path-isolation',
					ok: true,
					hint: systemConfig.runtimeDir,
				},
			];
}

export function buildRuntimePathIsolationCheck(systemConfig: SystemConfig): DoctorCheck {
	return (
		buildRuntimePathIsolationChecks(systemConfig)[0] ?? {
			name: 'runtime-path-isolation',
			ok: true,
			hint: systemConfig.runtimeDir,
		}
	);
}

function isWorkerRootfsWorkMountPath(guestPath: string): boolean {
	return guestPath === '/work' || guestPath.startsWith('/work/');
}

function buildWorkerWorkRootfsChecks(
	systemConfig: SystemConfig,
	buildWorkerVmSpec: (options: BuildGatewayVmSpecOptions) => Pick<GatewayVmSpec, 'vfsMounts'>,
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
					ssh: zone.gateway.ssh ?? { secretEnv: 'explicit' },
					stateDir: zone.gateway.stateDir,
					...(zone.gateway.authProfilesRef
						? { authProfilesRef: zone.gateway.authProfilesRef }
						: {}),
				},
				secrets: zone.secrets,
				allowedHosts: zone.allowedHosts,
				websocketBypass: zone.websocketBypass,
			};
			const vmSpec = buildWorkerVmSpec({
				controllerPort: systemConfig.host.controllerPort,
				gatewayCacheDir: systemConfig.cacheDir,
				projectNamespace: systemConfig.host.projectNamespace,
				resolvedSecrets: {},
				tcpPool: systemConfig.tcpPool,
				zone: gatewayZone,
			});
			const vfsWorkMount = Object.keys(vmSpec.vfsMounts).find(isWorkerRootfsWorkMountPath);
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
		if (zone.gateway.type !== 'openclaw') {
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

function buildOpenClawAgentSetupChecks(systemConfig: SystemConfig): readonly DoctorCheck[] {
	return systemConfig.zones.flatMap((zone) => {
		if (zone.gateway.type !== 'openclaw') {
			return [];
		}
		const authProfileChecks = Object.keys(zone.gateway.authProfilesByAgent ?? {}).map(
			(agentId) =>
				({
					name: `zone-agent-auth-profile-${zone.id}-${agentId}`,
					ok: true,
					hint: 'configured',
				}) satisfies DoctorCheck,
		);
		const sandboxSeedChecks = Object.entries(zone.agentSandboxSeeds ?? {}).flatMap(
			([agentId, seeds]) =>
				seeds.map(
					(seed, seedIndex) =>
						({
							name: `zone-agent-sandbox-seed-${zone.id}-${agentId}-${String(seedIndex)}`,
							ok: true,
							hint: seed.target,
						}) satisfies DoctorCheck,
				),
		);
		return [...authProfileChecks, ...sandboxSeedChecks];
	});
}

function buildLegacyDockerfileImageProfileChecks(
	systemConfig: SystemConfig,
): readonly DoctorCheck[] {
	const gatewayChecks = Object.entries(systemConfig.imageProfiles.gateways)
		.filter(([, profile]) => profile.dockerfile !== undefined)
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

export async function collectVmHostSystemDoctorCheck(
	systemConfig: LoadedSystemConfig,
): Promise<DoctorCheck | null> {
	let identifier: unknown;
	try {
		identifier = await loadSystemCacheIdentifier({
			filePath: systemConfig.systemCacheIdentifierPath,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			name: 'vm-host-system',
			ok: false,
			hint: `Cannot read ${systemConfig.systemCacheIdentifierPath}: ${message}`,
		};
	}
	if (!isObjectRecord(identifier) || identifier.hostSystemType !== 'container') {
		return null;
	}

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

export function runControllerDoctor(options: RunControllerDoctorOptions): ControllerDoctorResult {
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
	const openClawCliChecks = buildOpenClawCliCheck(options.systemConfig, availableBinaries);
	const workerGatewayVmSpecBuilder =
		options.workerGatewayVmSpecBuilder ??
		((buildOptions: BuildGatewayVmSpecOptions): Pick<GatewayVmSpec, 'vfsMounts'> =>
			workerLifecycle.buildVmSpec(buildOptions));
	const workerWorkRootfsChecks = buildWorkerWorkRootfsChecks(
		options.systemConfig,
		workerGatewayVmSpecBuilder,
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
			case 'op-cli':
				return availableBinaries.has('op');
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
						...(!tokenSourceReady && tokenSource.type === 'op-cli'
							? { hint: 'Install 1Password CLI: brew install 1password-cli' }
							: {}),
					} satisfies DoctorCheck,
				]
			: []),
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
		...openClawCliChecks,
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
		...buildOpenClawAgentSetupChecks(options.systemConfig),
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
