// oxlint-disable eslint/no-await-in-loop -- path sizing walks the filesystem sequentially
import fs from 'node:fs/promises';

import {
	deploymentCacheDirForSystemConfig,
	deploymentGeneratedDirForStorageRoot,
	sharedImageCacheDirForStorageRoot,
} from '../../config/system-config.js';
import { runConfigValidation } from '../../operations/config-validation.js';
import {
	createResolverFromSystemConfig,
	type CliDependencies,
	type CliIo,
	requireZone,
	writeJson,
} from '../agent-vm-cli-support.js';
import type { AgentVmCommand } from '../agent-vm-command-parser.js';
import { runBackupCommand } from '../backup-commands.js';
import { runBuildCommand } from '../build-command.js';
import { runCacheCommand } from '../cache-commands.js';
import { resetWorkerInstructions } from '../config-commands.js';
import { runControllerOperationCommand } from '../controller-operation-commands.js';
import { updateAgentVmManual } from '../manual-commands.js';
import { runMigrateImagesCommand } from '../migrate-commands.js';
import {
	initRepoResources,
	updateRepoResources,
	validateRepoResources,
} from '../resources-commands.js';
import { createRunTask, createRunTaskGroup } from '../run-task.js';
import { loadSystemConfigFromCliOption } from './command-operation-support.js';

type BuildCommand = Extract<AgentVmCommand, { readonly command: 'build' }>;
type ValidateCommand = Extract<AgentVmCommand, { readonly command: 'validate' }>;
type DoctorCommand = Extract<AgentVmCommand, { readonly command: 'doctor' }>;
type CacheCommand = Extract<AgentVmCommand, { readonly command: 'cache.list' | 'cache.clean' }>;
type ConfigCommand = Extract<AgentVmCommand, { readonly command: 'config.reset-instructions' }>;
type ManualCommand = Extract<AgentVmCommand, { readonly command: 'manual.update' }>;
type MigrateCommand = Extract<AgentVmCommand, { readonly command: 'migrate.images' }>;
type PathsCommand = Extract<AgentVmCommand, { readonly command: 'paths.show' }>;
type ResourcesCommand = Extract<
	AgentVmCommand,
	{ readonly command: 'resources.init' | 'resources.validate' | 'resources.update' }
>;
type BackupCommand = Extract<
	AgentVmCommand,
	{ readonly command: 'backup.create' | 'backup.list' | 'backup.restore' }
>;

export async function runBuildCommandOperation(
	io: CliIo,
	dependencies: CliDependencies,
	command: BuildCommand,
): Promise<void> {
	const systemConfig = await loadSystemConfigFromCliOption(command.options.config, dependencies);
	const runTask = await createRunTask(io);
	const runTaskGroup = await createRunTaskGroup(io, runTask);
	await (dependencies.runBuildCommand ?? runBuildCommand)(
		{
			forceRebuild: command.options.force,
			skipObservability: command.options.noObservability,
			systemConfig,
		},
		{ runTask, runTaskGroup },
	);
}

export async function runValidateCommandOperation(
	io: CliIo,
	dependencies: CliDependencies,
	command: ValidateCommand,
): Promise<void> {
	const systemConfig = await loadSystemConfigFromCliOption(command.options.config, dependencies);
	const secretResolver = command.options.mcpLive
		? await createResolverFromSystemConfig(systemConfig, dependencies)
		: undefined;
	writeJson(
		io,
		await (dependencies.runConfigValidation ?? runConfigValidation)({
			...(dependencies.runCommand ? { runCommand: dependencies.runCommand } : {}),
			...(command.options.mcpLive ? { mcpLive: true } : {}),
			...(secretResolver === undefined ? {} : { secretResolver }),
			systemConfig,
		}),
	);
}

export async function runDoctorCommandOperation(
	io: CliIo,
	dependencies: CliDependencies,
	command: DoctorCommand,
): Promise<void> {
	await runControllerOperationCommand({
		dependencies,
		io,
		json: command.options.json,
		showPassed: command.options.showPassed,
		subcommand: 'doctor',
		systemConfig: await loadSystemConfigFromCliOption(command.options.config, dependencies),
		...(dependencies.collectControllerDoctorEnvironment
			? { collectDoctorEnvironment: dependencies.collectControllerDoctorEnvironment }
			: {}),
		...(dependencies.collectDynamicDoctorChecks
			? { collectDynamicDoctorChecks: dependencies.collectDynamicDoctorChecks }
			: {}),
	});
}

