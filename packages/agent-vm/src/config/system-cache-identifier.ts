import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

export const SYSTEM_CACHE_IDENTIFIER_FILENAME = 'systemCacheIdentifier.json';

export interface LoadSystemCacheIdentifierOptions {
	readonly filePath: string;
}

export interface SystemCacheIdentifierPlatformDependencies {
	readonly cacheFormat?: string;
	readonly cacheProfile?: string;
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
	readonly cacheProfile: string;
	readonly cacheFormat: string;
}

const systemCacheIdentifierComment =
	'Cache compatibility identifier. Contents hash into Gondolin image fingerprints. Change cacheProfile or cacheFormat when the outer cache contract changes.';

const legacySystemCacheIdentifierSchema = z.object({}).passthrough();
const systemCacheIdentifierV1Schema = z
	.object({
		$comment: z.string(),
		schemaVersion: z.literal(1),
		os: z.enum(['darwin', 'linux', 'unknown']),
		hostSystemType: z.enum(['bare-metal', 'container']),
		cacheProfile: z.string().min(1),
		cacheFormat: z.string().min(1),
	})
	.strict();

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
		cacheProfile: dependencies.cacheProfile ?? 'default',
		cacheFormat: dependencies.cacheFormat ?? 'gondolin-cache-v1',
	};
}

export async function loadSystemCacheIdentifier(
	options: LoadSystemCacheIdentifierOptions,
): Promise<Record<string, unknown>> {
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

	let parsedContents: unknown;
	try {
		parsedContents = JSON.parse(rawContents);
	} catch (error) {
		throw new Error(
			`Failed to parse system cache identifier '${options.filePath}': ${getErrorMessage(error)}`,
			{ cause: error },
		);
	}

	const legacyResult = legacySystemCacheIdentifierSchema.safeParse(parsedContents);
	if (!legacyResult.success) {
		throw new Error(
			`Invalid system cache identifier '${options.filePath}': expected JSON object.`,
			{
				cause: legacyResult.error,
			},
		);
	}

	const hasV1Fields =
		'schemaVersion' in legacyResult.data &&
		'os' in legacyResult.data &&
		'hostSystemType' in legacyResult.data &&
		'cacheProfile' in legacyResult.data &&
		'cacheFormat' in legacyResult.data;
	if (!hasV1Fields) {
		return legacyResult.data;
	}

	const v1Result = systemCacheIdentifierV1Schema.safeParse(legacyResult.data);
	if (!v1Result.success) {
		throw new Error(`Invalid system cache identifier '${options.filePath}': v1 schema mismatch.`, {
			cause: v1Result.error,
		});
	}
	return v1Result.data;
}
