import path from 'node:path';

import type { LoadedSystemConfig } from '../config/system-config.js';
import {
	isRuntimeConfigReference,
	isRuntimeSystemConfigPath,
	runtimeConfigRoot,
} from './runtime-config-paths.js';

export interface ConfigValidationCheck {
	readonly name: string;
	readonly ok: boolean;
	readonly hint?: string;
}

export interface ConfigValidationResult {
	readonly ok: boolean;
	readonly checks: readonly ConfigValidationCheck[];
}

export interface ConfigValidationCommandOptions {
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string>>;
}

export interface ConfigValidationCommandResult {
	readonly exitCode: number;
	readonly stderr: string;
	readonly stdout: string;
}

export type ConfigValidationCommandRunner = (
	command: string,
	arguments_: readonly string[],
	options?: ConfigValidationCommandOptions,
) => Promise<ConfigValidationCommandResult>;

export function projectRootForSystemConfig(systemConfig: LoadedSystemConfig): string {
	return path.resolve(path.dirname(systemConfig.systemConfigPath), '..');
}

export function resolveProjectCheckoutPath(
	systemConfig: LoadedSystemConfig,
	configuredPath: string,
): string {
	if (isRuntimeSystemConfigPath(systemConfig)) {
		return configuredPath;
	}
	if (!isRuntimeConfigReference(configuredPath)) {
		return configuredPath;
	}

	const relativeRuntimePath = path.relative(runtimeConfigRoot, configuredPath);
	const projectRoot = projectRootForSystemConfig(systemConfig);
	if (relativeRuntimePath === 'system.json') {
		return path.join(projectRoot, 'config', 'system.json');
	}
	if (relativeRuntimePath.startsWith(`gateways${path.sep}`) || relativeRuntimePath === 'gateways') {
		return path.join(projectRoot, 'config', relativeRuntimePath);
	}
	return path.join(projectRoot, relativeRuntimePath);
}
