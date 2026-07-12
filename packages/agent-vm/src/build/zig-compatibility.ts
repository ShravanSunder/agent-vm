import { execa } from 'execa';

import { resolveManagedVmMinimumZigVersion } from './gondolin-managed-vm-build-tooling.js';

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
	resolveRequiredVersion: () => Promise<string> = resolveManagedVmMinimumZigVersion,
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

interface ParsedZigVersion {
	readonly major: number;
	readonly minor: number;
	readonly patch: number;
	readonly prerelease: readonly string[];
}

function parseZigVersion(version: string): ParsedZigVersion | null {
	const versionMatch = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u.exec(version.trim());
	if (!versionMatch) {
		return null;
	}
	const [majorVersion, minorVersion, patchVersion] = versionMatch.slice(1, 4).map((part) =>
		Number.parseInt(part, 10),
	);
	if (
		majorVersion === undefined ||
		minorVersion === undefined ||
		patchVersion === undefined
	) {
		return null;
	}
	const prereleaseText = versionMatch[4];
	return {
		major: majorVersion,
		minor: minorVersion,
		patch: patchVersion,
		prerelease: prereleaseText ? prereleaseText.split('.') : [],
	};
}

function compareNumbers(left: number, right: number): number {
	return left === right ? 0 : left > right ? 1 : -1;
}

function isNumericIdentifier(identifier: string): boolean {
	return /^\d+$/u.test(identifier);
}

function comparePrereleaseIdentifiers(left: string, right: string): number {
	const leftIsNumeric = isNumericIdentifier(left);
	const rightIsNumeric = isNumericIdentifier(right);
	if (leftIsNumeric && rightIsNumeric) {
		return compareNumbers(Number.parseInt(left, 10), Number.parseInt(right, 10));
	}
	if (leftIsNumeric !== rightIsNumeric) {
		return leftIsNumeric ? -1 : 1;
	}
	return left.localeCompare(right);
}

function compareZigVersions(left: ParsedZigVersion, right: ParsedZigVersion): number {
	for (const key of ['major', 'minor', 'patch'] as const) {
		const result = compareNumbers(left[key], right[key]);
		if (result !== 0) {
			return result;
		}
	}
	if (left.prerelease.length === 0 && right.prerelease.length === 0) {
		return 0;
	}
	if (left.prerelease.length === 0) {
		return 1;
	}
	if (right.prerelease.length === 0) {
		return -1;
	}
	const identifierCount = Math.max(left.prerelease.length, right.prerelease.length);
	for (let index = 0; index < identifierCount; index += 1) {
		const leftIdentifier = left.prerelease[index];
		const rightIdentifier = right.prerelease[index];
		if (leftIdentifier === undefined) {
			return -1;
		}
		if (rightIdentifier === undefined) {
			return 1;
		}
		const result = comparePrereleaseIdentifiers(leftIdentifier, rightIdentifier);
		if (result !== 0) {
			return result;
		}
	}
	return 0;
}

export function isZigVersionAtLeast(version: string, minimumVersion: string): boolean {
	const parsedVersion = parseZigVersion(version);
	const parsedMinimumVersion = parseZigVersion(minimumVersion);
	if (!parsedVersion || !parsedMinimumVersion) {
		return false;
	}
	return compareZigVersions(parsedVersion, parsedMinimumVersion) >= 0;
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
