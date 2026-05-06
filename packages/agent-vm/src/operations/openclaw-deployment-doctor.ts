import { readFile } from 'node:fs/promises';

import type { LoadedSystemConfig } from '../config/system-config.js';
import type { DoctorCheck } from './doctor.js';

interface OpenClawDeploymentConfig {
	readonly agents?: {
		readonly defaults?: {
			readonly sandbox?: {
				readonly [key: string]: unknown;
				readonly workspaceAccess?: unknown;
			};
			readonly workspace?: unknown;
		};
	};
	readonly bindings?: readonly unknown[];
	readonly channels?: {
		readonly discord?: {
			readonly enabled?: unknown;
			readonly guilds?: Record<string, unknown>;
		};
	};
	readonly plugins?: {
		readonly allow?: readonly unknown[];
		readonly entries?: Record<string, unknown>;
		readonly load?: {
			readonly paths?: readonly unknown[];
		};
		readonly slots?: {
			readonly memory?: unknown;
		};
	};
	readonly session?: {
		readonly dmScope?: unknown;
	};
}

export interface OpenClawDeploymentDoctorTarget {
	readonly config: OpenClawDeploymentConfig;
	readonly zoneId: string;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function includesString(values: readonly unknown[] | undefined, expectedValue: string): boolean {
	return values?.some((value) => value === expectedValue) === true;
}

function hasEnabledEntry(
	entries: Record<string, unknown> | undefined,
	pluginName: string,
): boolean {
	const entry = entries?.[pluginName];
	return isObjectRecord(entry) && entry.enabled === true;
}

function parseOpenClawDeploymentConfig(rawConfig: string): OpenClawDeploymentConfig {
	const parsedConfig: unknown = JSON.parse(rawConfig);
	return isObjectRecord(parsedConfig) ? parsedConfig : {};
}

function getDiscordBindingGuildIds(bindings: readonly unknown[] | undefined): readonly string[] {
	const guildIds = new Set<string>();
	for (const binding of bindings ?? []) {
		if (!isObjectRecord(binding) || !isObjectRecord(binding.match)) {
			continue;
		}
		if (binding.match.channel === 'discord' && typeof binding.match.guildId === 'string') {
			guildIds.add(binding.match.guildId);
		}
	}
	return [...guildIds].toSorted();
}

function getMissingDiscordGuildIds(config: OpenClawDeploymentConfig): readonly string[] {
	const configuredGuilds = config.channels?.discord?.guilds ?? {};
	return getDiscordBindingGuildIds(config.bindings).filter(
		(guildId) => !Object.hasOwn(configuredGuilds, guildId),
	);
}

function hasIsolatedDmScope(config: OpenClawDeploymentConfig): boolean {
	return (
		config.session?.dmScope === 'per-channel-peer' ||
		config.session?.dmScope === 'per-account-channel-peer'
	);
}

export function buildOpenClawDeploymentDoctorChecks(
	targets: readonly OpenClawDeploymentDoctorTarget[],
): readonly DoctorCheck[] {
	return targets.flatMap((target) => {
		const config = target.config;
		const pluginLoadPaths = config.plugins?.load?.paths;
		const hasMemoryCore =
			includesString(config.plugins?.allow, 'memory-core') ||
			hasEnabledEntry(config.plugins?.entries, 'memory-core');
		const hasDiscordPlugin =
			includesString(config.plugins?.allow, 'discord') ||
			hasEnabledEntry(config.plugins?.entries, 'discord');
		const workspace = config.agents?.defaults?.workspace;
		const discordEnabled = config.channels?.discord?.enabled === true;
		const missingDiscordGuildIds = getMissingDiscordGuildIds(config);
		return [
			{
				name: `openclaw-workspace-access-${target.zoneId}`,
				ok: config.agents?.defaults?.sandbox?.workspaceAccess === 'rw',
				hint:
					config.agents?.defaults?.sandbox?.workspaceAccess === 'rw'
						? 'agents.defaults.sandbox.workspaceAccess=rw'
						: 'Set agents.defaults.sandbox.workspaceAccess to "rw" so agents can write their workspace.',
			},
			{
				name: `openclaw-plugin-load-paths-${target.zoneId}`,
				ok:
					includesString(pluginLoadPaths, '/home/openclaw/.openclaw/extensions') &&
					includesString(pluginLoadPaths, '/pnpm/global/5/node_modules/@openclaw'),
				hint: 'Add plugins.load.paths for /home/openclaw/.openclaw/extensions and /pnpm/global/5/node_modules/@openclaw.',
			},
			{
				name: `openclaw-memory-slot-${target.zoneId}`,
				ok: !hasMemoryCore || config.plugins?.slots?.memory === 'memory-core',
				hint:
					!hasMemoryCore || config.plugins?.slots?.memory === 'memory-core'
						? 'plugins.slots.memory=memory-core'
						: 'Set plugins.slots.memory to "memory-core" when memory-core is enabled.',
			},
			{
				name: `openclaw-stale-discord-plugin-${target.zoneId}`,
				ok: !hasDiscordPlugin,
				hint: hasDiscordPlugin
					? 'Remove Discord from plugins.allow/plugins.entries; configure Discord under channels.discord instead.'
					: 'Discord plugin entries absent',
			},
			{
				name: `openclaw-shared-zone-workspace-${target.zoneId}`,
				ok: workspace !== '/zone',
				hint:
					workspace === '/zone'
						? 'Use /zone/agents/default or per-agent workspaces; keep /zone for shared zone files.'
						: typeof workspace === 'string'
							? workspace
							: 'agents.defaults.workspace is unset',
			},
			{
				name: `openclaw-dm-scope-${target.zoneId}`,
				ok: !discordEnabled || hasIsolatedDmScope(config),
				hint:
					!discordEnabled || hasIsolatedDmScope(config)
						? 'session.dmScope isolates Discord DMs'
						: 'Set session.dmScope to "per-channel-peer" for Discord multi-user isolation.',
			},
			{
				name: `openclaw-discord-guild-bindings-${target.zoneId}`,
				ok: !discordEnabled || missingDiscordGuildIds.length === 0,
				hint:
					!discordEnabled || missingDiscordGuildIds.length === 0
						? 'Discord binding guildIds are present under channels.discord.guilds'
						: `Add channels.discord.guilds entries for binding guildId values: ${missingDiscordGuildIds.join(', ')}.`,
			},
		] as const satisfies readonly DoctorCheck[];
	});
}

export async function collectOpenClawDeploymentDoctorChecks(
	systemConfig: LoadedSystemConfig,
): Promise<readonly DoctorCheck[]> {
	const targets = await Promise.all(
		systemConfig.zones
			.filter((zone) => zone.gateway.type === 'openclaw')
			.map(async (zone): Promise<OpenClawDeploymentDoctorTarget> => {
				try {
					const rawConfig = await readFile(zone.gateway.config, 'utf8');
					return {
						zoneId: zone.id,
						config: parseOpenClawDeploymentConfig(rawConfig),
					};
				} catch {
					return {
						zoneId: zone.id,
						config: {},
					};
				}
			}),
	);
	return buildOpenClawDeploymentDoctorChecks(targets);
}
