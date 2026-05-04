import { resolveGondolinMinimumZigVersion } from '@agent-vm/gondolin-adapter';
import { execa } from 'execa';

export type GondolinZigCompatibilityResult =
	| {
			readonly compatible: true;
			readonly hint: string;
			readonly installedVersion: string;
			readonly kind: 'compatible';
			readonly requiredVersion: string;
	  }
	| {
			readonly compatible: false;
			readonly hint: string;
			readonly kind: 'missing';
			readonly requiredVersion: string;
	  }
	| {
			readonly compatible: false;
			readonly hint: string;
			readonly installedVersion: string;
			readonly kind: 'incompatible';
			readonly requiredVersion: string;
	  };

export async function resolveGondolinCompatibleZigVersion(
	resolveRequiredVersion: () => Promise<string> = resolveGondolinMinimumZigVersion,
): Promise<string> {
	return await resolveRequiredVersion();
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isMissingExecutableError(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		error.code === 'ENOENT'
	);
}

export async function resolveHostZigVersion(): Promise<string | undefined> {
	try {
		const result = await execa('zig', ['version']);
		return result.stdout.trim();
	} catch (error) {
		if (isMissingExecutableError(error)) {
			return undefined;
		}
		throw new Error(`Failed to run zig version: ${errorMessage(error)}`, { cause: error });
	}
}

function parseZigVersionParts(version: string): readonly [number, number, number] | null {
	const versionMatch = /^(\d+)\.(\d+)\.(\d+)/u.exec(version.trim());
	if (!versionMatch) {
		return null;
	}
	const [majorVersion, minorVersion, patchVersion] = versionMatch.slice(1).map((part) =>
		Number.parseInt(part, 10),
	);
	if (
		majorVersion === undefined ||
		minorVersion === undefined ||
		patchVersion === undefined
	) {
		return null;
	}
	return [majorVersion, minorVersion, patchVersion];
}

export function isZigVersionAtLeast(version: string, minimumVersion: string): boolean {
	const versionParts = parseZigVersionParts(version);
	const minimumVersionParts = parseZigVersionParts(minimumVersion);
	if (!versionParts || !minimumVersionParts) {
		return false;
	}

	const [versionMajor, versionMinor, versionPatch] = versionParts;
	const [minimumMajor, minimumMinor, minimumPatch] = minimumVersionParts;
	if (versionMajor !== minimumMajor) {
		return versionMajor > minimumMajor;
	}
	if (versionMinor !== minimumMinor) {
		return versionMinor > minimumMinor;
	}
	return versionPatch >= minimumPatch;
}

export function buildZigInstallHint(requiredZigVersion: string | undefined): string {
	return requiredZigVersion
		? `Install Zig >= ${requiredZigVersion}. On macOS: brew install zig.`
		: 'Install Zig required by Gondolin. On macOS: brew install zig.';
}

export function buildZigUpgradeHint(requiredZigVersion: string): string {
	return `Requires Zig >= ${requiredZigVersion}. On macOS: brew install zig.`;
}

export function checkGondolinZigCompatibility(options: {
	readonly installedVersion?: string;
	readonly requiredVersion: string;
}): GondolinZigCompatibilityResult {
	if (!options.installedVersion) {
		return {
			compatible: false,
			kind: 'missing',
			requiredVersion: options.requiredVersion,
			hint: buildZigInstallHint(options.requiredVersion),
		};
	}
	if (isZigVersionAtLeast(options.installedVersion, options.requiredVersion)) {
		return {
			compatible: true,
			kind: 'compatible',
			requiredVersion: options.requiredVersion,
			installedVersion: options.installedVersion,
			hint: `found ${options.installedVersion}, required >= ${options.requiredVersion}`,
		};
	}
	return {
		compatible: false,
		kind: 'incompatible',
		requiredVersion: options.requiredVersion,
		installedVersion: options.installedVersion,
		hint: buildZigUpgradeHint(options.requiredVersion),
	};
}

export function assertGondolinZigCompatibility(options: {
	readonly installedVersion?: string;
	readonly requiredVersion: string;
}): void {
	const result = checkGondolinZigCompatibility(options);
	if (result.compatible) {
		return;
	}
	if (result.kind === 'incompatible') {
		throw new Error(`${result.hint} Current version: ${result.installedVersion}.`);
	}
	throw new Error(result.hint);
}
