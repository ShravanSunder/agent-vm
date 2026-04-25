import fs from 'node:fs/promises';
import path from 'node:path';

import { loadSystemCacheIdentifier } from '../config/system-cache-identifier.js';
import type { LoadedSystemConfig, SystemConfig } from '../config/system-config.js';

export interface DoctorCheck {
	readonly name: string;
	readonly ok: boolean;
	readonly hint?: string;
	readonly value?: number;
}

export interface RunControllerDoctorOptions {
	readonly availableBinaries?: ReadonlySet<string>;
	readonly diskFreeBytes?: number;
	readonly env: NodeJS.ProcessEnv;
	readonly occupiedPorts?: ReadonlySet<number>;
	readonly nodeVersion: string;
	readonly systemConfig: SystemConfig;
	readonly totalMemoryBytes?: number;
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
