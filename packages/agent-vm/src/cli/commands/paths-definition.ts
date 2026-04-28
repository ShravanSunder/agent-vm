// oxlint-disable typescript-eslint/explicit-function-return-type, eslint/no-await-in-loop -- path sizing walks the filesystem sequentially to avoid EMFILE on large trees
import fs from 'node:fs/promises';

import { command, flag, subcommands } from 'cmd-ts';

import type { CliDependencies, CliIo } from '../agent-vm-cli-support.js';
import { createConfigOption, loadSystemConfigFromOption } from './command-definition-support.js';

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

export function createPathsSubcommands(io: CliIo, dependencies: CliDependencies) {
	return subcommands({
		name: 'paths',
		description: 'Inspect paths resolved from system.json',
		cmds: {
			show: command({
				name: 'show',
				description: 'Print all resolved paths and their on-disk size',
				args: {
					config: createConfigOption(),
					sizes: flag({
						long: 'sizes',
						description: 'Walk each path and print disk usage (slower)',
					}),
				},
				handler: async ({ config, sizes }) => {
					const systemConfig = await loadSystemConfigFromOption(config, dependencies);
					const zoneEntryPromises = systemConfig.zones.flatMap((zone) => {
						const backupDir = zone.gateway.backupDir ?? `${zone.gateway.stateDir}/backups`;
						const entries = [
							buildResolvedPathEntry(`zone[${zone.id}].stateDir`, zone.gateway.stateDir, sizes),
							buildResolvedPathEntry(`zone[${zone.id}].backupDir`, backupDir, sizes),
						];
						if (zone.gateway.type !== 'openclaw') {
							return entries;
						}
						return [
							...entries,
							buildResolvedPathEntry(
								`zone[${zone.id}].zoneFilesDir`,
								zone.gateway.zoneFilesDir,
								sizes,
							),
						];
					});
					const toolProfileEntryPromises = Object.entries(systemConfig.toolProfiles).map(
						([profileId, profile]) =>
							buildResolvedPathEntry(
								`toolProfile[${profileId}].workspaceRoot`,
								profile.workspaceRoot,
								sizes,
							),
					);
					const entries: ResolvedPathEntry[] = await Promise.all([
						buildResolvedPathEntry('cacheDir', systemConfig.cacheDir, sizes),
						buildResolvedPathEntry('runtimeDir', systemConfig.runtimeDir, sizes),
						...zoneEntryPromises,
						...toolProfileEntryPromises,
					]);

					const labelWidth = entries.reduce(
						(width, entry) => Math.max(width, entry.label.length),
						0,
					);
					const lines: string[] = [];
					for (const entry of entries) {
						const existsMark = entry.exists ? '✓' : '✗';
						const sizeText = sizes ? `  ${formatBytes(entry.sizeBytes)}` : '';
						lines.push(`${existsMark} ${entry.label.padEnd(labelWidth)}  ${entry.path}${sizeText}`);
					}
					io.stdout.write(`${lines.join('\n')}\n`);
				},
			}),
		},
	});
}
