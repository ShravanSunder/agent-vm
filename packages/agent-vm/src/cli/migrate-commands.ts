import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
	createConfigContractSchemaArtifacts,
	mcpPortalConfigSchemaPaths,
} from '@agent-vm/config-contracts';
import { portalServerNameForAgent } from '@agent-vm/openclaw-mcp-portal-plugin';
import { applyEdits, modify, type FormattingOptions, type JSONPath } from 'jsonc-parser';

import { loadJsonConfigFile } from '../config/json-config-file.js';
import { createSystemConfigSchemaArtifact } from '../config/system-config.js';

export interface MigrateImagesCommandResult {
	readonly migratedProfiles: readonly string[];
	readonly skippedProfiles: readonly string[];
}

export interface MigrateMcpPortalConfigCommandResult {
	readonly createdFiles: readonly string[];
	readonly migratedZones: readonly string[];
	readonly skippedZones: readonly string[];
}

interface MutableImageProfile {
	type?: unknown;
	buildConfig?: unknown;
	dockerfile?: unknown;
	source?: unknown;
}

interface MutableSystemConfig {
	imageProfiles?: {
		gateways?: Record<string, MutableImageProfile>;
		toolVms?: Record<string, MutableImageProfile>;
	};
	zones?: readonly unknown[];
}

interface MutableSystemZone {
	readonly agents?: unknown;
	readonly gateway?: {
		readonly config?: unknown;
		readonly type?: unknown;
	};
	readonly id?: unknown;
	readonly mcp?: unknown;
}

interface ImageProfileMigration {
	readonly dockerfilePath: JSONPath;
	readonly sourcePath: JSONPath;
	readonly source: {
		readonly kind: 'managedBase';
		readonly base: 'openclaw-gateway' | 'tool-vm' | 'worker-gateway';
		readonly overlay: string;
	};
}

const systemConfigFormattingOptions = {
	insertSpaces: false,
	tabSize: 1,
} as const satisfies FormattingOptions;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMutableSystemConfig(value: unknown): MutableSystemConfig {
	if (!isRecord(value)) {
		throw new Error('system config must be an object.');
	}
	const imageProfiles = value.imageProfiles;
	if (imageProfiles !== undefined && !isRecord(imageProfiles)) {
		throw new Error('system config imageProfiles must be an object.');
	}
	return value as MutableSystemConfig;
}

function parseMutableSystemZone(value: unknown): MutableSystemZone | null {
	if (!isRecord(value)) {
		return null;
	}
	const gateway = isRecord(value.gateway) ? value.gateway : undefined;
	return {
		agents: value.agents,
		...(gateway === undefined
			? {}
			: {
					gateway: {
						config: gateway.config,
						type: gateway.type,
					},
				}),
		id: value.id,
		mcp: value.mcp,
	};
}

function applyJsoncEdit(rawConfigText: string, pathToEdit: JSONPath, value: unknown): string {
	return applyEdits(
		rawConfigText,
		modify(rawConfigText, pathToEdit, value, {
			formattingOptions: systemConfigFormattingOptions,
		}),
	);
}

async function writeFileIfMissing(filePath: string, content: string): Promise<boolean> {
	try {
		await readFile(filePath, 'utf8');
		return false;
	} catch (error) {
		if (
			typeof error !== 'object' ||
			error === null ||
			!('code' in error) ||
			error.code !== 'ENOENT'
		) {
			throw error;
		}
		await mkdir(path.dirname(filePath), { recursive: true });
		await writeFile(filePath, content, 'utf8');
		return true;
	}
}

function resolveManagedGatewayBase(
	profile: MutableImageProfile,
): 'openclaw-gateway' | 'worker-gateway' {
	return profile.type === 'openclaw' ? 'openclaw-gateway' : 'worker-gateway';
}

function resolveOverlayPathFromDockerfile(dockerfilePath: string): string {
	return path.posix.join(path.posix.dirname(dockerfilePath), 'overlay.jsonc');
}

