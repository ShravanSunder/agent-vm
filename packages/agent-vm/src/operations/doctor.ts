import type { SystemConfig } from '../config/system-config.js';

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

function checkBinary(
	name: string,
	binaryName: string,
	installHint: string,
	availableBinaries: ReadonlySet<string>,
): DoctorCheck {
	return {
		name,
		ok: availableBinaries.has(binaryName),
		...(!availableBinaries.has(binaryName) ? { hint: installHint } : {}),
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
	const tokenSource = options.systemConfig.host.secretsProvider.tokenSource;
	const tokenSourceReady = (() => {
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
		{
			name: '1password-token-source',
			ok: tokenSourceReady,
			...(!tokenSourceReady && tokenSource.type === 'env'
				? { hint: `Set ${tokenSource.envVar ?? 'OP_SERVICE_ACCOUNT_TOKEN'} environment variable` }
				: {}),
			...(!tokenSourceReady && tokenSource.type === 'op-cli'
				? { hint: 'Install 1Password CLI: brew install 1password-cli' }
				: {}),
		},
		checkBinary('qemu', 'qemu-system-aarch64', 'brew install qemu', availableBinaries),
		checkBinary('age', 'age', 'brew install age', availableBinaries),
		checkBinary('1password-cli', 'op', 'brew install 1password-cli', availableBinaries),
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
