import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { loadJsonConfigFile } from '../config/json-config-file.js';
import { formatZodError } from '../cli/format-zod-error.js';
import {
	assertNoLegacyPackageOverrideKeys,
	type EffectivePackageOverrides,
	emptyPackageOverrides,
	type ManagedImageBase,
	type PackageOverrideSource,
	type PackageOverrides,
	packageOverridesSchema,
	resolveEffectivePackageOverrides,
	type ResolvedPackageOverrideVersion,
} from './package-overrides.js';

const managedOpenClawAgentVmPluginPackageName = '@agent-vm/openclaw-agent-vm-plugin';
const managedGatewayRuntimePackageName = '@agent-vm/gateway-runtime';
const managedMcpPortalPackageName = '@agent-vm/mcp-portal';
const managedOpenAiCodexCliPackageName = '@openai/codex';
const managedCoreOpenClawPackageNames = ['openclaw', '@openclaw/codex'] as const;
const managedOpenClawPackageNames = new Set([
	managedOpenClawAgentVmPluginPackageName,
	managedGatewayRuntimePackageName,
	managedMcpPortalPackageName,
]);
const managedOpenClawAgentVmPluginExtensionPath = '/home/openclaw/.openclaw/extensions/gondolin';
const managedPnpmHomePath = '/pnpm';
const managedPnpmGlobalDirectory = '/pnpm/global';
const requiredManagedRuntimeDependencyPatchesByOpenClawVersion = new Map<
	string,
	readonly { readonly packageName: string; readonly version: string }[]
>(
	[
			[
				'2026.6.5',
				[
					{
						packageName: 'undici',
						version: '8.5.0',
					},
				],
			],
			[
				'2026.6.8',
				[
					{
						packageName: 'undici',
						version: '8.5.0',
					},
				],
			],
		],
	);

export interface ManagedImageSource {
	readonly kind: 'managedBase';
	readonly base: ManagedImageBase;
	readonly overlay?: string | undefined;
}

export interface GenerateManagedDockerfileOptions {
	readonly base: ManagedImageBase;
	readonly imageTargetFamily: 'gateway' | 'toolVm';
	readonly imageTargetName: string;
	readonly openClawAgentVmPackageInstallMode?: 'managed-packages' | 'local-overlay' | undefined;
	readonly outputDirectory: string;
	readonly overlayPath?: string | undefined;
	readonly managedImageRelease: ManagedImageRelease;
	readonly requiredOpenClawPackageNames?: readonly string[];
}

export type ManagedDockerfilePlanSource =
	| 'installed-package'
	| 'local-overlay'
	| 'managed-default'
	| 'managed-images.json'
	| PackageOverrideSource;

export interface ManagedDockerfilePackagePlanEntry {
	readonly name: string;
	readonly source: ManagedDockerfilePlanSource;
	readonly spec: string;
	readonly version?: string;
}

export interface ManagedDockerfilePlanWarning {
	readonly message: string;
	readonly type: 'openclaw-package-version-mismatch';
}

export interface ManagedDockerfileDependencyOverridePlanEntry {
	readonly name: string;
	readonly source: ManagedDockerfilePlanSource;
	readonly version: string;
}

export interface ManagedDockerfilePlan {
	readonly base: ManagedImageBase;
	readonly baseImage: {
		readonly reference: string;
		readonly repository: string;
		readonly source: 'managed-images.json';
		readonly tag: string;
	};
	readonly dockerfilePath: string;
	readonly imageTargetFamily: 'gateway' | 'toolVm';
	readonly imageTargetName: string;
	readonly openClawAgentVmPluginPackage?: ManagedDockerfilePackagePlanEntry;
	readonly mcpPortalPackage?: ManagedDockerfilePackagePlanEntry;
	readonly directNpmPackages: readonly ManagedDockerfilePackagePlanEntry[];
	readonly gatewayRuntimePackage?: ManagedDockerfilePackagePlanEntry;
	readonly openClawDependencyOverrides: readonly ManagedDockerfileDependencyOverridePlanEntry[];
	readonly openClawPackages: readonly ManagedDockerfilePackagePlanEntry[];
	readonly warnings: readonly ManagedDockerfilePlanWarning[];
}

export interface GenerateManagedDockerfileResult {
	readonly dockerfilePath: string;
	readonly plan: ManagedDockerfilePlan;
}

export interface ManagedBaseImageReference {
	readonly packageOverrides: PackageOverrides;
	readonly repository: string;
	readonly tag: string;
}