function resolveOverlayFilePath(configPath: string, overlayPath: string): string {
	if (path.isAbsolute(overlayPath)) {
		return overlayPath;
	}
	return path.resolve(path.dirname(configPath), overlayPath);
}

async function writeOverlayIfMissing(overlayFilePath: string): Promise<void> {
	try {
		await readFile(overlayFilePath, 'utf8');
	} catch (error) {
		if (
			typeof error !== 'object' ||
			error === null ||
			!('code' in error) ||
			error.code !== 'ENOENT'
		) {
			throw error;
		}
		await mkdir(path.dirname(overlayFilePath), { recursive: true });
		await writeFile(
			overlayFilePath,
			[
				'{',
				'  // Human-authored managed image overlay. Comments are allowed here.',
				'  "schemaVersion": 1,',
				'  "extraAptPackages": []',
				'}',
				'',
			].join('\n'),
			'utf8',
		);
	}
}

async function migrateImageProfile(props: {
	readonly configPath: string;
	readonly family: 'gateway' | 'toolVm';
	readonly profile: MutableImageProfile;
	readonly profilePath: JSONPath;
}): Promise<ImageProfileMigration | 'skipped'> {
	if (props.profile.source !== undefined || typeof props.profile.dockerfile !== 'string') {
		return 'skipped';
	}
	const overlayPath = resolveOverlayPathFromDockerfile(props.profile.dockerfile);
	const source = {
		kind: 'managedBase',
		base: props.family === 'gateway' ? resolveManagedGatewayBase(props.profile) : 'tool-vm',
		overlay: overlayPath,
	} as const satisfies ImageProfileMigration['source'];
	await writeOverlayIfMissing(resolveOverlayFilePath(props.configPath, overlayPath));
	return {
		dockerfilePath: [...props.profilePath, 'dockerfile'],
		sourcePath: [...props.profilePath, 'source'],
		source,
	};
}

function applyImageProfileMigrations(
	rawConfigText: string,
	migrations: readonly ImageProfileMigration[],
): string {
	let updatedConfigText = rawConfigText;
	for (const migration of migrations) {
		updatedConfigText = applyEdits(
			updatedConfigText,
			modify(updatedConfigText, migration.sourcePath, migration.source, {
				formattingOptions: systemConfigFormattingOptions,
			}),
		);
		updatedConfigText = applyEdits(
			updatedConfigText,
			modify(updatedConfigText, migration.dockerfilePath, undefined, {
				formattingOptions: systemConfigFormattingOptions,
			}),
		);
	}
	return updatedConfigText.endsWith('\n') ? updatedConfigText : `${updatedConfigText}\n`;
}

export async function runMigrateImagesCommand(options: {
	readonly systemConfigPath: string;
}): Promise<MigrateImagesCommandResult> {
	const rawConfigText = await readFile(options.systemConfigPath, 'utf8');
	const rawConfig = parseMutableSystemConfig(await loadJsonConfigFile(options.systemConfigPath));
	const migratedProfiles: string[] = [];
	const migrations: ImageProfileMigration[] = [];
	const skippedProfiles: string[] = [];
	for (const [profileName, profile] of Object.entries(rawConfig.imageProfiles?.gateways ?? {})) {
		// oxlint-disable-next-line no-await-in-loop -- rewrites stay deterministic and low-volume
		const migration = await migrateImageProfile({
			configPath: options.systemConfigPath,
			family: 'gateway',
			profile,
			profilePath: ['imageProfiles', 'gateways', profileName],
		});
		if (migration === 'skipped') {
			skippedProfiles.push(`gateway/${profileName}`);
		} else {
			migrations.push(migration);
			migratedProfiles.push(`gateway/${profileName}`);
		}
	}
	for (const [profileName, profile] of Object.entries(rawConfig.imageProfiles?.toolVms ?? {})) {
		// oxlint-disable-next-line no-await-in-loop -- rewrites stay deterministic and low-volume
		const migration = await migrateImageProfile({
			configPath: options.systemConfigPath,
			family: 'toolVm',
			profile,
			profilePath: ['imageProfiles', 'toolVms', profileName],
		});
		if (migration === 'skipped') {
			skippedProfiles.push(`toolVm/${profileName}`);
		} else {
			migrations.push(migration);
			migratedProfiles.push(`toolVm/${profileName}`);
		}
	}
	await writeFile(
		options.systemConfigPath,
		applyImageProfileMigrations(rawConfigText, migrations),
		'utf8',
	);
	return { migratedProfiles, skippedProfiles };
}