export async function runCacheCommandOperation(
	io: CliIo,
	dependencies: CliDependencies,
	command: CacheCommand,
): Promise<void> {
	const systemConfig = await loadSystemConfigFromCliOption(command.options.config, dependencies);
	if (command.command === 'cache.list') {
		await (dependencies.runCacheCommand ?? runCacheCommand)(
			{ subcommand: 'list', systemConfig },
			io,
		);
		return;
	}
	await (dependencies.runCacheCommand ?? runCacheCommand)(
		{ confirm: command.options.confirm, subcommand: 'clean', systemConfig },
		io,
	);
}

export async function runConfigCommandOperation(
	io: CliIo,
	dependencies: CliDependencies,
	command: ConfigCommand,
): Promise<void> {
	const systemConfig = await loadSystemConfigFromCliOption(command.options.config, dependencies);
	const selectedZone =
		command.options.zone === undefined
			? systemConfig.zones.length === 1
				? systemConfig.zones[0]
				: undefined
			: systemConfig.zones.find((zone) => zone.id === command.options.zone);
	if (!selectedZone) {
		if (command.options.zone === undefined && systemConfig.zones.length === 0) {
			throw new Error('No zones configured in the system config.');
		}
		throw new Error(
			command.options.zone === undefined
				? 'Multiple zones configured; pass --zone <zone-id>.'
				: `Unknown zone '${command.options.zone}'.`,
		);
	}
	if (selectedZone.gateway.type !== 'worker') {
		throw new Error(
			`Zone '${selectedZone.id}' uses gateway type '${selectedZone.gateway.type}'; reset-instructions only supports worker gateways.`,
		);
	}
	const result = await (dependencies.resetWorkerInstructions ?? resetWorkerInstructions)({
		workerConfigPath: selectedZone.gateway.config,
		phase: command.options.phase,
	});
	io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function writePathGroup(io: CliIo, label: string, paths: readonly string[]): void {
	for (const filePath of paths) io.stdout.write(`  ${label} ${filePath}\n`);
}

export async function runManualCommandOperation(
	io: CliIo,
	dependencies: CliDependencies,
	command: ManualCommand,
): Promise<void> {
	const targetDir =
		command.options.targetDir ?? dependencies.getCurrentWorkingDirectory?.() ?? process.cwd();
	const result = await (dependencies.updateAgentVmManual ?? updateAgentVmManual)({
		defaultZoneId: command.options.defaultZone,
		systemConfigPath: command.options.config,
		targetDir,
		updateAgentIndex: command.options.agents,
	});
	if (command.options.json) {
		writeJson(io, result);
		return;
	}
	io.stdout.write('Updated generated agent-vm manual files\n');
	writePathGroup(io, 'updated', result.updated);
}

export async function runMigrateCommandOperation(
	io: CliIo,
	_dependencies: CliDependencies,
	command: MigrateCommand,
): Promise<void> {
	const result = await runMigrateImagesCommand({ systemConfigPath: command.options.config });
	io.stdout.write(
		`migrated image profiles: ${result.migratedProfiles.length === 0 ? 'none' : result.migratedProfiles.join(', ')}\n`,
	);
	if (result.skippedProfiles.length > 0)
		io.stdout.write(`skipped image profiles: ${result.skippedProfiles.join(', ')}\n`);
}

interface ResolvedPathEntry {
	readonly label: string;
	readonly path: string;
	readonly exists: boolean;
	readonly sizeBytes: number | null;
}
async function statPath(absolutePath: string): Promise<boolean> {
	try {
		await fs.stat(absolutePath);
		return true;
	} catch {
		return false;
	}
}
async function walkSize(absolutePath: string): Promise<number | null> {
	let total = 0;
	const stack = [absolutePath];
	while (stack.length > 0) {
		const current = stack.pop();
		if (current === undefined) break;
		const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => undefined);
		if (entries === undefined) return null;
		for (const entry of entries) {
			const child = `${current}/${entry.name}`;
			if (entry.isDirectory()) stack.push(child);
			else total += (await fs.stat(child).catch(() => undefined))?.size ?? 0;
		}
	}
	return total;
}
function formatBytes(bytes: number | null): string {
	if (bytes === null) return '—';
	if (bytes < 1024) return `${bytes} B`;
	const units = ['KB', 'MB', 'GB', 'TB'];
	let value = bytes / 1024;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex += 1;
	}
	return `${value.toFixed(1)} ${units[unitIndex]}`;
}
async function buildPathEntry(
	label: string,
	absolutePath: string,
	sizes: boolean,
): Promise<ResolvedPathEntry> {
	const exists = await statPath(absolutePath);
	return {
		label,
		path: absolutePath,
		exists,
		sizeBytes: sizes && exists ? await walkSize(absolutePath) : null,
	};
}
export async function runPathsCommandOperation(
	io: CliIo,
	dependencies: CliDependencies,
	command: PathsCommand,
): Promise<void> {
	const config = await loadSystemConfigFromCliOption(command.options.config, dependencies);
	const zoneEntries = config.zones.flatMap((zone) => {
		const entries = [
			buildPathEntry(`zone[${zone.id}].stateDir`, zone.gateway.stateDir, command.options.sizes),
			buildPathEntry(
				`zone[${zone.id}].backupDir`,
				zone.gateway.backupDir ?? `${zone.gateway.stateDir}/backups`,
				command.options.sizes,
			),
			buildPathEntry(
				`zone[${zone.id}].zoneRuntimeDir`,
				zone.gateway.zoneRuntimeDir,
				command.options.sizes,
			),
		];
		return zone.gateway.type === 'worker'
			? entries
			: [
					...entries,
					buildPathEntry(
						`zone[${zone.id}].zoneFilesDir`,
						zone.gateway.zoneFilesDir,
						command.options.sizes,
					),
				];
	});
	const entries = await Promise.all([
		buildPathEntry('storageRootDir', config.storageRootDir, command.options.sizes),
		buildPathEntry('cacheDir', config.cacheDir, command.options.sizes),
		buildPathEntry(
			'deploymentCacheDir',
			deploymentCacheDirForSystemConfig(config),
			command.options.sizes,
		),
		buildPathEntry(
			'generatedDir',
			deploymentGeneratedDirForStorageRoot(config.storageRootDir),
			command.options.sizes,
		),
		buildPathEntry(
			'sharedImageCacheDir',
			sharedImageCacheDirForStorageRoot(config.storageRootDir),
			command.options.sizes,
		),
		buildPathEntry('controllerStateDir', config.controllerStateDir, command.options.sizes),
		buildPathEntry('controllerRuntimeDir', config.controllerRuntimeDir, command.options.sizes),
		...zoneEntries,
	]);
	const labelWidth = entries.reduce((width, entry) => Math.max(width, entry.label.length), 0);
	io.stdout.write(
		`${entries.map((entry) => `${entry.exists ? '✓' : '✗'} ${entry.label.padEnd(labelWidth)}  ${entry.path}${command.options.sizes ? `  ${formatBytes(entry.sizeBytes)}` : ''}`).join('\n')}\n`,
	);
}

