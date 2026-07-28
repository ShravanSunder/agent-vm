import type { SecretRef } from '@agent-vm/secret-management';

import type { LoadedSystemConfig } from '../config/system-config.js';
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
	readonly systemConfig: LoadedSystemConfig;
}

type BackupIdentityReference = NonNullable<
	LoadedSystemConfig['zones'][number]['gateway']['backupIdentity']
>;

function toSecretRef(reference: BackupIdentityReference): SecretRef {
	switch (reference.source) {
		case '1password':
			return { source: reference.source, ref: reference.ref };
		case 'environment':
			return { source: reference.source, ref: reference.envVar };
		case 'config':
			return { source: reference.source, value: reference.value };
		default: {
			const exhaustiveReference: never = reference;
			throw new Error(`Unsupported backup identity source: ${String(exhaustiveReference)}`);
		}
	}
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
	if (backupSubcommand !== 'create' && backupSubcommand !== 'restore') {
		throw new Error(`Unknown backup subcommand '${backupSubcommand ?? 'undefined'}'.`);
	}
	const restoreBackupPath = backupSubcommand === 'restore' ? options.restArguments[1] : undefined;
	if (
		backupSubcommand === 'restore' &&
		(!restoreBackupPath || restoreBackupPath.startsWith('--'))
	) {
		throw new Error('Usage: agent-vm backup restore <path> [--zone <id>]');
	}

	const backupIdentity = zone.gateway.backupIdentity;
	if (backupIdentity === undefined) {
		throw new Error(
			`Zone '${zoneId}' must configure gateway.backupIdentity for backup ${backupSubcommand}.`,
		);
	}

	const secretResolver = await createResolverFromSystemConfig(
		options.systemConfig,
		options.dependencies,
	);
	const backupEncryption = options.dependencies.createAgeBackupEncryption({
		resolveIdentity: async () => await secretResolver.resolve(toSecretRef(backupIdentity)),
	});
	const backupManager = options.dependencies.createZoneBackupManager(backupEncryption);

	if (backupSubcommand === 'create') {
		writeJson(
			options.io,
			await backupManager.createBackup({
				backupDir,
				cacheDir: options.systemConfig.cacheDir,
				zoneRuntimeDir: zone.gateway.zoneRuntimeDir,
				stateDir: zone.gateway.stateDir,
				...(zone.gateway.type !== 'worker' ? { zoneFilesDir: zone.gateway.zoneFilesDir } : {}),
				zoneId,
			}),
		);
		return;
	}

	if (restoreBackupPath === undefined) {
		throw new Error('Backup restore path was not initialized.');
	}
	writeJson(
		options.io,
		await backupManager.restoreBackup({
			backupPath: restoreBackupPath,
			stateDir: zone.gateway.stateDir,
			...(zone.gateway.type !== 'worker' ? { zoneFilesDir: zone.gateway.zoneFilesDir } : {}),
		}),
	);
}