function defaultMcpProviderConfigText(): string {
	return `${JSON.stringify(
		{
			$schema: mcpPortalConfigSchemaPaths.mcpFromGatewayConfig,
			schemaVersion: 1,
			providers: {},
		},
		null,
		'\t',
	)}\n`;
}

function defaultMcpPortalConfigText(agentIds: readonly string[]): string {
	return `${JSON.stringify(
		{
			$schema: mcpPortalConfigSchemaPaths.mcpPortalFromGatewayConfig,
			schemaVersion: 1,
			server: {
				host: '127.0.0.1',
				port: 18790,
				accessHeader: {
					name: 'x-agent-vm-mcp-portal-secret',
					secret: { source: 'environment', name: 'MCP_PORTAL_SERVER_SECRET' },
				},
			},
			agents: Object.fromEntries(agentIds.map((agentId) => [agentId, { profile: 'default' }])),
			profiles: {
				default: {
					enabledNamespaces: [],
					enabledToolsByNamespace: {},
					hiddenToolsByNamespace: {},
					approval: {
						allowWithoutApprovalTools: [],
						alwaysAskTools: [],
						annotationPolicy: 'destructive-requires-approval',
						trustedAnnotationNamespaces: [],
						writeTools: [],
					},
					promptContext: { enabled: true, maxNamespaces: 12 },
					cache: { catalogTtlMs: 60_000 },
					logging: { enabled: false },
				},
			},
		},
		null,
		'\t',
	)}\n`;
}

function relativeConfigDirFromGatewayConfig(gatewayConfigPath: string): string {
	const gatewayConfigDir = path.posix.dirname(
		gatewayConfigPath.replaceAll(path.sep, path.posix.sep),
	);
	if (path.isAbsolute(gatewayConfigPath) || path.posix.isAbsolute(gatewayConfigDir)) {
		return gatewayConfigDir;
	}
	return gatewayConfigDir.startsWith('.') ? gatewayConfigDir : `./${gatewayConfigDir}`;
}

function absoluteConfigDirFromSystemConfig(systemConfigPath: string, configDir: string): string {
	return path.isAbsolute(configDir)
		? configDir
		: path.resolve(path.dirname(systemConfigPath), configDir);
}

function deploymentRelativePath(systemConfigPath: string, filePath: string): string {
	return path.relative(path.resolve(path.dirname(systemConfigPath), '..'), filePath);
}

function formatJsonSchemaArtifact(value: Record<string, unknown>): string {
	return `${JSON.stringify(value, null, '\t')}\n`;
}

async function writeConfigSchemaArtifactsIfMissing(props: {
	readonly createdFiles: string[];
	readonly systemConfigPath: string;
}): Promise<void> {
	const contractSchemas = createConfigContractSchemaArtifacts();
	const schemaDirectory = path.join(path.dirname(props.systemConfigPath), 'schemas');
	const schemas: Readonly<Record<string, Record<string, unknown>>> = {
		'system.schema.json': createSystemConfigSchemaArtifact(),
		'mcp.schema.json': contractSchemas.mcp,
		'mcp-portal.schema.json': contractSchemas.mcpPortal,
	};
	const schemaWriteResults = await Promise.all(
		Object.entries(schemas).map(async ([fileName, schema]) => {
			const schemaPath = path.join(schemaDirectory, fileName);
			return {
				created: await writeFileIfMissing(schemaPath, formatJsonSchemaArtifact(schema)),
				schemaPath,
			};
		}),
	);
	for (const { created, schemaPath } of schemaWriteResults) {
		if (created) {
			props.createdFiles.push(deploymentRelativePath(props.systemConfigPath, schemaPath));
		}
	}
}

