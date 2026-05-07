import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

export const SYSTEM_CACHE_IDENTIFIER_FILENAME = 'systemCacheIdentifier.json';

export interface LoadSystemCacheIdentifierOptions {
	readonly filePath: string;
}

export interface SystemCacheIdentifierPlatformDependencies {
	readonly hostSystemType?: HostSystemType;
	readonly imageCacheFormat?: string;
}

export type HostSystemType = 'bare-metal' | 'container';

export interface DefaultSystemCacheIdentifier {
	readonly $comment: string;
	readonly schemaVersion: 1;
	readonly hostSystemType: HostSystemType;
	readonly imageCacheFormat: string;
}

const systemCacheIdentifierComment =
	'Cache compatibility identifier. Contents hash into Gondolin image fingerprints. Change imageCacheFormat when the image cache contract changes.';

const legacySystemCacheIdentifierSchema = z.object({}).passthrough();
const systemCacheIdentifierV1Schema = z
	.object({
		$comment: z.string(),
		schemaVersion: z.literal(1),
		hostSystemType: z.enum(['bare-metal', 'container']),
		imageCacheFormat: z.string().min(1),
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

export function buildDefaultSystemCacheIdentifier(
	dependencies: SystemCacheIdentifierPlatformDependencies = {},
): DefaultSystemCacheIdentifier {
	return {
		$comment: systemCacheIdentifierComment,
		schemaVersion: 1,
		hostSystemType: dependencies.hostSystemType ?? 'bare-metal',
		imageCacheFormat: dependencies.imageCacheFormat ?? 'gondolin-image-cache-v1',
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

	if (!('schemaVersion' in legacyResult.data)) {
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
