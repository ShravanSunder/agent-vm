import fs from 'node:fs/promises';
import path from 'node:path';

import { loadWorkerConfigDraft } from '@agent-vm/agent-vm-worker';
import { execa } from 'execa';

import { loadSystemCacheIdentifier } from '../config/system-cache-identifier.js';
import type { LoadedSystemConfig } from '../config/system-config.js';
import { collectVmHostSystemDoctorCheck } from './doctor.js';
import { isRuntimeSystemConfigPath, runtimeConfigRoot } from './runtime-config-paths.js';

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

export interface RunConfigValidationOptions {
	readonly runCommand?: ConfigValidationCommandRunner;
	readonly systemConfig: LoadedSystemConfig;
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function runCommandDefault(
	command: string,
	arguments_: readonly string[],
	options?: ConfigValidationCommandOptions,
): Promise<ConfigValidationCommandResult> {
	const execaOptions = {
		...(options?.cwd ? { cwd: options.cwd } : {}),
		...(options?.env ? { env: options.env } : {}),
		...(options?.cwd ? { localDir: options.cwd, preferLocal: true } : {}),
		reject: false,
	} as const;
	const result = await execa(command, [...arguments_], execaOptions);
	return {
		exitCode: result.exitCode ?? 1,
		stderr: result.stderr,
		stdout: result.stdout,
	};
}

function getErrorCode(error: unknown): string | undefined {
	if (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		typeof error.code === 'string'
	) {
		return error.code;
	}
	return undefined;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
	if (!value.trim()) {
		return null;
	}
	try {
		const parsedValue: unknown = JSON.parse(value);
		if (isObjectRecord(parsedValue)) {
			return parsedValue;
		}
		return null;
	} catch {
		return null;
	}
}

function formatOpenClawIssue(issue: unknown): string | null {
	if (typeof issue === 'string') {
		return issue;
	}
	if (!isObjectRecord(issue)) {
		return null;
	}
	const pathValue = issue.path;
	const messageValue = issue.message;
	const pathText = Array.isArray(pathValue)
		? pathValue.map((part) => String(part)).join('.')
		: typeof pathValue === 'string'
			? pathValue
			: '';
	const messageText = typeof messageValue === 'string' ? messageValue : '';
	if (pathText && messageText) {
		return `${pathText}: ${messageText}`;
	}
	if (messageText) {
		return messageText;
	}
	if (pathText) {
		return pathText;
	}
	return null;
}

function getOpenClawIssuePath(issue: unknown): string {
	if (!isObjectRecord(issue)) {
		return '';
	}
	const pathValue = issue.path;
	if (Array.isArray(pathValue)) {
		return pathValue.map((part) => String(part)).join('.');
	}
	return typeof pathValue === 'string' ? pathValue : '';
}

function getOpenClawIssueMessage(issue: unknown): string {
	if (!isObjectRecord(issue)) {
		return typeof issue === 'string' ? issue : '';
	}
	const messageValue = issue.message;
	return typeof messageValue === 'string' ? messageValue : '';
}

function isHostOnlyOpenClawPluginPathIssue(issue: unknown): boolean {
	return (
		getOpenClawIssuePath(issue) === 'plugins.load.paths' &&
		getOpenClawIssueMessage(issue).includes('plugin path not found')
	);
}

function getOpenClawValidationIssues(parsedOutput: Record<string, unknown>): readonly unknown[] {
	const issueValues = parsedOutput.errors ?? parsedOutput.issues;
	return Array.isArray(issueValues) ? issueValues : [];
}

function summarizeOpenClawValidationIssues(issues: readonly unknown[]): string | null {
	const issueTexts = issues
		.map((issue) => formatOpenClawIssue(issue))
		.filter((issueText): issueText is string => issueText !== null);
	return issueTexts.length > 0 ? issueTexts.join('; ') : null;
}

function summarizeOpenClawValidationOutput(commandResult: ConfigValidationCommandResult): string {
	const parsedOutput =
		parseJsonObject(commandResult.stdout) ?? parseJsonObject(commandResult.stderr);
	if (parsedOutput) {
		const issueText = summarizeOpenClawValidationIssues(getOpenClawValidationIssues(parsedOutput));
		if (issueText) {
			return issueText;
		}
		const messageValue = parsedOutput.message;
		if (typeof messageValue === 'string' && messageValue.length > 0) {
			return messageValue;
		}
	}

	const rawOutput = [commandResult.stderr.trim(), commandResult.stdout.trim()]
		.filter((value) => value.length > 0)
		.join('\n');
	return rawOutput || `OpenClaw config validation exited with ${commandResult.exitCode}.`;
}

function shouldTreatOpenClawValidationResultAsSuccess(
	commandResult: ConfigValidationCommandResult,
): boolean {
	if (commandResult.exitCode === 0) {
		const parsedOutput = parseJsonObject(commandResult.stdout);
		return !parsedOutput || (parsedOutput.ok !== false && parsedOutput.valid !== false);
	}
	const parsedOutput =
		parseJsonObject(commandResult.stdout) ?? parseJsonObject(commandResult.stderr);
	if (!parsedOutput) {
		return false;
	}
	const issues = getOpenClawValidationIssues(parsedOutput);
	return issues.length > 0 && issues.every((issue) => isHostOnlyOpenClawPluginPathIssue(issue));
}

function projectRootForSystemConfig(systemConfig: LoadedSystemConfig): string {
	return path.resolve(path.dirname(systemConfig.systemConfigPath), '..');
}

export function resolveProjectCheckoutPath(
	systemConfig: LoadedSystemConfig,
	configuredPath: string,
): string {
	if (isRuntimeSystemConfigPath(systemConfig)) {
		return configuredPath;
	}
	const relativeRuntimePath = path.relative(runtimeConfigRoot, configuredPath);
	if (
		!path.isAbsolute(configuredPath) ||
		relativeRuntimePath.startsWith('..') ||
		path.isAbsolute(relativeRuntimePath)
	) {
		return configuredPath;
	}

	const projectRoot = projectRootForSystemConfig(systemConfig);
	if (relativeRuntimePath === 'system.json') {
		return path.join(projectRoot, 'config', 'system.json');
	}
	if (relativeRuntimePath === 'systemCacheIdentifier.json') {
		return path.join(projectRoot, 'config', 'systemCacheIdentifier.json');
	}
	if (relativeRuntimePath.startsWith(`gateways${path.sep}`) || relativeRuntimePath === 'gateways') {
		return path.join(projectRoot, 'config', relativeRuntimePath);
	}
	return path.join(projectRoot, relativeRuntimePath);
}

async function collectReadableFileCheck(
	name: string,
	filePath: string,
): Promise<ConfigValidationCheck> {
	try {
		await fs.access(filePath);
		return { name, ok: true, hint: filePath };
	} catch (error) {
		return {
			name,
			ok: false,
			hint: `Missing ${filePath}: ${getErrorMessage(error)}`,
		};
	}
}

async function collectSystemCacheIdentifierCheck(
	systemConfig: LoadedSystemConfig,
): Promise<ConfigValidationCheck> {
	try {
		await loadSystemCacheIdentifier({ filePath: systemConfig.systemCacheIdentifierPath });
		return {
			name: 'system-cache-identifier',
			ok: true,
			hint: systemConfig.systemCacheIdentifierPath,
		};
	} catch (error) {
		return {
			name: 'system-cache-identifier',
			ok: false,
			hint: getErrorMessage(error),
		};
	}
}

async function collectWorkerConfigCheck(
	systemConfig: LoadedSystemConfig,
	zone: LoadedSystemConfig['zones'][number],
): Promise<ConfigValidationCheck> {
	const workerConfigPath = resolveProjectCheckoutPath(systemConfig, zone.gateway.config);
	try {
		await loadWorkerConfigDraft(workerConfigPath);
		return {
			name: `worker-config-${zone.id}`,
			ok: true,
			hint: workerConfigPath,
		};
	} catch (error) {
		return {
			name: `worker-config-${zone.id}`,
			ok: false,
			hint: getErrorMessage(error),
		};
	}
}

async function collectGatewayConfigCheck(
	systemConfig: LoadedSystemConfig,
	zone: LoadedSystemConfig['zones'][number],
): Promise<ConfigValidationCheck> {
	const gatewayConfigPath = resolveProjectCheckoutPath(systemConfig, zone.gateway.config);
	return await collectReadableFileCheck(`gateway-config-${zone.id}`, gatewayConfigPath);
}

async function collectOpenClawConfigCheck(
	systemConfig: LoadedSystemConfig,
	zone: LoadedSystemConfig['zones'][number],
	runCommand: ConfigValidationCommandRunner,
): Promise<ConfigValidationCheck> {
	const gatewayConfigPath = resolveProjectCheckoutPath(systemConfig, zone.gateway.config);
	try {
		const commandResult = await runCommand('openclaw', ['config', 'validate', '--json'], {
			cwd: projectRootForSystemConfig(systemConfig),
			env: { OPENCLAW_CONFIG_PATH: gatewayConfigPath },
		});
		if (shouldTreatOpenClawValidationResultAsSuccess(commandResult)) {
			return {
				name: `openclaw-config-${zone.id}`,
				ok: true,
				hint: gatewayConfigPath,
			};
		}
		return {
			name: `openclaw-config-${zone.id}`,
			ok: false,
			hint: summarizeOpenClawValidationOutput(commandResult),
		};
	} catch (error) {
		const installHint =
			getErrorCode(error) === 'ENOENT'
				? 'OpenClaw CLI not found. Install OpenClaw in this catalog for local schema validation: pnpm add -D openclaw@2026.4.24.'
				: getErrorMessage(error);
		return {
			name: `openclaw-config-${zone.id}`,
			ok: false,
			hint: installHint,
		};
	}
}

export async function collectOpenClawConfigChecks(
	systemConfig: LoadedSystemConfig,
	runCommand: ConfigValidationCommandRunner = runCommandDefault,
): Promise<readonly ConfigValidationCheck[]> {
	const openClawZones = systemConfig.zones.filter((zone) => zone.gateway.type === 'openclaw');
	return await Promise.all(
		openClawZones.map(
			async (zone) => await collectOpenClawConfigCheck(systemConfig, zone, runCommand),
		),
	);
}

async function collectGatewayImageProfileChecks(
	systemConfig: LoadedSystemConfig,
): Promise<readonly ConfigValidationCheck[]> {
	const pendingChecks: Promise<ConfigValidationCheck>[] = [];
	for (const [profileName, profile] of Object.entries(systemConfig.imageProfiles.gateways)) {
		const buildConfigPath = resolveProjectCheckoutPath(systemConfig, profile.buildConfig);
		pendingChecks.push(
			collectReadableFileCheck(`gateway-${profileName}-build-config`, buildConfigPath),
		);
		if (profile.dockerfile) {
			pendingChecks.push(
				collectReadableFileCheck(
					`gateway-${profileName}-dockerfile`,
					resolveProjectCheckoutPath(systemConfig, profile.dockerfile),
				),
			);
		}
	}
	const checks = await Promise.all(pendingChecks);
	return checks;
}

async function collectToolImageProfileChecks(
	systemConfig: LoadedSystemConfig,
): Promise<readonly ConfigValidationCheck[]> {
	const pendingChecks: Promise<ConfigValidationCheck>[] = [];
	for (const [profileName, profile] of Object.entries(systemConfig.imageProfiles.toolVms)) {
		const buildConfigPath = resolveProjectCheckoutPath(systemConfig, profile.buildConfig);
		pendingChecks.push(
			collectReadableFileCheck(`tool-vm-${profileName}-build-config`, buildConfigPath),
		);
		if (profile.dockerfile) {
			pendingChecks.push(
				collectReadableFileCheck(
					`tool-vm-${profileName}-dockerfile`,
					resolveProjectCheckoutPath(systemConfig, profile.dockerfile),
				),
			);
		}
	}
	const checks = await Promise.all(pendingChecks);
	return checks;
}

export async function runConfigValidation(
	options: RunConfigValidationOptions,
): Promise<ConfigValidationResult> {
	const systemConfig = options.systemConfig;
	const runCommand = options.runCommand ?? runCommandDefault;
	const zoneConfigChecks = await Promise.all(
		systemConfig.zones.map(async (zone) =>
			zone.gateway.type === 'worker'
				? await collectWorkerConfigCheck(systemConfig, zone)
				: await collectGatewayConfigCheck(systemConfig, zone),
		),
	);
	const vmHostSystemCheck = await collectVmHostSystemDoctorCheck(systemConfig);
	const checks = [
		await collectSystemCacheIdentifierCheck(systemConfig),
		...(await collectGatewayImageProfileChecks(systemConfig)),
		...(await collectToolImageProfileChecks(systemConfig)),
		...(vmHostSystemCheck ? [vmHostSystemCheck] : []),
		...zoneConfigChecks,
		...(await collectOpenClawConfigChecks(systemConfig, runCommand)),
	] as const satisfies readonly ConfigValidationCheck[];

	return {
		ok: checks.every((check) => check.ok),
		checks,
	};
}
