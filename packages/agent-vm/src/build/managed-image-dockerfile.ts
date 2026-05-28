import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { loadJsonConfigFile } from '../config/json-config-file.js';
import { formatZodError } from '../cli/format-zod-error.js';

export type ManagedImageBase = 'openclaw-gateway' | 'tool-vm' | 'worker-gateway';

const managedOpenClawAgentVmPluginPackageName = '@agent-vm/openclaw-agent-vm-plugin';
const managedOpenClawMcpPortalPluginPackageName = '@agent-vm/openclaw-mcp-portal-plugin';
const managedMcpPortalPackageName = '@agent-vm/mcp-portal';
const managedOpenAiCodexCliPackageName = '@openai/codex';
const managedCoreOpenClawPackageNames = ['openclaw', '@openclaw/codex'] as const;
const managedOpenClawPackageNames = new Set([
	managedOpenClawAgentVmPluginPackageName,
	managedOpenClawMcpPortalPluginPackageName,
	managedMcpPortalPackageName,
]);
const managedOpenClawAgentVmPluginExtensionPath = '/home/openclaw/.openclaw/extensions/gondolin';
const managedOpenClawMcpPortalPluginExtensionPath = '/home/openclaw/.openclaw/extensions/mcp-portal';
const managedPnpmHomePath = '/pnpm';
const managedPnpmGlobalDirectory = '/pnpm/global';
const exactPackageVersionPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;

export interface ManagedImageSource {
	readonly kind: 'managedBase';
	readonly base: ManagedImageBase;
	readonly overlay?: string | undefined;
}

export interface GenerateManagedDockerfileOptions {
	readonly base: ManagedImageBase;
	readonly imageTargetFamily: 'gateway' | 'toolVm';
	readonly imageTargetName: string;
	readonly outputDirectory: string;
	readonly overlayPath?: string | undefined;
	readonly managedImageRelease: ManagedImageRelease;
	readonly requiredOpenClawPackageNames?: readonly string[];
}

export type ManagedDockerfilePlanSource =
	| 'installed-package'
	| 'managed-default'
	| 'managed-images.json'
	| 'overlay';

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
	readonly openClawMcpPortalPluginPackage?: ManagedDockerfilePackagePlanEntry;
	readonly mcpPortalPackage?: ManagedDockerfilePackagePlanEntry;
	readonly openAiCodexCliPackage?: ManagedDockerfilePackagePlanEntry;
	readonly openClawPackages: readonly ManagedDockerfilePackagePlanEntry[];
	readonly warnings: readonly ManagedDockerfilePlanWarning[];
}

export interface GenerateManagedDockerfileResult {
	readonly dockerfilePath: string;
	readonly plan: ManagedDockerfilePlan;
}

export interface ManagedBaseImageReference {
	readonly repository: string;
	readonly tag: string;
}

export interface ManagedImageRelease {
	readonly baseImages: Readonly<Record<ManagedImageBase, ManagedBaseImageReference>>;
	readonly openAiCodexCliVersion: string;
	readonly openClawVersion: string;
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
		openClawPackageOverrides: z.array(z.string().min(1)).default([]),
		copy: z.array(overlayCopySchema).default([]),
		runAfterBase: z.array(z.string().min(1)).default([]),
	})
	.strict();

const managedBaseImageReferenceSchema = z
	.object({
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
		openAiCodexCliVersion: z.string().min(1),
		openClawVersion: z.string().min(1),
	})
	.strict();

type ManagedImageOverlay = z.infer<typeof managedImageOverlaySchema>;

function hasLegacyOpenClawPackageOverlayKey(value: unknown): boolean {
	return (
		typeof value === 'object' &&
		value !== null &&
		!Array.isArray(value) &&
		Object.hasOwn(value, 'extraOpenClawPackages')
	);
}

async function loadManagedImageOverlay(overlayPath: string | undefined): Promise<ManagedImageOverlay> {
	if (!overlayPath) {
		return {
			schemaVersion: 1,
			extraAptPackages: [],
			openClawPackageOverrides: [],
			copy: [],
			runAfterBase: [],
		};
	}
	const rawOverlay = await loadJsonConfigFile(overlayPath);
	if (hasLegacyOpenClawPackageOverlayKey(rawOverlay)) {
		throw new Error(
			`Invalid managed image overlay at ${overlayPath}: rename extraOpenClawPackages to openClawPackageOverrides.`,
		);
	}
	const parsedOverlay = managedImageOverlaySchema.safeParse(rawOverlay);
	if (!parsedOverlay.success) {
		throw new Error(
			formatZodError(`Invalid managed image overlay at ${overlayPath}:`, parsedOverlay.error),
		);
	}
	return parsedOverlay.data;
}

function shellJoin(argumentsToQuote: readonly string[]): string {
	return argumentsToQuote.map((argument) => JSON.stringify(argument)).join(' ');
}

interface ParsedPackageSpec {
	readonly name: string;
	readonly version?: string;
}

