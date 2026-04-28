import type { SystemConfig } from '../config/system-config.js';
import {
	createResolverFromSystemConfig,
	type CliDependencies,
	type CliIo,
	readZoneFlag,
	requireZone,
	writeJson,
} from './agent-vm-cli-support.js';

interface RunBackupCommandOptions {
	readonly dependencies: CliDependencies;
	readonly io: CliIo;
	readonly restArguments: readonly string[];
	readonly systemConfig: SystemConfig;
}

export async function runBackupCommand(options: RunBackupCommandOptions): Promise<void> {
	const backupSubcommand = options.restArguments[0];
	const zone = requireZone(options.systemConfig, readZoneFlag(options.restArguments));
	const zoneId = zone.id;
	const backupDir = zone.gateway.backupDir ?? `${zone.gateway.stateDir}/backups`;

	if (backupSubcommand === 'list') {
		const backupManager = options.dependencies.createZoneBackupManager({
			decrypt: async () => {},
			encrypt: async () => {},
		});
		writeJson(options.io, backupManager.listBackups({ backupDir, zoneId }));
		return;
	}

	const secretResolver = await createResolverFromSystemConfig(
		options.systemConfig,
		options.dependencies,
	);
	const backupEncryption = options.dependencies.createAgeBackupEncryption({
		resolveIdentity: async () =>
			await secretResolver.resolve({
				source: '1password',
				ref: `op://agent-vm/${zoneId}-gateway-backup/password`,
			}),
	});
	const backupManager = options.dependencies.createZoneBackupManager(backupEncryption);

	if (backupSubcommand === 'create') {
		writeJson(
			options.io,
			await backupManager.createBackup({
				backupDir,
				stateDir: zone.gateway.stateDir,
				...(zone.gateway.type === 'openclaw' ? { zoneFilesDir: zone.gateway.zoneFilesDir } : {}),
				zoneId,
			}),
		);
		return;
	}

	if (backupSubcommand === 'restore') {
		const backupPath = options.restArguments[1];
		if (!backupPath || backupPath.startsWith('--')) {
			throw new Error('Usage: agent-vm backup restore <path> [--zone <id>]');
		}
		writeJson(
			options.io,
			await backupManager.restoreBackup({
				backupPath,
				stateDir: zone.gateway.stateDir,
				...(zone.gateway.type === 'openclaw' ? { zoneFilesDir: zone.gateway.zoneFilesDir } : {}),
			}),
		);
		return;
	}

	throw new Error(`Unknown backup subcommand '${backupSubcommand ?? 'undefined'}'.`);
}
