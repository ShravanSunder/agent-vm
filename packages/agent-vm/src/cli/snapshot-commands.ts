import type { SystemConfig } from '../controller/system-config.js';
import {
	createResolverFromSystemConfig,
	type CliDependencies,
	type CliIo,
	findZone,
	resolveZoneId,
	writeJson,
} from './agent-vm-cli-support.js';

interface RunSnapshotCommandOptions {
	readonly dependencies: CliDependencies;
	readonly io: CliIo;
	readonly restArguments: readonly string[];
	readonly systemConfig: SystemConfig;
}

export async function runSnapshotCommand(options: RunSnapshotCommandOptions): Promise<void> {
	const snapshotSubcommand = options.restArguments[0];
	const zoneId = resolveZoneId(options.systemConfig, options.restArguments);
	const zone = findZone(options.systemConfig, zoneId);
	const snapshotDir = `${zone.gateway.stateDir}/snapshots`;

	if (snapshotSubcommand === 'list') {
		const snapshotManager = options.dependencies.createSnapshotManager({
			decrypt: async () => {},
			encrypt: async () => {},
		});
		writeJson(options.io, snapshotManager.listSnapshots({ snapshotDir, zoneId }));
		return;
	}

	const secretResolver = await createResolverFromSystemConfig(
		options.systemConfig,
		options.dependencies,
	);
	const snapshotEncryption = options.dependencies.createAgeEncryption({
		resolveIdentity: async () =>
			await secretResolver.resolve({
				source: '1password',
				ref: `op://agent-vm/agent-${zoneId}-snapshot/password`,
			}),
	});
	const snapshotManager = options.dependencies.createSnapshotManager(snapshotEncryption);

	if (snapshotSubcommand === 'create') {
		writeJson(
			options.io,
			await snapshotManager.createSnapshot({
				snapshotDir,
				stateDir: zone.gateway.stateDir,
				workspaceDir: zone.gateway.workspaceDir,
				zoneId,
			}),
		);
		return;
	}

	if (snapshotSubcommand === 'restore') {
		const snapshotPath = options.restArguments[1];
		if (!snapshotPath) {
			throw new Error('Usage: agent-vm controller snapshot restore <path> [--zone <id>]');
		}
		writeJson(
			options.io,
			await snapshotManager.restoreSnapshot({
				snapshotPath,
				stateDir: zone.gateway.stateDir,
				workspaceDir: zone.gateway.workspaceDir,
			}),
		);
		return;
	}

	throw new Error(`Unknown snapshot subcommand '${snapshotSubcommand ?? 'undefined'}'.`);
}
