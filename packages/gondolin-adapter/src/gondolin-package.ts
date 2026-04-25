import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { z } from 'zod';

const requireFromHere = createRequire(import.meta.url);

const gondolinPackageJsonSchema = z.object({
	version: z.string().min(1),
});

function isMissingFileError(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function parseMinimumZigVersion(rawContents: string): string {
	const match = rawContents.match(/\.minimum_zig_version\s*=\s*"([^"]*)"/u);
	if (!match) {
		throw new Error(
			'minimum_zig_version declaration not found. Expected a line like `.minimum_zig_version = "0.15.2"`.',
		);
	}

	const version = match[1];
	if (!version) {
		throw new Error('minimum_zig_version is empty.');
	}
	return version;
}

export function resolveGondolinPackageJsonPath(): string {
	return requireFromHere.resolve('@earendil-works/gondolin/package.json');
}

export async function resolveGondolinPackageSpec(): Promise<string> {
	const packageJsonPath = resolveGondolinPackageJsonPath();
	const parsed: unknown = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
	const packageJson = gondolinPackageJsonSchema.parse(parsed);
	return `@earendil-works/gondolin@${packageJson.version}`;
}

export interface ResolveGondolinMinimumZigVersionOptions {
	readonly buildZigZonPath?: string;
}

async function resolveDefaultBuildZigZonPath(): Promise<string> {
	const packageJsonPath = resolveGondolinPackageJsonPath();
	return path.join(path.dirname(packageJsonPath), 'dist', 'guest', 'build.zig.zon');
}

export async function resolveGondolinMinimumZigVersion(
	options: ResolveGondolinMinimumZigVersionOptions = {},
): Promise<string> {
	const zonPath = options.buildZigZonPath ?? (await resolveDefaultBuildZigZonPath());
	let rawContents: string;
	try {
		rawContents = await fs.readFile(zonPath, 'utf8');
	} catch (error) {
		if (isMissingFileError(error)) {
			throw new Error(`Missing Gondolin build.zig.zon at '${zonPath}'.`, { cause: error });
		}
		throw new Error(
			`Failed to read Gondolin build.zig.zon at '${zonPath}': ${getErrorMessage(error)}`,
			{ cause: error },
		);
	}

	try {
		return parseMinimumZigVersion(rawContents);
	} catch (error) {
		throw new Error(
			`Failed to parse Gondolin build.zig.zon at '${zonPath}': ${getErrorMessage(error)}`,
			{ cause: error },
		);
	}
}
