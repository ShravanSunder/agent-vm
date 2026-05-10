import type { SystemConfig } from '../config/system-config.js';
import { resolveControllerGithubToken } from '../controller/controller-runtime-support.js';
import type { ZoneGitOperationConfig } from '../controller/zone-git/zone-git-operations.js';
import { isOpenClawZoneGitConfigured } from '../controller/zone-git/zone-git-paths.js';
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
		let zoneGit: ZoneGitOperationConfig | undefined;
		if (isOpenClawZoneGitConfigured(zone)) {
			const githubToken = await resolveControllerGithubToken(options.systemConfig, secretResolver);
			if (!githubToken) {
				throw new Error(
					`zoneGit for zone '${zoneId}' requires host.githubToken so the controller can push without exposing credentials to VMs.`,
				);
			}
			zoneGit = {
				branch: zone.gateway.zoneGit.remote.branch,
				githubToken,
				remoteUrl: zone.gateway.zoneGit.remote.repoUrl,
				runtimeDir: options.systemConfig.runtimeDir,
				zoneFilesDir: zone.gateway.zoneFilesDir,
				zoneId,
			};
		}
		writeJson(
			options.io,
			await backupManager.createBackup({
				backupDir,
				cacheDir: options.systemConfig.cacheDir,
				runtimeDir: options.systemConfig.runtimeDir,
				stateDir: zone.gateway.stateDir,
				...(zone.gateway.type === 'openclaw' ? { zoneFilesDir: zone.gateway.zoneFilesDir } : {}),
				...(zoneGit ? { zoneGit } : {}),
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
