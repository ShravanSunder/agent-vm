import type { SystemConfig } from '../config/system-config.js';
import { resolveControllerGithubToken } from '../controller/controller-runtime-support.js';
import type { ZoneGitReadConfig } from '../controller/zone-git/zone-git-operations.js';
import { isOpenClawZoneGitConfigured } from '../controller/zone-git/zone-git-paths.js';
import {
	loadGatewayRuntimeRecordResult,
	type GatewayRuntimeRecordLoadResult,
} from '../gateway/gateway-runtime-record.js';
import {
	isManagedVmProcess,
	processIdentityMatches,
	readProcessIdentity,
	type ProcessIdentity,
} from '../shared/managed-vm-process.js';
import {
	createResolverFromSystemConfig,
	type CliDependencies,
	type CliIo,
	readZoneFlag,
	requireZone,
	writeJson,
} from './agent-vm-cli-support.js';
import { resolveZoneBackupDir } from './zone-backup-paths.js';

interface RunBackupCommandOptions {
	readonly dependencies: CliDependencies;
	readonly io: CliIo;
	readonly restArguments: readonly string[];
	readonly systemConfig: SystemConfig;
}

interface AssertRestoreTargetNotLiveOptions {
	readonly force: boolean;
	readonly loadGatewayRuntimeRecordResult?: (
		stateDirectory: string,
	) => Promise<GatewayRuntimeRecordLoadResult>;
	readonly readProcessIdentity?: (pid: number) => Promise<ProcessIdentity | null>;
	readonly stateDir: string;
	readonly zoneId: string;
}

export async function assertRestoreTargetNotLive(
	options: AssertRestoreTargetNotLiveOptions,
): Promise<void> {
	const runtimeRecordResult = await (
		options.loadGatewayRuntimeRecordResult ?? loadGatewayRuntimeRecordResult
	)(options.stateDir);
	if (runtimeRecordResult.kind === 'missing') {
		if (options.force) {
			return;
		}
		throw new Error(
			`Cannot prove zone '${options.zoneId}' is stopped before restore because gateway runtime record '${runtimeRecordResult.path}' is missing. Stop the gateway and rerun with --force if you have independently verified it is not running.`,
		);
	}
	if (runtimeRecordResult.kind === 'parse-error') {
		if (options.force) {
			return;
		}
		throw new Error(
			`Cannot prove zone '${options.zoneId}' is stopped before restore because gateway runtime record '${runtimeRecordResult.path}' is malformed. Stop the gateway and rerun with --force if you have independently verified it is not running.`,
		);
	}

	const runtimeRecord = runtimeRecordResult.record;
	const currentIdentity = await (options.readProcessIdentity ?? readProcessIdentity)(
		runtimeRecord.qemuPid,
	);
	if (currentIdentity === null) {
		return;
	}
	if (
		processIdentityMatches(runtimeRecord.processIdentity, currentIdentity) &&
		isManagedVmProcess(currentIdentity.command)
	) {
		throw new Error(
			`Refusing to restore zone '${options.zoneId}' while gateway pid ${String(runtimeRecord.qemuPid)} is still running. Stop the gateway before restore so live state cannot be mixed with restored state.`,
		);
	}
	if (processIdentityMatches(runtimeRecord.processIdentity, currentIdentity)) {
		if (options.force) {
			return;
		}
		throw new Error(
			`Cannot prove zone '${options.zoneId}' is safe to restore: gateway runtime record '${runtimeRecordResult.path}' still matches pid ${String(runtimeRecord.qemuPid)}, but the command is not a managed VM process. Rerun with --force only after independently verifying the zone is stopped.`,
		);
	}
}

export async function runBackupCommand(options: RunBackupCommandOptions): Promise<void> {
	const backupSubcommand = options.restArguments[0];
	const zone = requireZone(options.systemConfig, readZoneFlag(options.restArguments));
	const zoneId = zone.id;
	const backupDir = resolveZoneBackupDir({
		configuredBackupDir: zone.gateway.backupDir,
		projectNamespace: options.systemConfig.host.projectNamespace,
		zoneId,
	});

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
		let zoneGit: ZoneGitReadConfig | undefined;
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
			throw new Error('Usage: agent-vm backup restore <path> [--zone <id>] [--force]');
		}
		await assertRestoreTargetNotLive({
			force: options.restArguments.includes('--force'),
			stateDir: zone.gateway.stateDir,
			zoneId,
		});
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