function extractOpenClawAgentIds(openClawConfig: unknown): readonly string[] {
	if (!isRecord(openClawConfig) || !isRecord(openClawConfig.agents)) {
		return [];
	}
	const list = openClawConfig.agents.list;
	if (!Array.isArray(list)) {
		return [];
	}
	return list
		.map((agent): string | null => {
			if (!isRecord(agent) || typeof agent.id !== 'string') {
				return null;
			}
			return agent.id;
		})
		.filter((agentId): agentId is string => agentId !== null);
}

function buildPortalMcpServers(agentIds: readonly string[]): Record<string, unknown> {
	return Object.fromEntries(
		agentIds.map((agentId) => [
			portalServerNameForAgent(agentId),
			{
				transport: 'streamable-http',
				url: `http://127.0.0.1:18790/agents/${encodeURIComponent(agentId)}/mcp`,
				headers: {
					'x-agent-vm-mcp-portal-secret': '${MCP_PORTAL_SERVER_SECRET}',
				},
			},
		]),
	);
}

function removePortalServerEntries(servers: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(servers).filter(([serverName]) => !serverName.startsWith('mcp_portal_')),
	);
}

function migrateOpenClawConfigForPortal(
	openClawConfig: unknown,
	agentIds: readonly string[],
): object {
	const baseConfig = isRecord(openClawConfig) ? openClawConfig : {};
	const existingMcp = isRecord(baseConfig.mcp) ? baseConfig.mcp : {};
	const existingServers = isRecord(existingMcp.servers) ? existingMcp.servers : {};
	const existingPlugins = isRecord(baseConfig.plugins) ? baseConfig.plugins : {};
	const existingEntries = isRecord(existingPlugins.entries) ? existingPlugins.entries : {};
	const existingPortalEntry = isRecord(existingEntries['mcp-portal'])
		? existingEntries['mcp-portal']
		: {};
	const existingPortalHooks = isRecord(existingPortalEntry.hooks) ? existingPortalEntry.hooks : {};
	const existingPortalConfig = isRecord(existingPortalEntry.config)
		? existingPortalEntry.config
		: {};
	const nextPortalConfig = {
		...(typeof existingPortalConfig.binPath === 'string'
			? { binPath: existingPortalConfig.binPath }
			: {}),
		configDir: '/home/openclaw/.openclaw/config',
	};

	return {
		...baseConfig,
		mcp: {
			...existingMcp,
			servers: {
				...removePortalServerEntries(existingServers),
				...buildPortalMcpServers(agentIds),
			},
		},
		plugins: {
			...existingPlugins,
			entries: {
				...existingEntries,
				'mcp-portal': {
					...existingPortalEntry,
					enabled: true,
					hooks: {
						...existingPortalHooks,
						allowPromptInjection: true,
					},
					config: nextPortalConfig,
				},
			},
		},
	};
}

function applySystemMcpPortalMigration(props: {
	readonly agentIds: readonly string[];
	readonly configDir: string;
	readonly rawConfigText: string;
	readonly systemConfig: MutableSystemConfig;
	readonly zone: MutableSystemZone;
	readonly zoneIndex: number;
}): string {
	let updatedConfigText = props.rawConfigText;
	if (!isRecord(props.systemConfig) || props.systemConfig.$schema === undefined) {
		updatedConfigText = applyJsoncEdit(
			updatedConfigText,
			['$schema'],
			'./schemas/system.schema.json',
		);
	}
	if (!isRecord(props.systemConfig) || props.systemConfig.schemaVersion === undefined) {
		updatedConfigText = applyJsoncEdit(updatedConfigText, ['schemaVersion'], 1);
	}
	if (!Array.isArray(props.zone.agents)) {
		updatedConfigText = applyJsoncEdit(
			updatedConfigText,
			['zones', props.zoneIndex, 'agents'],
			props.agentIds.map((agentId) => ({ id: agentId })),
		);
	}
	if (!isRecord(props.zone.mcp)) {
		updatedConfigText = applyJsoncEdit(updatedConfigText, ['zones', props.zoneIndex, 'mcp'], {
			configDir: props.configDir,
		});
	}
	return updatedConfigText.endsWith('\n') ? updatedConfigText : `${updatedConfigText}\n`;
}

