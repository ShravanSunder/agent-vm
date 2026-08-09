// oxlint-disable eslint/no-await-in-loop -- path sizing walks the filesystem sequentially to avoid EMFILE on large trees
import fs from 'node:fs/promises';

import { object } from '@optique/core/constructs';
import { map } from '@optique/core/modifiers';
import type { Parser } from '@optique/core/parser';
import { command } from '@optique/core/primitives';

import type { CliDependencies, CliIo } from '../agent-vm-cli-support.js';
import { cliDescription } from './command-definition-support.js';
import {
	createConfigOption,
	createPresenceFlag,
	loadSystemConfigFromOption,
} from './command-definition-support.js';

interface ResolvedPathEntry {
	readonly label: string;
	readonly path: string;
	readonly exists: boolean;
	readonly sizeBytes: number | null;
}

async function statPath(absolutePath: string): Promise<{ exists: boolean }> {
	try {
		await fs.stat(absolutePath);
		return { exists: true };
	} catch {
		return { exists: false };
	}
}

async function walkSize(absolutePath: string): Promise<number | null> {
	let total = 0;
	const stack: string[] = [absolutePath];
	while (stack.length > 0) {
		const current = stack.pop();
		if (current === undefined) {
			break;
		}
		const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => undefined);
		if (entries === undefined) {
			return null;
		}
		for (const entry of entries) {
			const child = `${current}/${entry.name}`;
			if (entry.isDirectory()) {
				stack.push(child);
				continue;
			}
			const fileStats = await fs.stat(child).catch(() => undefined);
			total += fileStats?.size ?? 0;
		}
	}
	return total;
}

function formatBytes(bytes: number | null): string {
	if (bytes === null) {
		return '—';
	}
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	const units = ['KB', 'MB', 'GB', 'TB'];
	let value = bytes / 1024;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex += 1;
	}
	return `${value.toFixed(1)} ${units[unitIndex]}`;
}

async function buildResolvedPathEntry(
	label: string,
	absolutePath: string,
	sizes: boolean,
): Promise<ResolvedPathEntry> {
	const stat = await statPath(absolutePath);
	return {
		label,
		path: absolutePath,
		exists: stat.exists,
		sizeBytes: sizes && stat.exists ? await walkSize(absolutePath) : null,
	};
}

export interface PathsCommandOptions {
	readonly config: string;
	readonly sizes: boolean;
}

export interface PathsCommand {
	readonly command: 'paths.show';
	readonly options: PathsCommandOptions;
}

export function createPathsSubcommands(): Parser<'sync', PathsCommand> {
	return command(
		'paths',
		command(
			'show',
			map(
				object({
					config: createConfigOption(),
					sizes: createPresenceFlag('--sizes', 'Walk each path and print disk usage (slower)'),
				}),
				(options) => ({ command: 'paths.show' as const, options }),
			),
			{ description: cliDescription('Print all resolved paths and their on-disk size') },
		),
		{ description: cliDescription('Inspect paths resolved from system.json') },
	);
}

export async function runPathsCommand(
	io: CliIo,
	dependencies: CliDependencies,
	options: PathsCommandOptions,
): Promise<void> {
	const systemConfig = await loadSystemConfigFromOption(options.config, dependencies);
	const sizes = options.sizes;
	const zoneEntryPromises = systemConfig.zones.flatMap((zone) => {
		const backupDir = zone.gateway.backupDir ?? `${zone.gateway.stateDir}/backups`;
		const entries = [
			buildResolvedPathEntry(`zone[${zone.id}].stateDir`, zone.gateway.stateDir, sizes),
			buildResolvedPathEntry(`zone[${zone.id}].backupDir`, backupDir, sizes),
			buildResolvedPathEntry(`zone[${zone.id}].zoneRuntimeDir`, zone.gateway.zoneRuntimeDir, sizes),
		];
		if (zone.gateway.type === 'worker') {
			return entries;
		}
		return [
			...entries,
			buildResolvedPathEntry(`zone[${zone.id}].zoneFilesDir`, zone.gateway.zoneFilesDir, sizes),
		];
	});
	const entries: ResolvedPathEntry[] = await Promise.all([
		buildResolvedPathEntry('storageRootDir', systemConfig.storageRootDir, sizes),
		buildResolvedPathEntry('cacheDir', systemConfig.cacheDir, sizes),
		buildResolvedPathEntry('controllerStateDir', systemConfig.controllerStateDir, sizes),
		buildResolvedPathEntry('controllerRuntimeDir', systemConfig.controllerRuntimeDir, sizes),
		...zoneEntryPromises,
	]);

	const labelWidth = entries.reduce((width, entry) => Math.max(width, entry.label.length), 0);
	const lines: string[] = [];
	for (const entry of entries) {
		const existsMark = entry.exists ? '✓' : '✗';
		const sizeText = sizes ? `  ${formatBytes(entry.sizeBytes)}` : '';
		lines.push(`${existsMark} ${entry.label.padEnd(labelWidth)}  ${entry.path}${sizeText}`);
	}
	io.stdout.write(`${lines.join('\n')}\n`);
}