export interface ManagedImageRelease {
	readonly baseImages: Readonly<Record<ManagedImageBase, ManagedBaseImageReference>>;
}

const overlayCopySchema = z
	.object({
		from: z.string().min(1),
		to: z.string().min(1),
	})
	.strict();

const managedImageOverlaySchema = z
	.object({
		schemaVersion: z.literal(1),
		extraAptPackages: z.array(z.string().min(1)).default([]),
		packageOverrides: packageOverridesSchema,
		copy: z.array(overlayCopySchema).default([]),
		runAfterBase: z.array(z.string().min(1)).default([]),
	})
	.strict();

const managedBaseImageReferenceSchema = z
	.object({
		packageOverrides: packageOverridesSchema,
		repository: z.string().min(1),
		tag: z.string().min(1),
	})
	.strict();

const managedImageReleaseSchema = z
	.object({
		schemaVersion: z.literal(1),
		baseImages: z
			.object({
				'openclaw-gateway': managedBaseImageReferenceSchema,
				'tool-vm': managedBaseImageReferenceSchema,
				'worker-gateway': managedBaseImageReferenceSchema,
			})
			.strict(),
	})
	.strict();

export type ManagedImageOverlay = z.infer<typeof managedImageOverlaySchema>;

export async function loadManagedImageOverlay(overlayPath: string | undefined): Promise<ManagedImageOverlay> {
	if (!overlayPath) {
		return {
			schemaVersion: 1,
			extraAptPackages: [],
			packageOverrides: emptyPackageOverrides(),
			copy: [],
			runAfterBase: [],
		};
	}
	const rawOverlay = await loadJsonConfigFile(overlayPath);
	assertNoLegacyPackageOverrideKeys(rawOverlay, overlayPath);
	const parsedOverlay = managedImageOverlaySchema.safeParse(rawOverlay);
	if (!parsedOverlay.success) {
		throw new Error(
			formatZodError(`Invalid managed image overlay at ${overlayPath}:`, parsedOverlay.error),
		);
	}
	return parsedOverlay.data;
}

export async function validateManagedImageOverlay(overlayPath: string): Promise<void> {
	await loadManagedImageOverlay(overlayPath);
}

function shellJoin(argumentsToQuote: readonly string[]): string {
	return argumentsToQuote.map((argument) => JSON.stringify(argument)).join(' ');
}

function packageSpec(packageName: string, version: string): string {
	return `${packageName}@${version}`;
}

function filterPnpmOverridesForPackages(
	openClawPackages: readonly ManagedDockerfilePackagePlanEntry[],
	pnpmOverrides: readonly ResolvedPackageOverrideVersion[],
): readonly ResolvedPackageOverrideVersion[] {
	const coreOpenClawPackage = openClawPackages.find((packageEntry) => packageEntry.name === 'openclaw');
	if (!coreOpenClawPackage?.version) {
		return [];
	}
	const requiredPatches = requiredManagedRuntimeDependencyPatchesByOpenClawVersion.get(
		coreOpenClawPackage.version,
	);
	if (requiredPatches === undefined) {
		return pnpmOverrides;
	}
	for (const requiredPatch of requiredPatches) {
		const matchingOverride = pnpmOverrides.find((overrideEntry) => overrideEntry.name === requiredPatch.packageName);
		if (
			matchingOverride === undefined ||
			compareStableExactSemver(matchingOverride.version, requiredPatch.version) < 0
		) {
			throw new Error(
				`OpenClaw ${coreOpenClawPackage.version} requires stable ${requiredPatch.packageName}@${requiredPatch.version} or newer in packageOverrides.pnpm.`,
			);
		}
	}
	return pnpmOverrides.toSorted((left, right) => left.name.localeCompare(right.name));
}

function compareStableExactSemver(left: string, right: string): number {
	const stableExactVersionPattern = /^\d+\.\d+\.\d+$/u;
	if (!stableExactVersionPattern.test(left) || !stableExactVersionPattern.test(right)) {
		return -1;
	}
	const leftParts = left.split('.').map((part) => Number.parseInt(part, 10));
	const rightParts = right.split('.').map((part) => Number.parseInt(part, 10));
	for (let index = 0; index < 3; index += 1) {
		const leftPart = leftParts[index] ?? 0;
		const rightPart = rightParts[index] ?? 0;
		if (leftPart !== rightPart) {
			return leftPart - rightPart;
		}
	}
	return 0;
}