export async function runResourcesCommandOperation(
	io: CliIo,
	dependencies: CliDependencies,
	command: ResourcesCommand,
): Promise<void> {
	const targetDir = dependencies.getCurrentWorkingDirectory?.() ?? process.cwd();
	if (command.command === 'resources.init') {
		const result = await (dependencies.initRepoResources ?? initRepoResources)({ targetDir });
		if (command.options.json) writeJson(io, result);
		else {
			io.stdout.write(`Scaffolded .agent-vm resources in ${targetDir}\n`);
			writePathGroup(io, 'created', result.created);
			writePathGroup(io, 'updated', result.updated);
			writePathGroup(io, 'skipped', result.skipped);
			io.stdout.write(
				'Next: edit .agent-vm/repo-resources.ts and .agent-vm/docker-compose.yml, then run agent-vm resources validate.\n',
			);
		}
		return;
	}
	if (command.command === 'resources.validate') {
		const result = await (dependencies.validateRepoResources ?? validateRepoResources)({
			targetDir,
		});
		if (command.options.json) writeJson(io, result);
		else io.stdout.write('Repo resource contract is valid.\n');
		return;
	}
	const result = await (dependencies.updateRepoResources ?? updateRepoResources)({ targetDir });
	if (command.options.json) writeJson(io, result);
	else {
		io.stdout.write('Updated generated .agent-vm resource support files\n');
		writePathGroup(io, 'updated', result.updated);
	}
}

export async function runBackupCommandOperation(
	io: CliIo,
	dependencies: CliDependencies,
	command: BackupCommand,
): Promise<void> {
	const systemConfig = await loadSystemConfigFromCliOption(command.options.config, dependencies);
	const zoneId = requireZone(systemConfig, command.options.zone).id;
	await runBackupCommand({
		dependencies,
		io,
		systemConfig,
		zoneId,
		...(command.command === 'backup.restore'
			? { subcommand: 'restore', backupPath: command.options.backupPath }
			: { subcommand: command.command === 'backup.create' ? 'create' : 'list' }),
	});
}
