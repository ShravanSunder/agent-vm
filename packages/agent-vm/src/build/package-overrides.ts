import { z } from 'zod';

export type ManagedImageBase = 'openclaw-gateway' | 'tool-vm' | 'worker-gateway';

export type PackageOverrideBucket = 'npm' | 'openclaw' | 'pnpm';
export type PackageOverrideOwner = 'managed-images.json' | 'overlay.jsonc';
export type PackageOverrideSource = `${PackageOverrideOwner}/packageOverrides.${PackageOverrideBucket}`;

export interface PackageOverrides {
	readonly npm: readonly string[];
	readonly openclaw: readonly string[];
	readonly pnpm: Readonly<Record<string, string>>;
}

export interface ParsedPackageSpec {
	readonly name: string;
	readonly spec: string;
	readonly version: string;
}

export interface ResolvedPackageOverrideSpec extends ParsedPackageSpec {
	readonly bucket: 'npm' | 'openclaw';
	readonly source: PackageOverrideSource;
}

export interface ResolvedPackageOverrideVersion {
	readonly bucket: 'pnpm';
	readonly name: string;
	readonly source: PackageOverrideSource;
	readonly version: string;
}

export interface EffectivePackageOverrides {
	readonly npm: readonly ResolvedPackageOverrideSpec[];
	readonly openclaw: readonly ResolvedPackageOverrideSpec[];
	readonly pnpm: readonly ResolvedPackageOverrideVersion[];
}

export const exactPackageVersionPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;

const plainPackageNamePattern = /^[a-z0-9][a-z0-9._-]*$/u;
const protocolPattern = /^(?:npm|git|file|link|workspace|http|https):/u;

export const packageOverridesSchema: z.ZodType<PackageOverrides> = z
	.object({
		npm: z.array(z.string().min(1)).default([]),
		openclaw: z.array(z.string().min(1)).default([]),
		pnpm: z.record(z.string().min(1), z.string().min(1)).default({}),
	})
	.strict()
	.default({
		npm: [],
		openclaw: [],
		pnpm: {},
	});

export function emptyPackageOverrides(): PackageOverrides {
	return {
		npm: [],
		openclaw: [],
		pnpm: {},
	};
}

export function hasPackageOverrideEntries(packageOverrides: PackageOverrides): boolean {
	return (
		packageOverrides.npm.length > 0 ||
		packageOverrides.openclaw.length > 0 ||
		Object.keys(packageOverrides.pnpm).length > 0
	);
}

export function legacyPackageOverrideMessage(legacyKey: string, targetKey: string): string {
	return `move ${legacyKey} to ${targetKey}`;
}

export function assertNoLegacyPackageOverrideKeys(rawValue: unknown, ownerPath: string): void {
	if (typeof rawValue !== 'object' || rawValue === null || Array.isArray(rawValue)) {
		return;
	}
	const objectValue = rawValue as Record<string, unknown>;
	if (Object.hasOwn(objectValue, 'extraOpenClawPackages')) {
		throw new Error(
			`Invalid managed image overlay at ${ownerPath}: ${legacyPackageOverrideMessage('extraOpenClawPackages', 'packageOverrides.openclaw')}.`,
		);
	}
	if (Object.hasOwn(objectValue, 'openClawPackageOverrides')) {
		throw new Error(
			`Invalid managed image overlay at ${ownerPath}: ${legacyPackageOverrideMessage('openClawPackageOverrides', 'packageOverrides.openclaw')}.`,
		);
	}
	if (Object.hasOwn(objectValue, 'pnpmOverrides')) {
		throw new Error(
			`Invalid managed image overlay at ${ownerPath}: ${legacyPackageOverrideMessage('pnpmOverrides', 'packageOverrides.pnpm')}.`,
		);
	}
}