function parsePackageSpec(packageSpec: string): ParsedPackageSpec {
	if (packageSpec.startsWith('@')) {
		const scopeSeparatorIndex = packageSpec.indexOf('/');
		if (scopeSeparatorIndex === -1) {
			return { name: packageSpec };
		}
		const versionSeparatorIndex = packageSpec.indexOf('@', scopeSeparatorIndex + 1);
		if (versionSeparatorIndex === -1) {
			return { name: packageSpec };
		}
		return {
			name: packageSpec.slice(0, versionSeparatorIndex),
			version: packageSpec.slice(versionSeparatorIndex + 1),
		};
	}

	const versionSeparatorIndex = packageSpec.indexOf('@');
	if (versionSeparatorIndex === -1) {
		return { name: packageSpec };
	}
	return {
		name: packageSpec.slice(0, versionSeparatorIndex),
		version: packageSpec.slice(versionSeparatorIndex + 1),
	};
}

function packageSpec(packageName: string, version: string): string {
	return `${packageName}@${version}`;
}

function isOpenClawRuntimePackageName(packageName: string): boolean {
	return packageName === 'openclaw' || packageName.startsWith('@openclaw/');
}

function assertValidOpenClawPackageOverride(packageSpecValue: string): ParsedPackageSpec {
	const parsedPackageSpec = parsePackageSpec(packageSpecValue);
	if (managedOpenClawPackageNames.has(parsedPackageSpec.name)) {
		throw new Error(
			`openClawPackageOverrides cannot override managed package ${parsedPackageSpec.name}. Update the agent-vm release instead.`,
		);
	}
	if (!isOpenClawRuntimePackageName(parsedPackageSpec.name)) {
		throw new Error(
			`openClawPackageOverrides only accepts OpenClaw runtime package pins. Use openclaw@<version> or @openclaw/<name>@<version>, not ${packageSpecValue}.`,
		);
	}
	if (
		parsedPackageSpec.version === undefined ||
		!exactPackageVersionPattern.test(parsedPackageSpec.version)
	) {
		throw new Error(
			`openClawPackageOverrides requires exact package versions. Use ${parsedPackageSpec.name}@<version>, not ${packageSpecValue}.`,
		);
	}
	return parsedPackageSpec;
}

function renderManagedDockerfile(props: {
	readonly base: ManagedImageBase;
	readonly baseImage: ManagedBaseImageReference;
	readonly overlay: ManagedImageOverlay;
	readonly mcpPortalPackageSpec?: string;
	readonly openAiCodexCliPackageSpec?: string;
	readonly openClawAgentVmPluginPackageSpec?: string;
	readonly openClawMcpPortalPluginPackageSpec?: string;
	readonly openClawPackages: readonly ManagedDockerfilePackagePlanEntry[];
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
	if (
		props.base === 'openclaw-gateway' ||
		props.base === 'tool-vm' ||
		props.openClawPackages.length > 0
	) {
		lines.push(`ENV PNPM_HOME=${managedPnpmHomePath}`);
		lines.push('ENV PATH=${PNPM_HOME}:${PATH}');
		lines.push(
			`RUN pnpm config set global-dir ${managedPnpmGlobalDirectory} && pnpm config set global-bin-dir ${managedPnpmHomePath}`,
		);
	}
	if (props.base === 'tool-vm') {
		if (!props.mcpPortalPackageSpec) {
			throw new Error('Tool VM managed Dockerfiles require the MCP Portal package spec.');
		}
		lines.push('RUN pnpm add -g ' + shellJoin([props.mcpPortalPackageSpec]));
	}
	if (props.openClawPackages.length > 0) {
		lines.push('RUN pnpm add -g ' + shellJoin(props.openClawPackages.map((entry) => entry.spec)));
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
			!props.openClawAgentVmPluginPackageSpec ||
			!props.openClawMcpPortalPluginPackageSpec ||
			!props.mcpPortalPackageSpec ||
			!props.openAiCodexCliPackageSpec
		) {
			throw new Error('OpenClaw gateway managed Dockerfiles require all managed OpenClaw plugin package specs.');
		}
		lines.push('', 'FROM openclaw-runtime');
		lines.push(
			'RUN pnpm add -g ' +
				shellJoin([
					props.openClawAgentVmPluginPackageSpec,
					props.openClawMcpPortalPluginPackageSpec,
					props.mcpPortalPackageSpec,
					props.openAiCodexCliPackageSpec,
				]),
		);
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
				'    mkdir -p /home/openclaw/.openclaw/extensions && \\',
				'    ln -sfn "$openclaw_package_root/dist/plugin-sdk/sandbox.js" /opt/openclaw-sdk/sandbox.js && \\',
				'    printf \'#!/bin/sh\\nexec /pnpm/openclaw "$@"\\n\' > /usr/local/bin/openclaw && \\',
				'    chmod 755 /usr/local/bin/openclaw && \\',
				`    ln -sfn "$package_root/@agent-vm/openclaw-agent-vm-plugin/dist" ${managedOpenClawAgentVmPluginExtensionPath} && \\`,
				`    ln -sfn "$package_root/@agent-vm/openclaw-mcp-portal-plugin/dist" ${managedOpenClawMcpPortalPluginExtensionPath} && \\`,
				'    pnpm store prune && \\',
				'    rm -rf /root/.cache /root/.npm /tmp/*',
			].join('\n'),
		);
	}
	lines.push('');
	return lines.join('\n');
}

