import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const SYSTEM_CACHE_IDENTIFIER_FILENAME = 'systemCacheIdentifier.json';

export interface LoadSystemCacheIdentifierOptions {
	readonly filePath: string;
}

export interface SystemCacheIdentifierPlatformDependencies {
	readonly hostSystemType?: HostSystemType;
	readonly platform?: () => string;
}

export type SystemCacheOs = 'darwin' | 'linux' | 'unknown';
export type HostSystemType = 'bare-metal' | 'container';

export interface DefaultSystemCacheIdentifier {
	readonly $comment: string;
	readonly schemaVersion: 1;
	readonly os: SystemCacheOs;
	readonly hostSystemType: HostSystemType;
	readonly gitSha: string;
}

const systemCacheIdentifierComment =
	"System cache identifier. Contents hash into every Gondolin image fingerprint. gitSha='local' is the intentional sentinel for bare-metal dev. Container-host builds usually replace gitSha with a build provenance string such as a commit SHA.";

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isMissingFileError(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

export function resolveSystemCacheIdentifierPath(systemConfigPath: string): string {
	return path.join(path.dirname(path.resolve(systemConfigPath)), SYSTEM_CACHE_IDENTIFIER_FILENAME);
}

export function captureSystemOsName(platform: string): SystemCacheOs {
	if (platform === 'darwin' || platform === 'linux') {
		return platform;
	}
	return 'unknown';
}

export function buildDefaultSystemCacheIdentifier(
	dependencies: SystemCacheIdentifierPlatformDependencies = {},
): DefaultSystemCacheIdentifier {
	const platform = dependencies.platform?.() ?? os.platform();
	return {
		$comment: systemCacheIdentifierComment,
		schemaVersion: 1,
		os: captureSystemOsName(platform),
		hostSystemType: dependencies.hostSystemType ?? 'bare-metal',
		gitSha: 'local',
	};
}

export async function loadSystemCacheIdentifier(
	options: LoadSystemCacheIdentifierOptions,
): Promise<unknown> {
	let rawContents: string;
	try {
		rawContents = await fs.readFile(options.filePath, 'utf8');
	} catch (error) {
		if (isMissingFileError(error)) {
			throw new Error(`Missing system cache identifier '${options.filePath}'.`, { cause: error });
		}
		throw new Error(
			`Failed to read system cache identifier '${options.filePath}': ${getErrorMessage(error)}`,
			{ cause: error },
		);
	}

	try {
		return JSON.parse(rawContents) as unknown;
	} catch (error) {
		throw new Error(
			`Failed to parse system cache identifier '${options.filePath}': ${getErrorMessage(error)}`,
			{ cause: error },
		);
	}
}
