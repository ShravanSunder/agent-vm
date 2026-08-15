import type { SecretRef } from '@agent-vm/secret-management';

import type { LoadedSystemConfig } from '../config/system-config.js';
import {
	createResolverFromSystemConfig,
	type CliDependencies,
	type CliIo,
	requireZone,
	writeJson,
} from './agent-vm-cli-support.js';

type RunBackupCommandOptions = {
	readonly dependencies: CliDependencies;
	readonly io: CliIo;
	readonly systemConfig: LoadedSystemConfig;
	readonly zoneId: string;
} & (
	| { readonly subcommand: 'create' | 'list' }
	| { readonly backupPath: string; readonly subcommand: 'restore' }
);

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
	const backupSubcommand = options.subcommand;
	const zone = requireZone(options.systemConfig, options.zoneId);
	const zoneId = zone.id;
	const backupDir = zone.gateway.backupDir ?? `${zone.gateway.stateDir}/backups`;

	if (options.subcommand === 'list') {
		const backupManager = options.dependencies.createZoneBackupManager({
			decrypt: async () => {},
			encrypt: async () => {},
		});
		writeJson(options.io, backupManager.listBackups({ backupDir, zoneId }));
		return;
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

	if (options.subcommand === 'create') {
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
	if (options.subcommand !== 'restore') {
		throw new Error('Unsupported backup command.');
	}
	writeJson(
		options.io,
		await backupManager.restoreBackup({
			backupPath: options.backupPath,
			stateDir: zone.gateway.stateDir,
			...(zone.gateway.type !== 'worker' ? { zoneFilesDir: zone.gateway.zoneFilesDir } : {}),
		}),
	);
}
