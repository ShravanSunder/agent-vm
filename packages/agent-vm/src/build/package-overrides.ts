import { z } from 'zod';

export type ManagedImageBase = 'tool-vm' | 'worker-gateway';

export type PackageOverrideBucket = 'npm';
export type PackageOverrideOwner = 'managed-images.json' | 'overlay.jsonc';
export type PackageOverrideSource = `${PackageOverrideOwner}/packageOverrides.${PackageOverrideBucket}`;

export interface PackageOverrides {
	readonly npm: readonly string[];
}

export interface ParsedPackageSpec {
	readonly name: string;
	readonly spec: string;
	readonly version: string;
}

export interface ResolvedPackageOverrideSpec extends ParsedPackageSpec {
	readonly bucket: 'npm';
	readonly source: PackageOverrideSource;
}

export interface EffectivePackageOverrides {
	readonly npm: readonly ResolvedPackageOverrideSpec[];
}

export const exactPackageVersionPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;

const plainPackageNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u;
const protocolPattern = /^(?:npm|git|file|link|workspace|http|https):/u;

export const packageOverridesSchema: z.ZodType<PackageOverrides> = z
	.object({
		npm: z.array(z.string().min(1)).default([]),
	})
	.strict()
	.default({
		npm: [],
	});

export function emptyPackageOverrides(): PackageOverrides {
	return {
		npm: [],
	};
}

export function hasPackageOverrideEntries(packageOverrides: PackageOverrides): boolean {
	return packageOverrides.npm.length > 0;
}

export function legacyPackageOverrideMessage(legacyKey: string, targetKey: string): string {
	return `move ${legacyKey} to ${targetKey}`;
}

export function assertNoLegacyPackageOverrideKeys(rawValue: unknown, ownerPath: string): void {
	if (typeof rawValue !== 'object' || rawValue === null || Array.isArray(rawValue)) {
		return;
	}
	const objectValue = rawValue as Record<string, unknown>;
	if (Object.hasOwn(objectValue, 'pnpmOverrides')) {
		throw new Error(
			`Invalid managed image overlay at ${ownerPath}: packageOverrides accepts only exact npm package pins.`,
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

export function parseNpmPackageOverride(packageSpec: string): ParsedPackageSpec {
	const parsedPackageSpec = parsePackageSpec(packageSpec);
	if (parsedPackageSpec.name.startsWith('@agent-vm/')) {
		throw new Error(
			`packageOverrides.npm cannot install @agent-vm/* packages such as ${parsedPackageSpec.name}. Update the agent-vm release instead.`,
		);
	}
	assertExactVersion(parsedPackageSpec.name, parsedPackageSpec.version, packageSpec);
	return parsedPackageSpec;
}

export function assertPackageOverridesSupported(props: {
	readonly base: ManagedImageBase;
	readonly packageOverrides: PackageOverrides;
	readonly source: PackageOverrideOwner;
}): void {
	void props;
}

function resolveSpecEntries(props: {
	readonly bucket: 'npm';
	readonly packageSpecs: readonly string[];
	readonly source: PackageOverrideOwner;
}): readonly ResolvedPackageOverrideSpec[] {
	return props.packageSpecs.map((packageSpec) => {
		const parsedPackageSpec = parseNpmPackageOverride(packageSpec);
		return {
			...parsedPackageSpec,
			bucket: props.bucket,
			source: `${props.source}/packageOverrides.${props.bucket}`,
		};
	});
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
	};
}

export function packageOverridesToSpecs(
	packageOverrides: PackageOverrides,
): readonly string[] {
	return packageOverrides.npm;
}
