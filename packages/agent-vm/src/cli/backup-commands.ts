import type { SystemConfig } from '../config/system-config.js';
import {
	createResolverFromSystemConfig,
	type CliDependencies,
	type CliIo,
	findZone,
	resolveZoneId,
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
	const zoneId = resolveZoneId(options.systemConfig, options.restArguments);
	const zone = findZone(options.systemConfig, zoneId);
	const backupDir = `${zone.gateway.stateDir}/backups`;

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
				ref: `op://agent-vm/agent-${zoneId}-backup/password`,
			}),
	});
	const backupManager = options.dependencies.createZoneBackupManager(backupEncryption);

	if (backupSubcommand === 'create') {
		writeJson(
			options.io,
			await backupManager.createBackup({
				backupDir,
				stateDir: zone.gateway.stateDir,
				workspaceDir: zone.gateway.workspaceDir,
				zoneId,
			}),
		);
		return;
	}

	if (backupSubcommand === 'restore') {
		const backupPath = options.restArguments[1];
		if (!backupPath) {
			throw new Error('Usage: agent-vm backup restore <path> [--zone <id>]');
		}
		writeJson(
			options.io,
			await backupManager.restoreBackup({
				backupPath,
				stateDir: zone.gateway.stateDir,
				workspaceDir: zone.gateway.workspaceDir,
			}),
		);
		return;
	}

	throw new Error(`Unknown backup subcommand '${backupSubcommand ?? 'undefined'}'.`);
}
