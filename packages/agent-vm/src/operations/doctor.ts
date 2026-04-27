import fs from 'node:fs/promises';
import path from 'node:path';

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
		(profile) => profile.dockerfile !== undefined,
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
						hint: 'Install OpenClaw in this catalog for local schema validation: pnpm add -D openclaw@2026.4.24.',
					}),
		},
	];
}

export async function collectVmHostSystemDoctorCheck(
	systemConfig: LoadedSystemConfig,
): Promise<DoctorCheck | null> {
	let identifier: unknown;
	try {
		identifier = await loadSystemCacheIdentifier({
			filePath: systemConfig.systemCacheIdentifierPath,
		});
	} catch {
		return null;
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
				await fs.access(requiredRuntimeFile);
			} catch {
				return {
					name: 'vm-host-system',
					ok: false,
					hint: `Missing ${requiredRuntimeFile}`,
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
			await fs.access(requiredFilePath);
		} catch {
			return {
				name: 'vm-host-system',
				ok: false,
				hint: `Missing ${requiredFilePath}`,
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
					hint: `type=${profile.type}`,
				}) satisfies DoctorCheck,
		),
		...Object.entries(options.systemConfig.imageProfiles.toolVms).map(
			([profileName]) =>
				({
					name: `tool-vm-image-profile-${profileName}`,
					ok: true,
				}) satisfies DoctorCheck,
		),
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