function resolveOpenClawPackagePlanEntries(props: {
	readonly managedImageRelease: ManagedImageRelease;
	readonly overlay: ManagedImageOverlay;
	readonly requiredOpenClawPackageNames: readonly string[];
}): readonly ManagedDockerfilePackagePlanEntry[] {
	const entriesByName = new Map<string, ManagedDockerfilePackagePlanEntry>();
	let overlayOpenClawVersion: string | undefined;

	for (const overlayPackageSpec of props.overlay.openClawPackageOverrides) {
		const parsedPackageSpec = assertValidOpenClawPackageOverride(overlayPackageSpec);
		const name = parsedPackageSpec.name;
		const version = parsedPackageSpec.version;
		if (name === 'openclaw' && version !== undefined) {
			overlayOpenClawVersion = version;
		}
		entriesByName.set(name, {
			name,
			source: 'overlay',
			spec: overlayPackageSpec,
			...(version === undefined ? {} : { version }),
		});
	}

	const fallbackOpenClawVersion = overlayOpenClawVersion ?? props.managedImageRelease.openClawVersion;
	for (const packageName of props.requiredOpenClawPackageNames) {
		if (entriesByName.has(packageName)) {
			continue;
		}
		entriesByName.set(packageName, {
			name: packageName,
			source: overlayOpenClawVersion === undefined ? 'managed-default' : 'overlay',
			spec: packageSpec(packageName, fallbackOpenClawVersion),
			version: fallbackOpenClawVersion,
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

function assertOverlayCopySourceIsSafe(sourcePath: string): void {
	if (path.isAbsolute(sourcePath) || sourcePath.split(/[\\/]+/u).includes('..')) {
		throw new Error(
			`Managed image overlay copy source '${sourcePath}' must be relative and must not contain parent traversal.`,
		);
	}
}

export async function generateManagedDockerfile(
	options: GenerateManagedDockerfileOptions,
): Promise<GenerateManagedDockerfileResult> {
	const overlay = await loadManagedImageOverlay(options.overlayPath);
	const baseImage = options.managedImageRelease.baseImages[options.base];
	const openClawPackages =
		options.base === 'openclaw-gateway'
			? resolveOpenClawPackagePlanEntries({
					managedImageRelease: options.managedImageRelease,
					overlay,
					requiredOpenClawPackageNames: mergeRequiredOpenClawPackageNames(
						options.requiredOpenClawPackageNames ?? [],
					),
				})
			: [];
	const warnings = collectOpenClawPackagePlanWarnings(openClawPackages);
	const openClawAgentVmPluginPackageSpec =
		options.base === 'openclaw-gateway'
			? await resolveManagedOpenClawAgentVmPluginPackageSpec()
			: undefined;
	const openClawMcpPortalPluginPackageSpec =
		options.base === 'openclaw-gateway'
			? await resolveManagedPackageSpec(managedOpenClawMcpPortalPluginPackageName)
			: undefined;
	const mcpPortalPackageSpec =
		options.base === 'openclaw-gateway' || options.base === 'tool-vm'
			? await resolveManagedPackageSpec(managedMcpPortalPackageName)
			: undefined;
	const openAiCodexCliPackage =
		options.base === 'openclaw-gateway'
			? {
					name: managedOpenAiCodexCliPackageName,
					source: 'managed-images.json',
					spec: packageSpec(
						managedOpenAiCodexCliPackageName,
						options.managedImageRelease.openAiCodexCliVersion,
					),
					version: options.managedImageRelease.openAiCodexCliVersion,
				} satisfies ManagedDockerfilePackagePlanEntry
			: undefined;
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
			...(mcpPortalPackageSpec === undefined ? {} : { mcpPortalPackageSpec }),
			...(openAiCodexCliPackage === undefined
				? {}
				: { openAiCodexCliPackageSpec: openAiCodexCliPackage.spec }),
			overlay,
			...(openClawAgentVmPluginPackageSpec === undefined
				? {}
				: { openClawAgentVmPluginPackageSpec }),
			...(openClawMcpPortalPluginPackageSpec === undefined
				? {}
				: { openClawMcpPortalPluginPackageSpec }),
			openClawPackages,
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
			...(openClawMcpPortalPluginPackageSpec === undefined
				? {}
				: {
						openClawMcpPortalPluginPackage: {
							name: managedOpenClawMcpPortalPluginPackageName,
							source: 'installed-package',
							spec: openClawMcpPortalPluginPackageSpec,
						},
					}),
			...(mcpPortalPackageSpec === undefined
				? {}
				: {
						mcpPortalPackage: {
							name: managedMcpPortalPackageName,
							source: 'installed-package',
							spec: mcpPortalPackageSpec,
						},
					}),
			...(openAiCodexCliPackage === undefined
				? {}
				: { openAiCodexCliPackage }),
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
