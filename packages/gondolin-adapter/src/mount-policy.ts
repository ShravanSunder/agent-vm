import fs from 'node:fs/promises';
import path from 'node:path';

const AUTH_GUEST_PATH_PREFIXES = [
	'/home/agent/.aws',
	'/home/agent/.claude',
	'/home/agent/.codex',
	'/home/agent/.gemini',
	'/home/openclaw/.aws',
	'/home/openclaw/.claude',
	'/home/openclaw/.codex',
	'/home/openclaw/.gemini',
	'/home/openclaw/.openclaw',
] as const;

export interface WritableMountPolicy {
	readonly allowAuthWrite: boolean;
	readonly writableAllowedGuestPrefixes: readonly string[];
}

export interface RuntimeMountPolicyConfig {
	readonly extraMounts: Readonly<Record<string, string>>;
	readonly mountControls: WritableMountPolicy;
}

function resolveAuthHostPrefixes(hostHome: string): readonly string[] {
	return [
		path.join(hostHome, '.aws'),
		path.join(hostHome, '.claude'),
		path.join(hostHome, '.codex'),
		path.join(hostHome, '.gemini'),
	];
}

export function resolveGuestMountPath(guestPath: string, workDir: string): string {
	if (path.isAbsolute(guestPath)) {
		return path.resolve(guestPath);
	}

	return path.resolve(workDir, guestPath);
}

function isPathWithinPrefix(candidatePath: string, prefixPath: string): boolean {
	const relativePath = path.relative(prefixPath, candidatePath);
	return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

async function normalizeHostPath(hostPath: string): Promise<string> {
	const resolvedHostPath = path.resolve(hostPath);

	try {
		return await fs.realpath(resolvedHostPath);
	} catch {
		return resolvedHostPath;
	}
}

function pathsOverlap(candidatePath: string, protectedPath: string): boolean {
	return (
		isPathWithinPrefix(candidatePath, protectedPath) ||
		isPathWithinPrefix(protectedPath, candidatePath)
	);
}

export function validateWritableMount(
	guestPath: string,
	policy: WritableMountPolicy,
	options: { readonly workDir: string },
): void {
	const resolvedGuestPath = resolveGuestMountPath(guestPath, options.workDir);
	const resolvedAllowedPrefixes = policy.writableAllowedGuestPrefixes.map((allowedPrefix) =>
		resolveGuestMountPath(allowedPrefix, options.workDir),
	);

	const isAllowedGuestPath = resolvedAllowedPrefixes.some((allowedPrefix) =>
		isPathWithinPrefix(resolvedGuestPath, allowedPrefix),
	);
	if (!isAllowedGuestPath) {
		throw new Error(
			`Writable mount guest path '${resolvedGuestPath}' is outside writable allowlist [${resolvedAllowedPrefixes.join(', ')}].`,
		);
	}

	if (!policy.allowAuthWrite) {
		const targetsProtectedGuestPath = AUTH_GUEST_PATH_PREFIXES.some((authPrefix) =>
			isPathWithinPrefix(resolvedGuestPath, authPrefix),
		);
		if (targetsProtectedGuestPath) {
			throw new Error(
				`Writable mount guest path '${resolvedGuestPath}' targets an auth mount path. Set mountControls.allowAuthWrite=true to permit auth writes.`,
			);
		}
	}
}

export async function validateRuntimeMountPolicy(
	config: RuntimeMountPolicyConfig,
	options: { readonly hostHome: string; readonly workDir: string },
): Promise<void> {
	const mountEntries = Object.entries(config.extraMounts);
	for (const [guestPath] of mountEntries) {
		validateWritableMount(guestPath, config.mountControls, options);
	}

	if (config.mountControls.allowAuthWrite) {
		return;
	}

	const absoluteHostMountEntries = mountEntries.filter(([, hostPath]) => path.isAbsolute(hostPath));
	const [protectedHostPaths, writableHostPaths] = await Promise.all([
		Promise.all(
			resolveAuthHostPrefixes(options.hostHome).map(
				async (authHostPrefix) => await normalizeHostPath(authHostPrefix),
			),
		),
		Promise.all(
			absoluteHostMountEntries.map(async ([, hostPath]) => await normalizeHostPath(hostPath)),
		),
	]);

	for (const resolvedWritableHostPath of writableHostPaths) {
		const overlapsProtectedHostPath = protectedHostPaths.some((authHostPrefix) =>
			pathsOverlap(resolvedWritableHostPath, authHostPrefix),
		);

		if (overlapsProtectedHostPath) {
			throw new Error(
				`Writable host path '${resolvedWritableHostPath}' targets an auth host directory. Set mountControls.allowAuthWrite=true to permit auth writes.`,
			);
		}
	}
}
