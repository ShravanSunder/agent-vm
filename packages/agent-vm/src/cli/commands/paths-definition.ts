// oxlint-disable typescript-eslint/explicit-function-return-type
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
			try {
				const fileStats = await fs.stat(child);
				total += fileStats.size;
			} catch {
				// skip unreadable entries — best-effort accounting
			}
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
					const entries: ResolvedPathEntry[] = [];

					const cacheStat = await statPath(systemConfig.cacheDir);
					entries.push({
						label: 'cacheDir',
						path: systemConfig.cacheDir,
						exists: cacheStat.exists,
						sizeBytes: sizes && cacheStat.exists ? await walkSize(systemConfig.cacheDir) : null,
					});

					for (const zone of systemConfig.zones) {
						const stateStat = await statPath(zone.gateway.stateDir);
						entries.push({
							label: `zone[${zone.id}].stateDir`,
							path: zone.gateway.stateDir,
							exists: stateStat.exists,
							sizeBytes: sizes && stateStat.exists ? await walkSize(zone.gateway.stateDir) : null,
						});
						const workspaceStat = await statPath(zone.gateway.workspaceDir);
						entries.push({
							label: `zone[${zone.id}].workspaceDir`,
							path: zone.gateway.workspaceDir,
							exists: workspaceStat.exists,
							sizeBytes:
								sizes && workspaceStat.exists ? await walkSize(zone.gateway.workspaceDir) : null,
						});
						const backupDir = zone.gateway.backupDir ?? `${zone.gateway.stateDir}/backups`;
						const backupStat = await statPath(backupDir);
						entries.push({
							label: `zone[${zone.id}].backupDir`,
							path: backupDir,
							exists: backupStat.exists,
							sizeBytes: sizes && backupStat.exists ? await walkSize(backupDir) : null,
						});
					}

					for (const [profileId, profile] of Object.entries(systemConfig.toolProfiles)) {
						const stat = await statPath(profile.workspaceRoot);
						entries.push({
							label: `toolProfile[${profileId}].workspaceRoot`,
							path: profile.workspaceRoot,
							exists: stat.exists,
							sizeBytes: sizes && stat.exists ? await walkSize(profile.workspaceRoot) : null,
						});
					}

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
