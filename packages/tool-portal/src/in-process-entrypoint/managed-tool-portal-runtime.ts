import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
	loadToolPortalConfig,
	type ToolPortalControllerHostActionProjection,
	type ToolPortalConfig,
} from '@agent-vm/config-contracts';
import {
	createManagedMcpProviderBackendFactory,
	type CreateManagedMcpProviderBackendFactoryProps,
	type ManagedMcpProviderBackendFactory,
	type McpProviderCapabilityBackend,
} from '@agent-vm/mcp-portal/mcp-provider-backend';

import {
	createToolPortalInProcessEntryPoint,
	type ToolPortalCapabilityBackend,
	type ToolPortalInProcessEntryPoint,
} from './tool-portal-in-process-entrypoint.js';

interface EffectiveConfigManifest {
	readonly mcpConfigFile: string;
	readonly schemaVersion: 1;
	readonly toolPortalConfigFile?: string;
}

export interface ManagedToolPortalInProcessRuntime {
	readonly close: () => Promise<void>;
	readonly getEntryPoint: (
		agentId: string,
		options?: { readonly entryPointCacheKey?: string },
	) => Promise<ToolPortalInProcessEntryPoint>;
}

export interface CreateManagedToolPortalInProcessRuntimeProps {
	readonly configDir: string;
	readonly createControllerHostActionBackend?: (
		projection: ToolPortalControllerHostActionProjection,
		context: { readonly entryPointCacheKey: string },
	) => ToolPortalCapabilityBackend;
	readonly createMcpProviderBackendFactory?: (
		props: CreateManagedMcpProviderBackendFactoryProps,
	) => Promise<ManagedMcpProviderBackendFactory>;
	readonly maxEntryPointCacheEntries?: number;
}

const DEFAULT_MAX_ENTRY_POINT_CACHE_ENTRIES = 64;

function containsUnsafeMcpSessionKeyCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const codePoint = value.charCodeAt(index);
		if (codePoint < 32 || codePoint === 127 || codePoint === 0x2028 || codePoint === 0x2029) {
			return true;
		}
	}
	return false;
}

function mcpSessionKeyForEntryPointCacheKey(entryPointCacheKey: string): string {
	if (!containsUnsafeMcpSessionKeyCharacter(entryPointCacheKey)) {
		return entryPointCacheKey;
	}
	const digest = createHash('sha256').update(entryPointCacheKey, 'utf8').digest('base64url');
	return `tool-portal-entrypoint-${digest}`;
}

function isObjectRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readEffectiveConfigManifest(
	configDir: string,
): Promise<EffectiveConfigManifest | null> {
	try {
		const content = await readFile(
			path.join(configDir, 'tool-portal-effective-manifest.json'),
			'utf8',
		);
		const parsed: unknown = JSON.parse(content);
		if (
			!isObjectRecord(parsed) ||
			parsed.schemaVersion !== 1 ||
			typeof parsed.mcpConfigFile !== 'string'
		) {
			throw new Error('Tool Portal effective config manifest is malformed.');
		}
		return {
			mcpConfigFile: parsed.mcpConfigFile,
			schemaVersion: 1,
			...(typeof parsed.toolPortalConfigFile === 'string'
				? { toolPortalConfigFile: parsed.toolPortalConfigFile }
				: {}),
		};
	} catch (error) {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
			return null;
		}
		throw error;
	}
}

function resolveEffectiveConfigManifestFilePath(
	configDir: string,
	fileName: string,
	fieldName: string,
): string {
	if (
		fileName.length === 0 ||
		fileName === '.' ||
		fileName === '..' ||
		path.isAbsolute(fileName) ||
		fileName.includes('/') ||
		fileName.includes('\\')
	) {
		throw new Error(
			`Tool Portal effective config manifest ${fieldName} must name a file inside the config directory.`,
		);
	}
	const resolvedConfigDir = path.resolve(configDir);
	const resolvedFilePath = path.resolve(resolvedConfigDir, fileName);
	if (path.dirname(resolvedFilePath) !== resolvedConfigDir) {
		throw new Error(
			`Tool Portal effective config manifest ${fieldName} must stay inside the config directory.`,
		);
	}
	return resolvedFilePath;
}

async function loadManagedToolPortalConfig(configDir: string): Promise<{
	readonly mcpConfigPath: string;
	readonly toolPortalConfig: ToolPortalConfig;
}> {
	const manifest = await readEffectiveConfigManifest(configDir);
	if (manifest !== null) {
		if (manifest.toolPortalConfigFile === undefined) {
			throw new Error('Tool Portal effective config manifest does not name toolPortalConfigFile.');
		}
		const mcpConfigPath = resolveEffectiveConfigManifestFilePath(
			configDir,
			manifest.mcpConfigFile,
			'mcpConfigFile',
		);
		const toolPortalConfigPath = resolveEffectiveConfigManifestFilePath(
			configDir,
			manifest.toolPortalConfigFile,
			'toolPortalConfigFile',
		);
		return {
			mcpConfigPath,
			toolPortalConfig: await loadToolPortalConfig(toolPortalConfigPath),
		};
	}

	const mcpConfigPath = path.join(configDir, 'mcp.config.jsonc');
	const toolPortalConfigPath = path.join(configDir, 'tool-portal.config.jsonc');
	return {
		mcpConfigPath,
		toolPortalConfig: await loadToolPortalConfig(toolPortalConfigPath),
	};
}

