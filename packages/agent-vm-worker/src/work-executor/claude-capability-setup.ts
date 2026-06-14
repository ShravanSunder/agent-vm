import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type ResolveClaudeCodeExecutable = () => string;

export interface ClaudeRuntimeCapabilitiesHandle {
	readonly env: Record<string, string>;
	readonly executablePath: string;
}

export interface PrepareClaudeRuntimeCapabilitiesOptions {
	readonly executablePath: string;
	readonly inheritedEnv: NodeJS.ProcessEnv;
	readonly stateDirectory?: string;
}

const claudeRuntimePackagePrefix = '@anthropic-ai/claude-agent-sdk';

function buildClaudeEnvironment(options: {
	readonly claudeConfigDirectory: string;
	readonly homeDirectory: string;
	readonly inheritedEnv: NodeJS.ProcessEnv;
}): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(options.inheritedEnv)) {
		if (value !== undefined) {
			env[key] = value;
		}
	}
	env.CLAUDE_AGENT_SDK_CLIENT_APP = 'agent-vm-worker';
	env.CLAUDE_CONFIG_DIR = options.claudeConfigDirectory;
	env.HOME = options.homeDirectory;
	return env;
}

function resolveClaudeRuntimePackageCandidates(): readonly string[] {
	if (process.platform === 'darwin') {
		return [`${claudeRuntimePackagePrefix}-darwin-${process.arch}`];
	}
	if (process.platform === 'linux') {
		return [
			`${claudeRuntimePackagePrefix}-linux-${process.arch}`,
			`${claudeRuntimePackagePrefix}-linux-${process.arch}-musl`,
		];
	}
	if (process.platform === 'win32') {
		return [`${claudeRuntimePackagePrefix}-win32-${process.arch}`];
	}
	return [];
}

export function resolveBundledClaudeCodeExecutable(): string {
	const workerRequire = createRequire(import.meta.url);
	const sdkEntryPoint = workerRequire.resolve('@anthropic-ai/claude-agent-sdk');
	const sdkRequire = createRequire(pathToFileURL(sdkEntryPoint).href);
	const errors: string[] = [];
	for (const packageName of resolveClaudeRuntimePackageCandidates()) {
		try {
			return sdkRequire.resolve(`${packageName}/claude`);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	throw new Error(
		`Native CLI binary for ${process.platform}-${process.arch} not found. Reinstall @anthropic-ai/claude-agent-sdk without omitting optional dependencies.${errors.length > 0 ? ` Tried: ${errors.join('; ')}` : ''}`,
	);
}

export function resolveActionableClaudeCodeExecutable(
	resolveClaudeCodeExecutable: ResolveClaudeCodeExecutable = resolveBundledClaudeCodeExecutable,
): string {
	try {
		return resolveClaudeCodeExecutable();
	} catch (error) {
		throw new Error(
			'Claude Code runtime is unavailable. Reinstall @anthropic-ai/claude-agent-sdk without omitting optional dependencies.',
			{ cause: error },
		);
	}
}

export function isClaudeCodeRuntimeAvailable(): boolean {
	try {
		resolveActionableClaudeCodeExecutable();
		return true;
	} catch {
		return false;
	}
}

export async function prepareClaudeRuntimeCapabilities(
	options: PrepareClaudeRuntimeCapabilitiesOptions,
): Promise<ClaudeRuntimeCapabilitiesHandle> {
	const claudeHomeBase = options.stateDirectory ?? os.tmpdir();
	await fs.mkdir(claudeHomeBase, { recursive: true });
	const homeDirectory = await fs.mkdtemp(path.join(claudeHomeBase, 'agent-vm-claude-home-'));
	const claudeConfigDirectory = path.join(homeDirectory, '.claude');
	await fs.mkdir(claudeConfigDirectory, { recursive: true });
	return {
		env: buildClaudeEnvironment({
			claudeConfigDirectory,
			homeDirectory,
			inheritedEnv: options.inheritedEnv,
		}),
		executablePath: options.executablePath,
	};
}