function parsePackageSpec(packageSpec: string): ParsedPackageSpec {
	if (protocolPattern.test(packageSpec)) {
		throw new Error(`Package override specs must be exact package pins, not protocol specs: ${packageSpec}.`);
	}
	let parsedPackageSpec: ParsedPackageSpec;
	if (packageSpec.startsWith('@')) {
		const scopeSeparatorIndex = packageSpec.indexOf('/');
		if (scopeSeparatorIndex === -1) {
			throw new Error(`Package override specs require package names and exact versions: ${packageSpec}.`);
		}
		const versionSeparatorIndex = packageSpec.indexOf('@', scopeSeparatorIndex + 1);
		if (versionSeparatorIndex === -1) {
			throw new Error(`Package override specs require exact package versions: ${packageSpec}.`);
		}
		parsedPackageSpec = {
			name: packageSpec.slice(0, versionSeparatorIndex),
			spec: packageSpec,
			version: packageSpec.slice(versionSeparatorIndex + 1),
		};
		assertValidPackageName(parsedPackageSpec.name, packageSpec);
		return parsedPackageSpec;
	}
	const versionSeparatorIndex = packageSpec.indexOf('@');
	if (versionSeparatorIndex === -1) {
		throw new Error(`Package override specs require exact package versions: ${packageSpec}.`);
	}
	parsedPackageSpec = {
		name: packageSpec.slice(0, versionSeparatorIndex),
		spec: packageSpec,
		version: packageSpec.slice(versionSeparatorIndex + 1),
	};
	assertValidPackageName(parsedPackageSpec.name, packageSpec);
	return parsedPackageSpec;
}

function assertValidPackageName(packageName: string, packageSpec: string): void {
	if (packageName.startsWith('@')) {
		const [scope, name, extra] = packageName.split('/');
		const scopeName = scope?.slice(1) ?? '';
		if (
			extra !== undefined ||
			!scope ||
			!name ||
			!plainPackageNamePattern.test(scopeName) ||
			!plainPackageNamePattern.test(name)
		) {
			throw new Error(`Package override specs require valid npm package names: ${packageSpec}.`);
		}
		return;
	}
	if (!plainPackageNamePattern.test(packageName)) {
		throw new Error(`Package override specs require valid npm package names: ${packageSpec}.`);
	}
}

function assertExactVersion(packageName: string, version: string, packageSpec: string): void {
	if (!exactPackageVersionPattern.test(version) || protocolPattern.test(version)) {
		throw new Error(
			`Package override specs require exact package versions. Use ${packageName}@<version>, not ${packageSpec}.`,
		);
	}
}

function isOpenClawRuntimePackageName(packageName: string): boolean {
	return packageName === 'openclaw' || packageName.startsWith('@openclaw/');
}

export function parseOpenClawPackageOverride(packageSpec: string): ParsedPackageSpec {
	const parsedPackageSpec = parsePackageSpec(packageSpec);
	if (!isOpenClawRuntimePackageName(parsedPackageSpec.name)) {
		throw new Error(
			`packageOverrides.openclaw only accepts OpenClaw runtime package pins. Use openclaw@<version> or @openclaw/<name>@<version>, not ${packageSpec}.`,
		);
	}
	assertExactVersion(parsedPackageSpec.name, parsedPackageSpec.version, packageSpec);
	return parsedPackageSpec;
}

export function parseNpmPackageOverride(packageSpec: string): ParsedPackageSpec {
	const parsedPackageSpec = parsePackageSpec(packageSpec);
	if (parsedPackageSpec.name.startsWith('@agent-vm/')) {
		throw new Error(
			`packageOverrides.npm cannot install @agent-vm/* packages such as ${parsedPackageSpec.name}. Update the agent-vm release instead.`,
		);
	}
	if (isOpenClawRuntimePackageName(parsedPackageSpec.name)) {
		throw new Error(
			`packageOverrides.npm does not accept OpenClaw runtime packages. Move ${packageSpec} to packageOverrides.openclaw.`,
		);
	}
	assertExactVersion(parsedPackageSpec.name, parsedPackageSpec.version, packageSpec);
	return parsedPackageSpec;
}

function parsePnpmPackageOverride(packageName: string, version: string): ResolvedPackageOverrideVersion {
	if (!plainPackageNamePattern.test(packageName) || protocolPattern.test(packageName)) {
		throw new Error(
			`packageOverrides.pnpm only accepts plain package names, not selectors or protocols: ${packageName}.`,
		);
	}
	assertExactVersion(packageName, version, `${packageName}@${version}`);
	return {
		bucket: 'pnpm',
		name: packageName,
		source: 'managed-images.json/packageOverrides.pnpm',
		version,
	};
}

