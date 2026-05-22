import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const effectiveConfigManifestFileName = 'mcp-portal-effective-manifest.json';

export interface EffectiveConfigPaths {
	readonly mcpConfigPath: string;
	readonly portalConfigPath: string;
}

function isObjectRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeManifestFileName(value: string): boolean {
	return value.length > 0 && !value.includes('/') && !value.includes('\\');
}

function parseEffectiveConfigManifest(value: unknown): {
	readonly mcpConfigFile: string;
	readonly portalConfigFile: string;
} {
	if (!isObjectRecord(value)) {
		throw new Error('MCP Portal effective config manifest must be an object.');
	}
	if (value.schemaVersion !== 1) {
		throw new Error('MCP Portal effective config manifest must use schemaVersion 1.');
	}
	if (typeof value.mcpConfigFile !== 'string' || !isSafeManifestFileName(value.mcpConfigFile)) {
		throw new Error('MCP Portal effective config manifest must contain a safe mcpConfigFile.');
	}
	if (
		typeof value.portalConfigFile !== 'string' ||
		!isSafeManifestFileName(value.portalConfigFile)
	) {
		throw new Error('MCP Portal effective config manifest must contain a safe portalConfigFile.');
	}
	return {
		mcpConfigFile: value.mcpConfigFile,
		portalConfigFile: value.portalConfigFile,
	};
}

function isMissingFileError(error: unknown): boolean {
	return (
		isObjectRecord(error) &&
		typeof error.code === 'string' &&
		(error.code === 'ENOENT' || error.code === 'ENOTDIR')
	);
}

export async function resolveEffectiveConfigPaths(
	configDir: string,
): Promise<EffectiveConfigPaths> {
	const manifestPath = join(configDir, effectiveConfigManifestFileName);
	let manifestText: string;
	try {
		manifestText = await readFile(manifestPath, 'utf8');
	} catch (error) {
		if (isMissingFileError(error)) {
			return {
				mcpConfigPath: join(configDir, 'mcp.config.jsonc'),
				portalConfigPath: join(configDir, 'mcp-portal.config.jsonc'),
			};
		}
		throw error;
	}
	const manifest = parseEffectiveConfigManifest(JSON.parse(manifestText));
	return {
		mcpConfigPath: join(configDir, manifest.mcpConfigFile),
		portalConfigPath: join(configDir, manifest.portalConfigFile),
	};
}