function shellSingleQuote(value: string): string {
	return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function formatJsonObjectForDockerfile(value: unknown): string {
	return JSON.stringify(value, null, 2)
		.split('\n')
		.map((line) => shellSingleQuote(line))
		.join(' \\\n    ');
}

function openClawPackageDependencyMap(
	openClawPackages: readonly ManagedDockerfilePackagePlanEntry[],
	pnpmOverrides: readonly ResolvedPackageOverrideVersion[],
): Record<string, string> {
	const dependencies: Record<string, string> = {};
	for (const packageEntry of openClawPackages) {
		if (!packageEntry.version) {
			throw new Error(`OpenClaw package ${packageEntry.name} must have an exact version.`);
		}
		dependencies[packageEntry.name] = packageEntry.version;
	}
	for (const overrideEntry of pnpmOverrides) {
		dependencies[overrideEntry.name] = overrideEntry.version;
	}
	return dependencies;
}

function renderOpenClawPackageSymlinkCommand(packageName: string): string {
	const packagePathSegments = packageName.split('/');
	const packageParentPath =
		packagePathSegments.length === 1 ? '' : '/' + packagePathSegments.slice(0, -1).join('/');
	const mkdirCommand =
		packageParentPath.length === 0
			? undefined
			: `mkdir -p "$global_package_root${packageParentPath}"`;
	const linkCommand = `ln -sfn /opt/openclaw-runtime-packages/node_modules/${packageName} "$global_package_root/${packageName}"`;
	return [mkdirCommand, linkCommand].filter((command): command is string => command !== undefined).join(' && ');
}

function packageDirectoryName(packageName: string): string {
	const packagePathSegments = packageName.split('/');
	return packagePathSegments[packagePathSegments.length - 1] ?? packageName;
}

function renderBundledDependencyRelinkCommand(props: {
	readonly openClawPackages: readonly ManagedDockerfilePackagePlanEntry[];
	readonly overridePackageName: string;
}): string {
	const packageRoots = props.openClawPackages.map(
		(packageEntry) => `/opt/openclaw-runtime-packages/node_modules/${packageEntry.name}`,
	);
	const dependencyDirectoryName = packageDirectoryName(props.overridePackageName);
	return [
		`RUN override_package_root="/opt/openclaw-runtime-packages/node_modules/${props.overridePackageName}" && \\`,
		'    test -d "$override_package_root" && \\',
		...packageRoots.flatMap((packageRoot, index) => [
			`    package_root=${shellSingleQuote(packageRoot)} && \\`,
			`    bundled_dependency_path="$package_root/node_modules/${dependencyDirectoryName}" && \\`,
			'    mkdir -p "$(dirname "$bundled_dependency_path")" && \\',
			'    if [ -e "$bundled_dependency_path" ] || [ -L "$bundled_dependency_path" ]; then mv "$bundled_dependency_path" "$bundled_dependency_path.agent-vm-bundled"; fi && \\',
			'    ln -sfn "$override_package_root" "$bundled_dependency_path"' +
				(index === packageRoots.length - 1 ? '' : ' && \\'),
		]),
	].join('\n');
}

function renderOpenClawPackageInstallLines(
	openClawPackages: readonly ManagedDockerfilePackagePlanEntry[],
	pnpmOverrides: readonly ResolvedPackageOverrideVersion[],
): readonly string[] {
	if (openClawPackages.length === 0) {
		return [];
	}
	if (pnpmOverrides.length === 0) {
		return ['RUN pnpm add -g --ignore-scripts ' + shellJoin(openClawPackages.map((entry) => entry.spec))];
	}
	const pnpmOverrideMap = Object.fromEntries(
		pnpmOverrides.map((overrideEntry) => [overrideEntry.name, overrideEntry.version]),
	);
	const packageJson = {
		private: true,
		dependencies: openClawPackageDependencyMap(openClawPackages, pnpmOverrides),
		pnpm: {
			overrides: pnpmOverrideMap,
		},
	};
	return [
		'WORKDIR /opt/openclaw-runtime-packages',
		`RUN printf '%s\\n' ${formatJsonObjectForDockerfile(packageJson)} > package.json`,
		'RUN pnpm install --prod --ignore-scripts',
		...pnpmOverrides.map((overrideEntry) =>
			renderBundledDependencyRelinkCommand({
				openClawPackages,
				overridePackageName: overrideEntry.name,
			}),
		),
		[
			'RUN global_package_root="$(pnpm root -g)" && \\',
			'    mkdir -p "$global_package_root" && \\',
			...openClawPackages.map(
				(packageEntry, index) =>
					`    ${renderOpenClawPackageSymlinkCommand(packageEntry.name)}${
						index === openClawPackages.length - 1 ? '' : ' && \\'
					}`,
			),
		].join('\n'),
	];
}

function renderGitHubCliStableAptInstallCommand(): string {
	const githubCliKeyringPath = '/usr/share/keyrings/githubcli-archive-keyring.gpg';
	return [
		'RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg && \\',
		`    chmod go+r ${githubCliKeyringPath} && \\`,
		`    echo "deb [arch=$(dpkg --print-architecture) signed-by=${githubCliKeyringPath}] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list && \\`,
		'    apt-get update && \\',
		'    apt-get install -y --no-install-recommends gh && \\',
		'    rm -rf /var/lib/apt/lists/*',
	].join('\n');
}

function renderManagedDockerfile(props: {
	readonly base: ManagedImageBase;
	readonly baseImage: ManagedBaseImageReference;
	readonly overlay: ManagedImageOverlay;
	readonly directNpmPackages: readonly ManagedDockerfilePackagePlanEntry[];
	readonly gatewayRuntimePackageSpec?: string;
	readonly mcpPortalPackageSpec?: string;
	readonly openClawAgentVmPackageInstallMode?: 'managed-packages' | 'local-overlay' | undefined;
	readonly openClawAgentVmPluginPackageSpec?: string;
	readonly openClawPackages: readonly ManagedDockerfilePackagePlanEntry[];
	readonly pnpmOverrides: readonly ResolvedPackageOverrideVersion[];
}): string {
	const lines = [
		`FROM ${props.baseImage.repository}:${props.baseImage.tag}${
			props.base === 'openclaw-gateway' ? ' AS openclaw-runtime' : ''
		}`,
		'',
		'# Generated by agent-vm from a managed image profile. Do not edit by hand.',
	];
	if (props.overlay.extraAptPackages.length > 0) {
		lines.push(
			'RUN apt-get update && apt-get install -y --no-install-recommends ' +
				shellJoin(props.overlay.extraAptPackages) +
				' && rm -rf /var/lib/apt/lists/*',
		);
	}
	if (props.base === 'tool-vm') {
		lines.push('RUN rm -rf /scratch && install -d -m 0755 /work /workspace');
		lines.push(renderGitHubCliStableAptInstallCommand());
	}
	if (
		props.base === 'openclaw-gateway' ||
		props.base === 'tool-vm' ||
		props.openClawPackages.length > 0 ||
		props.directNpmPackages.length > 0
	) {
		lines.push(`ENV PNPM_HOME=${managedPnpmHomePath}`);
		lines.push('ENV PATH=${PNPM_HOME}:${PATH}');
		lines.push(
			`RUN pnpm config set global-dir ${managedPnpmGlobalDirectory} && pnpm config set global-bin-dir ${managedPnpmHomePath}`,
		);
	}
	if (props.base === 'tool-vm') {
		if (props.mcpPortalPackageSpec) {
			lines.push('RUN pnpm add -g ' + shellJoin([props.mcpPortalPackageSpec]));
		}
	}
	if (props.base !== 'openclaw-gateway' && props.directNpmPackages.length > 0) {
		lines.push(
			'RUN pnpm add -g --ignore-scripts ' +
				shellJoin(props.directNpmPackages.map((packageEntry) => packageEntry.spec)),
		);
	}
	if (props.openClawPackages.length > 0) {
		lines.push(
			...renderOpenClawPackageInstallLines(
				props.openClawPackages,
				props.pnpmOverrides,
			),
		);
	}
	if (props.base === 'openclaw-gateway') {
		lines.push(
			[
				'RUN openclaw_package_root="$(pnpm root -g)/openclaw" && \\',
				'    (cd "$openclaw_package_root" && node scripts/postinstall-bundled-plugins.mjs) && \\',
				"    printf '%s\\n' \\",
				"      '{' \\",
				"      '  \"gateway\": { \"mode\": \"local\", \"auth\": { \"mode\": \"token\" } },' \\",
				"      '  \"plugins\": {' \\",
				"      '    \"allow\": [\"memory-core\"],' \\",
				"      '    \"slots\": { \"memory\": \"memory-core\" },' \\",
				"      '    \"entries\": {' \\",
				"      '      \"memory-core\": { \"enabled\": true }' \\",
				"      '    }' \\",
				"      '  }' \\",
				"      '}' > /tmp/openclaw-plugin-stage-config.json && \\",
				'    chmod 600 /tmp/openclaw-plugin-stage-config.json && \\',
				'    (OPENCLAW_CONFIG_PATH=/tmp/openclaw-plugin-stage-config.json openclaw doctor --fix --non-interactive || true) && \\',
				'    rm -f /tmp/openclaw-plugin-stage-config.json /tmp/openclaw-plugin-stage-config.json.bak',
			].join('\n'),
		);
	}
	if (props.base === 'openclaw-gateway') {
		if (
			!props.directNpmPackages.some(
				(packageEntry) => packageEntry.name === managedOpenAiCodexCliPackageName,
			)
		) {
			throw new Error('OpenClaw gateway packageOverrides.npm must include @openai/codex@<version>.');
		}
		const openClawAgentVmPackageInstallMode =
			props.openClawAgentVmPackageInstallMode ?? 'managed-packages';
		let managedFinalStagePackageSpecs: readonly string[];
		if (openClawAgentVmPackageInstallMode === 'managed-packages') {
			const openClawAgentVmPluginPackageSpec = props.openClawAgentVmPluginPackageSpec;
			const gatewayRuntimePackageSpec = props.gatewayRuntimePackageSpec;
			if (!openClawAgentVmPluginPackageSpec) {
				throw new Error(
					'OpenClaw gateway managed Dockerfiles require the managed OpenClaw plugin package spec.',
				);
			}
			if (!gatewayRuntimePackageSpec) {
				throw new Error(
					'OpenClaw gateway managed Dockerfiles require the Gateway runtime package spec.',
				);
			}
			managedFinalStagePackageSpecs = [
				openClawAgentVmPluginPackageSpec,
				gatewayRuntimePackageSpec,
			];
		} else {
			managedFinalStagePackageSpecs = [];
		}
		lines.push('', 'FROM openclaw-runtime');
		if (managedFinalStagePackageSpecs.length > 0) {
			lines.push('RUN pnpm add -g ' + shellJoin(managedFinalStagePackageSpecs));
		}
		if (props.directNpmPackages.length > 0) {
			lines.push(
				'RUN pnpm add -g --ignore-scripts ' +
					shellJoin(props.directNpmPackages.map((packageEntry) => packageEntry.spec)),
			);
		}
		lines.push('WORKDIR /');
	}
	for (const copy of props.overlay.copy) {
		lines.push(`COPY overlay/${copy.from} ${copy.to}`);
	}
	for (const command of props.overlay.runAfterBase) {
		lines.push(`RUN ${command}`);
	}
	if (props.base === 'openclaw-gateway') {
		lines.push(
			[
				'RUN package_root="$(pnpm root -g)" && \\',
				'    openclaw_package_root="$package_root/openclaw" && \\',
				...(props.gatewayRuntimePackageSpec
					? [
							'    gateway_runtime_bin="$package_root/@agent-vm/gateway-runtime/dist/bin/gateway-runtime.js" && \\',
							'    test -f "$gateway_runtime_bin" && chmod 755 "$gateway_runtime_bin" && \\',
							'    ln -sfn "$gateway_runtime_bin" /usr/local/bin/agent-vm-gateway-runtime && \\',
						]
					: []),
				'    mkdir -p /home/openclaw/.openclaw/extensions && \\',
				'    ln -sfn "$openclaw_package_root/dist/plugin-sdk/diagnostic-runtime.js" /opt/openclaw-sdk/diagnostic-runtime.js && \\',
				'    ln -sfn "$openclaw_package_root/dist/plugin-sdk/sandbox.js" /opt/openclaw-sdk/sandbox.js && \\',
				'    ln -sfn "$openclaw_package_root/openclaw.mjs" /pnpm/openclaw && \\',
				'    chmod 755 "$openclaw_package_root/openclaw.mjs" && \\',
				'    printf \'#!/bin/sh\\nexec /pnpm/openclaw "$@"\\n\' > /usr/local/bin/openclaw && \\',
				'    chmod 755 /usr/local/bin/openclaw && \\',
				`    ln -sfn "$package_root/@agent-vm/openclaw-agent-vm-plugin/dist" ${managedOpenClawAgentVmPluginExtensionPath} && \\`,
				'    pnpm store prune && \\',
				'    rm -rf /root/.cache /root/.npm /tmp/*',
			].join('\n'),
		);
	}
	lines.push('');
	return lines.join('\n');
}

function resolveOpenClawPackagePlanEntries(props: {
	readonly effectivePackageOverrides: EffectivePackageOverrides;
	readonly requiredOpenClawPackageNames: readonly string[];
}): readonly ManagedDockerfilePackagePlanEntry[] {
	const entriesByName = new Map<string, ManagedDockerfilePackagePlanEntry>();
	for (const packageOverride of props.effectivePackageOverrides.openclaw) {
		if (managedOpenClawPackageNames.has(packageOverride.name)) {
			throw new Error(
				`packageOverrides.openclaw cannot override managed package ${packageOverride.name}. Update the agent-vm release instead.`,
			);
		}
		entriesByName.set(packageOverride.name, {
			name: packageOverride.name,
			source: packageOverride.source,
			spec: packageOverride.spec,
			version: packageOverride.version,
		});
	}

	const effectiveOpenClawPackage = entriesByName.get('openclaw');
	if (!effectiveOpenClawPackage?.version) {
		throw new Error('OpenClaw gateway packageOverrides.openclaw must include openclaw@<version>.');
	}
	for (const packageName of props.requiredOpenClawPackageNames) {
		if (entriesByName.has(packageName)) {
			continue;
		}
		entriesByName.set(packageName, {
			name: packageName,
			source: effectiveOpenClawPackage.source.startsWith('overlay.jsonc/')
				? effectiveOpenClawPackage.source
				: 'managed-default',
			spec: packageSpec(packageName, effectiveOpenClawPackage.version),
			version: effectiveOpenClawPackage.version,
		});
	}

	return [...entriesByName.values()];
}

function mergeRequiredOpenClawPackageNames(packageNames: readonly string[]): readonly string[] {
	return [...new Set([...managedCoreOpenClawPackageNames, ...packageNames])];
}

function collectOpenClawPackagePlanWarnings(
	openClawPackages: readonly ManagedDockerfilePackagePlanEntry[],
): readonly ManagedDockerfilePlanWarning[] {
	const coreOpenClawPackage = openClawPackages.find((packageEntry) => packageEntry.name === 'openclaw');
	if (!coreOpenClawPackage?.version) {
		return [];
	}
	const warnings: ManagedDockerfilePlanWarning[] = [];
	for (const packageEntry of openClawPackages) {
		if (
			!packageEntry.name.startsWith('@openclaw/') ||
			!packageEntry.version ||
			packageEntry.version === coreOpenClawPackage.version
		) {
			continue;
		}
		warnings.push({
			type: 'openclaw-package-version-mismatch',
			message: `OpenClaw package versions differ: openclaw uses ${coreOpenClawPackage.version}, but ${packageEntry.name} uses ${packageEntry.version}.`,
		});
	}
	return warnings;
}

function openClawDependencyOverridePlanEntries(
	pnpmOverrides: readonly ResolvedPackageOverrideVersion[],
): readonly ManagedDockerfileDependencyOverridePlanEntry[] {
	return pnpmOverrides
		.map((overrideEntry) => ({
			name: overrideEntry.name,
			source: overrideEntry.source,
			version: overrideEntry.version,
		}))
		.toSorted((left, right) => left.name.localeCompare(right.name));
}

function directNpmPackagePlanEntries(
	effectivePackageOverrides: EffectivePackageOverrides,
): readonly ManagedDockerfilePackagePlanEntry[] {
	return effectivePackageOverrides.npm.map((packageOverride) => ({
		name: packageOverride.name,
		source: packageOverride.source,
		spec: packageOverride.spec,
		version: packageOverride.version,
	}));
}

function assertOverlayCopySourceIsSafe(sourcePath: string): void {
	if (path.isAbsolute(sourcePath) || sourcePath.split(/[\\/]+/u).includes('..')) {
		throw new Error(
			`Managed image overlay copy source '${sourcePath}' must be relative and must not contain parent traversal.`,
		);
	}
}

function hasLocalAgentVmPackageOverlay(overlay: ManagedImageOverlay): boolean {
	return overlay.copy.some((copyEntry) => copyEntry.from.startsWith('local-agent-vm/agent-vm-'));
}

export async function generateManagedDockerfile(
	options: GenerateManagedDockerfileOptions,
): Promise<GenerateManagedDockerfileResult> {
	const overlay = await loadManagedImageOverlay(options.overlayPath);
	const usesLocalAgentVmPackageOverlay = hasLocalAgentVmPackageOverlay(overlay);
	const baseImage = options.managedImageRelease.baseImages[options.base];
	const effectivePackageOverrides = resolveEffectivePackageOverrides({
		base: options.base,
		managed: baseImage.packageOverrides,
		overlay: overlay.packageOverrides,
	});
	const openClawPackages =
		options.base === 'openclaw-gateway'
			? resolveOpenClawPackagePlanEntries({
					effectivePackageOverrides,
					requiredOpenClawPackageNames: mergeRequiredOpenClawPackageNames(
						options.requiredOpenClawPackageNames ?? [],
					),
				})
			: [];
	const effectivePnpmOverrides = filterPnpmOverridesForPackages(
		openClawPackages,
		effectivePackageOverrides.pnpm,
	);
	const openClawDependencyOverrides = openClawDependencyOverridePlanEntries(
		effectivePnpmOverrides,
	);
	const warnings = collectOpenClawPackagePlanWarnings(openClawPackages);
	const openClawAgentVmPackageInstallMode =
		options.openClawAgentVmPackageInstallMode ??
		(usesLocalAgentVmPackageOverlay ? 'local-overlay' : 'managed-packages');
	const openClawAgentVmPluginPackageSpec =
		options.base === 'openclaw-gateway' && openClawAgentVmPackageInstallMode === 'managed-packages'
			? await resolveManagedOpenClawAgentVmPluginPackageSpec()
			: undefined;
	const gatewayRuntimePackageSpec =
		options.base === 'openclaw-gateway' && openClawAgentVmPackageInstallMode === 'managed-packages'
			? await resolveManagedPackageSpec(managedGatewayRuntimePackageName)
			: undefined;
	const mcpPortalPackageSpec =
		options.base === 'tool-vm' && !usesLocalAgentVmPackageOverlay
			? await resolveManagedPackageSpec(managedMcpPortalPackageName)
			: undefined;
	const mcpPortalPackagePlan =
		options.base === 'tool-vm' && usesLocalAgentVmPackageOverlay
			? ({
					name: managedMcpPortalPackageName,
					source: 'local-overlay',
					spec: 'local-agent-vm',
				} satisfies ManagedDockerfilePackagePlanEntry)
			: mcpPortalPackageSpec === undefined
				? undefined
				: ({
						name: managedMcpPortalPackageName,
						source: 'installed-package',
						spec: mcpPortalPackageSpec,
					} satisfies ManagedDockerfilePackagePlanEntry);
	const directNpmPackages = directNpmPackagePlanEntries(effectivePackageOverrides);
	if (
		options.base === 'openclaw-gateway' &&
		!directNpmPackages.some((packageEntry) => packageEntry.name === managedOpenAiCodexCliPackageName)
	) {
		throw new Error('OpenClaw gateway packageOverrides.npm must include @openai/codex@<version>.');
	}
	await fs.rm(options.outputDirectory, { force: true, recursive: true });
	await fs.mkdir(path.join(options.outputDirectory, 'overlay'), { recursive: true });
	const overlayDirectory = options.overlayPath ? path.dirname(options.overlayPath) : undefined;
	for (const copy of overlay.copy) {
		assertOverlayCopySourceIsSafe(copy.from);
		if (!overlayDirectory) {
			throw new Error(`Managed image profile '${options.imageTargetName}' has copy entries without an overlay path.`);
		}
		const sourcePath = path.join(overlayDirectory, copy.from);
		const targetPath = path.join(options.outputDirectory, 'overlay', copy.from);
		await fs.mkdir(path.dirname(targetPath), { recursive: true });
		await fs.copyFile(sourcePath, targetPath);
	}
	const dockerfilePath = path.join(options.outputDirectory, 'Dockerfile');
	await fs.writeFile(
		dockerfilePath,
		renderManagedDockerfile({
			base: options.base,
			baseImage,
			directNpmPackages,
			...(gatewayRuntimePackageSpec === undefined ? {} : { gatewayRuntimePackageSpec }),
			...(mcpPortalPackageSpec === undefined ? {} : { mcpPortalPackageSpec }),
			overlay,
			openClawAgentVmPackageInstallMode,
			...(openClawAgentVmPluginPackageSpec === undefined
				? {}
				: { openClawAgentVmPluginPackageSpec }),
			openClawPackages,
			pnpmOverrides: effectivePnpmOverrides,
		}),
		'utf8',
	);
	return {
		dockerfilePath,
		plan: {
			base: options.base,
			baseImage: {
				reference: `${baseImage.repository}:${baseImage.tag}`,
				repository: baseImage.repository,
				source: 'managed-images.json',
				tag: baseImage.tag,
			},
			dockerfilePath,
			imageTargetFamily: options.imageTargetFamily,
			imageTargetName: options.imageTargetName,
			...(openClawAgentVmPluginPackageSpec === undefined
				? {}
				: {
						openClawAgentVmPluginPackage: {
							name: managedOpenClawAgentVmPluginPackageName,
							source: 'installed-package',
							spec: openClawAgentVmPluginPackageSpec,
						},
					}),
			...(mcpPortalPackagePlan === undefined ? {} : { mcpPortalPackage: mcpPortalPackagePlan }),
			...(gatewayRuntimePackageSpec === undefined
				? {}
				: {
						gatewayRuntimePackage: {
							name: managedGatewayRuntimePackageName,
							source: 'installed-package',
							spec: gatewayRuntimePackageSpec,
						},
					}),
			directNpmPackages,
			openClawDependencyOverrides,
			openClawPackages,
			warnings,
		},
	};
}

async function resolvePackageRootFromEntrypoint(packageName: string): Promise<string> {
	let searchDirectory = path.dirname(fileURLToPath(import.meta.resolve(packageName)));
	for (;;) {
		const packageJsonPath = path.join(searchDirectory, 'package.json');
		try {
			// oxlint-disable-next-line no-await-in-loop -- upward package root discovery is intentionally sequential
			const packageJson = await loadJsonConfigFile(packageJsonPath);
			if (
				typeof packageJson === 'object' &&
				packageJson !== null &&
				'name' in packageJson &&
				packageJson.name === packageName
			) {
				return searchDirectory;
			}
		} catch (error) {
			if (
				typeof error !== 'object' ||
				error === null ||
				!('code' in error) ||
				error.code !== 'ENOENT'
			) {
				throw error;
			}
		}
		const parentDirectory = path.dirname(searchDirectory);
		if (parentDirectory === searchDirectory) {
			throw new Error(`Unable to resolve ${packageName} package root.`);
		}
		searchDirectory = parentDirectory;
	}
}

export async function resolveManagedOpenClawAgentVmPluginPackageSpec(): Promise<string> {
	return await resolveManagedPackageSpec(managedOpenClawAgentVmPluginPackageName);
}

export async function resolveManagedPackageSpec(packageName: string): Promise<string> {
	const packageRoot = await resolvePackageRootFromEntrypoint(
		packageName,
	);
	const packageJsonPath = path.join(packageRoot, 'package.json');
	const packageJson: unknown = await loadJsonConfigFile(packageJsonPath);
	if (
		typeof packageJson !== 'object' ||
		packageJson === null ||
		!('name' in packageJson) ||
		packageJson.name !== packageName ||
		!('version' in packageJson) ||
		typeof packageJson.version !== 'string'
	) {
		throw new Error(
			`Expected ${packageJsonPath} to describe ${packageName} with a version.`,
		);
	}
	return `${packageJson.name}@${packageJson.version}`;
}

async function resolveAgentVmPackageRoot(): Promise<string> {
	let searchDirectory = path.dirname(fileURLToPath(import.meta.url));
	for (;;) {
		const packageJsonPath = path.join(searchDirectory, 'package.json');
		try {
			// oxlint-disable-next-line no-await-in-loop -- upward package root discovery is intentionally sequential
			const packageJson = await loadJsonConfigFile(packageJsonPath);
			if (
				typeof packageJson === 'object' &&
				packageJson !== null &&
				'name' in packageJson &&
				packageJson.name === '@agent-vm/agent-vm'
			) {
				return searchDirectory;
			}
		} catch (error) {
			if (
				typeof error !== 'object' ||
				error === null ||
				!('code' in error) ||
				error.code !== 'ENOENT'
			) {
				throw error;
			}
		}
		const parentDirectory = path.dirname(searchDirectory);
		if (parentDirectory === searchDirectory) {
			throw new Error('Unable to resolve @agent-vm/agent-vm package root.');
		}
		searchDirectory = parentDirectory;
	}
}

export async function resolveManagedImageRelease(): Promise<ManagedImageRelease> {
	const packageRoot = await resolveAgentVmPackageRoot();
	const manifestPath = path.join(packageRoot, 'managed-images.json');
	const parsedRelease = managedImageReleaseSchema.safeParse(
		await loadJsonConfigFile(manifestPath),
	);
	if (!parsedRelease.success) {
		throw new Error(
			formatZodError(`Invalid managed image release manifest at ${manifestPath}:`, parsedRelease.error),
		);
	}
	return parsedRelease.data;
}