export async function runMigrateMcpPortalConfigCommand(options: {
	readonly systemConfigPath: string;
}): Promise<MigrateMcpPortalConfigCommandResult> {
	const rawConfigText = await readFile(options.systemConfigPath, 'utf8');
	const rawConfig = parseMutableSystemConfig(await loadJsonConfigFile(options.systemConfigPath));
	const migratedZones: string[] = [];
	const skippedZones: string[] = [];
	const createdFiles: string[] = [];
	let updatedSystemConfigText = rawConfigText;
	const zones = rawConfig.zones ?? [];
	await writeConfigSchemaArtifactsIfMissing({
		createdFiles,
		systemConfigPath: options.systemConfigPath,
	});

	for (const [zoneIndex, candidateZone] of zones.entries()) {
		const zone = parseMutableSystemZone(candidateZone);
		if (
			zone === null ||
			typeof zone.id !== 'string' ||
			zone.gateway?.type !== 'openclaw' ||
			typeof zone.gateway.config !== 'string'
		) {
			continue;
		}
		const openClawConfigPath = path.isAbsolute(zone.gateway.config)
			? zone.gateway.config
			: path.resolve(path.dirname(options.systemConfigPath), zone.gateway.config);
		// oxlint-disable-next-line no-await-in-loop -- migration edits must stay deterministic per zone
		const openClawConfig = await loadJsonConfigFile(openClawConfigPath);
		const agentIds = extractOpenClawAgentIds(openClawConfig);
		if (agentIds.length === 0) {
			skippedZones.push(zone.id);
			continue;
		}
		const relativeConfigDir = relativeConfigDirFromGatewayConfig(zone.gateway.config);
		const absoluteConfigDir = absoluteConfigDirFromSystemConfig(
			options.systemConfigPath,
			relativeConfigDir,
		);
		const mcpConfigPath = path.join(absoluteConfigDir, 'mcp.config.jsonc');
		const mcpPortalConfigPath = path.join(absoluteConfigDir, 'mcp-portal.config.jsonc');
		// oxlint-disable-next-line no-await-in-loop -- migration file creation order is reported to users
		if (await writeFileIfMissing(mcpConfigPath, defaultMcpProviderConfigText())) {
			createdFiles.push(deploymentRelativePath(options.systemConfigPath, mcpConfigPath));
		}
		// oxlint-disable-next-line no-await-in-loop -- migration file creation order is reported to users
		if (await writeFileIfMissing(mcpPortalConfigPath, defaultMcpPortalConfigText(agentIds))) {
			createdFiles.push(deploymentRelativePath(options.systemConfigPath, mcpPortalConfigPath));
		}
		updatedSystemConfigText = applySystemMcpPortalMigration({
			agentIds,
			configDir: relativeConfigDir,
			rawConfigText: updatedSystemConfigText,
			systemConfig: rawConfig,
			zone,
			zoneIndex,
		});
		// oxlint-disable-next-line no-await-in-loop -- OpenClaw configs are rewritten beside each zone
		await writeFile(
			openClawConfigPath,
			`${JSON.stringify(migrateOpenClawConfigForPortal(openClawConfig, agentIds), null, '\t')}\n`,
			'utf8',
		);
		migratedZones.push(zone.id);
	}

	await writeFile(options.systemConfigPath, updatedSystemConfigText, 'utf8');
	return { createdFiles, migratedZones, skippedZones };
}