async function resolveEnvironmentSecret(secret: {
	readonly name?: string;
	readonly source: string;
}): Promise<string> {
	if (secret.source !== 'environment' || typeof secret.name !== 'string') {
		throw new Error(
			'Tool Portal managed OpenClaw effective config must use environment secret refs.',
		);
	}
	const value = process.env[secret.name];
	if (value === undefined || value.length === 0) {
		throw new Error(`Missing environment secret ${secret.name} for Tool Portal native tools.`);
	}
	return value;
}

export function createManagedToolPortalInProcessRuntime(
	props: CreateManagedToolPortalInProcessRuntimeProps,
): ManagedToolPortalInProcessRuntime {
	let mcpProviderBackendFactoryPromise: Promise<ManagedMcpProviderBackendFactory> | undefined;
	const cachedEntryPointsByCacheKey = new Map<string, Promise<ToolPortalInProcessEntryPoint>>();
	const liveEntryPointsByCacheKey = new Map<string, Promise<ToolPortalInProcessEntryPoint>>();
	const maxEntryPointCacheEntries =
		props.maxEntryPointCacheEntries ?? DEFAULT_MAX_ENTRY_POINT_CACHE_ENTRIES;
	if (!Number.isInteger(maxEntryPointCacheEntries) || maxEntryPointCacheEntries < 1) {
		throw new Error('Tool Portal maxEntryPointCacheEntries must be a positive integer.');
	}

	const getMcpProviderBackendFactory = async (): Promise<ManagedMcpProviderBackendFactory> => {
		mcpProviderBackendFactoryPromise ??= (async () => {
			const { mcpConfigPath } = await loadManagedToolPortalConfig(props.configDir);
			const createFactory =
				props.createMcpProviderBackendFactory ?? createManagedMcpProviderBackendFactory;
			return await createFactory({
				mcpConfigPath,
				resolveSecret: resolveEnvironmentSecret,
			});
		})().catch((error: unknown) => {
			mcpProviderBackendFactoryPromise = undefined;
			throw error;
		});
		return await mcpProviderBackendFactoryPromise;
	};

	const retireMcpSessionIfFactoryExists = async (entryPointCacheKey: string): Promise<void> => {
		if (mcpProviderBackendFactoryPromise === undefined) {
			return;
		}
		const factory = await mcpProviderBackendFactoryPromise;
		await factory.retireSession(mcpSessionKeyForEntryPointCacheKey(entryPointCacheKey));
	};

	const retireEntryPointAfterSettlement = async (
		entryPointCacheKey: string,
		entryPointPromise: Promise<ToolPortalInProcessEntryPoint>,
	): Promise<void> => {
		await entryPointPromise.catch(() => undefined);
		await retireMcpSessionIfFactoryExists(entryPointCacheKey);
	};

	const trimCachedEntryPoints = (): void => {
		while (cachedEntryPointsByCacheKey.size > maxEntryPointCacheEntries) {
			const oldestEntryPointCacheKey = cachedEntryPointsByCacheKey.keys().next().value;
			if (typeof oldestEntryPointCacheKey !== 'string') {
				break;
			}
			cachedEntryPointsByCacheKey.delete(oldestEntryPointCacheKey);
		}
	};

	return {
		close: async () => {
			const entryPointEntries = [...liveEntryPointsByCacheKey.entries()];
			cachedEntryPointsByCacheKey.clear();
			liveEntryPointsByCacheKey.clear();
			await Promise.all(
				entryPointEntries.map(([entryPointCacheKey, entryPointPromise]) =>
					retireEntryPointAfterSettlement(entryPointCacheKey, entryPointPromise),
				),
			);
			if (mcpProviderBackendFactoryPromise !== undefined) {
				const factory = await mcpProviderBackendFactoryPromise;
				await factory.close();
				mcpProviderBackendFactoryPromise = undefined;
			}
		},
		getEntryPoint: async (agentId, options = {}) => {
			const entryPointCacheKey = options.entryPointCacheKey ?? agentId;
			const existingEntryPoint =
				cachedEntryPointsByCacheKey.get(entryPointCacheKey) ??
				liveEntryPointsByCacheKey.get(entryPointCacheKey);
			if (existingEntryPoint !== undefined) {
				cachedEntryPointsByCacheKey.delete(entryPointCacheKey);
				cachedEntryPointsByCacheKey.set(entryPointCacheKey, existingEntryPoint);
				trimCachedEntryPoints();
				return await existingEntryPoint;
			}
			const entryPointPromise = (async () => {
				const { toolPortalConfig } = await loadManagedToolPortalConfig(props.configDir);
				const mcpProviderBackendFactory = await getMcpProviderBackendFactory();
				return createToolPortalInProcessEntryPoint({
					agentId,
					config: toolPortalConfig,
					entryPointCacheKey,
					...(props.createControllerHostActionBackend === undefined
						? {}
						: {
								createControllerHostActionBackend: props.createControllerHostActionBackend,
							}),
					createMcpBackend: (projection): McpProviderCapabilityBackend =>
						mcpProviderBackendFactory.createBackend(projection, {
							sessionKey: mcpSessionKeyForEntryPointCacheKey(entryPointCacheKey),
						}),
				});
			})().catch((error: unknown) => {
				if (cachedEntryPointsByCacheKey.get(entryPointCacheKey) === entryPointPromise) {
					cachedEntryPointsByCacheKey.delete(entryPointCacheKey);
				}
				if (liveEntryPointsByCacheKey.get(entryPointCacheKey) === entryPointPromise) {
					liveEntryPointsByCacheKey.delete(entryPointCacheKey);
				}
				throw error;
			});
			liveEntryPointsByCacheKey.set(entryPointCacheKey, entryPointPromise);
			cachedEntryPointsByCacheKey.set(entryPointCacheKey, entryPointPromise);
			trimCachedEntryPoints();
			return await entryPointPromise;
		},
	};
}