export function assertPackageOverridesSupported(props: {
	readonly base: ManagedImageBase;
	readonly packageOverrides: PackageOverrides;
	readonly source: PackageOverrideOwner;
}): void {
	if (props.base === 'openclaw-gateway') {
		return;
	}
	if (props.packageOverrides.openclaw.length > 0) {
		throw new Error(`${props.source} packageOverrides.openclaw is only supported for openclaw-gateway.`);
	}
	if (Object.keys(props.packageOverrides.pnpm).length > 0) {
		throw new Error(`${props.source} packageOverrides.pnpm is only supported for openclaw-gateway.`);
	}
}

function resolveSpecEntries(props: {
	readonly bucket: 'npm' | 'openclaw';
	readonly packageSpecs: readonly string[];
	readonly source: PackageOverrideOwner;
}): readonly ResolvedPackageOverrideSpec[] {
	return props.packageSpecs.map((packageSpec) => {
		const parsedPackageSpec =
			props.bucket === 'openclaw'
				? parseOpenClawPackageOverride(packageSpec)
				: parseNpmPackageOverride(packageSpec);
		return {
			...parsedPackageSpec,
			bucket: props.bucket,
			source: `${props.source}/packageOverrides.${props.bucket}`,
		};
	});
}

function resolvePnpmEntries(props: {
	readonly pnpm: Readonly<Record<string, string>>;
	readonly source: PackageOverrideOwner;
}): readonly ResolvedPackageOverrideVersion[] {
	return Object.entries(props.pnpm).map(([packageName, version]) => ({
		...parsePnpmPackageOverride(packageName, version),
		source: `${props.source}/packageOverrides.pnpm`,
	}));
}

function mergeByName<TEntry extends { readonly name: string }>(
	managedEntries: readonly TEntry[],
	overlayEntries: readonly TEntry[],
): readonly TEntry[] {
	const entriesByName = new Map<string, TEntry>();
	for (const entry of managedEntries) {
		entriesByName.set(entry.name, entry);
	}
	for (const entry of overlayEntries) {
		entriesByName.set(entry.name, entry);
	}
	return [...entriesByName.values()];
}

export function resolveEffectivePackageOverrides(props: {
	readonly base: ManagedImageBase;
	readonly managed: PackageOverrides;
	readonly overlay: PackageOverrides;
}): EffectivePackageOverrides {
	assertPackageOverridesSupported({
		base: props.base,
		packageOverrides: props.managed,
		source: 'managed-images.json',
	});
	assertPackageOverridesSupported({
		base: props.base,
		packageOverrides: props.overlay,
		source: 'overlay.jsonc',
	});

	return {
		npm: mergeByName(
			resolveSpecEntries({
				bucket: 'npm',
				packageSpecs: props.managed.npm,
				source: 'managed-images.json',
			}),
			resolveSpecEntries({
				bucket: 'npm',
				packageSpecs: props.overlay.npm,
				source: 'overlay.jsonc',
			}),
		),
		openclaw: mergeByName(
			resolveSpecEntries({
				bucket: 'openclaw',
				packageSpecs: props.managed.openclaw,
				source: 'managed-images.json',
			}),
			resolveSpecEntries({
				bucket: 'openclaw',
				packageSpecs: props.overlay.openclaw,
				source: 'overlay.jsonc',
			}),
		),
		pnpm: mergeByName(
			resolvePnpmEntries({
				pnpm: props.managed.pnpm,
				source: 'managed-images.json',
			}),
			resolvePnpmEntries({
				pnpm: props.overlay.pnpm,
				source: 'overlay.jsonc',
			}),
		),
	};
}

export function packageOverridesToSpecs(
	packageOverrides: PackageOverrides,
): readonly string[] {
	return [
		...packageOverrides.openclaw,
		...packageOverrides.npm,
		...Object.entries(packageOverrides.pnpm).map(
			([packageName, version]) => `${packageName}@${version}`,
		),
	];
}
