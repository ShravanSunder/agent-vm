import { spawn } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { LoadedSystemConfig } from '../config/system-config.js';
import {
	createObservabilityComposeModel,
	renderObservabilityComposeYaml,
} from './observability-compose.js';
import {
	createObservabilityRuntimeConfig,
	type ManagedObservabilityRuntimeConfig,
} from './observability-config.js';
import { checkObservabilityStackReadiness } from './observability-readiness.js';
import {
	createOtelCollectorConfigModel,
	renderOtelCollectorConfigYaml,
} from './otel-collector-config.js';

export interface PrepareObservabilityStackOptions {
	readonly config: ManagedObservabilityRuntimeConfig;
	readonly checkReadiness?: typeof checkObservabilityStackReadiness;
	readonly runCompose?: typeof runDockerCompose;
	readonly wait: boolean;
}

export interface PrepareObservabilityStackResult {
	readonly composePath: string;
	readonly collectorConfigPath: string;
	readonly status: 'started' | 'ready';
}

const OBSERVABILITY_DIRECTORY_MODE = 0o700;
const OBSERVABILITY_FILE_MODE = 0o600;

function formatUnknownError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function createObservabilityComposeStartupError(error: unknown): Error {
	return new Error(
		`Host observability Docker Compose startup failed. Ensure Docker Compose is installed and running, or rerun agent-vm build with --no-observability to skip this build run. Cause: ${formatUnknownError(error)}`,
		{ cause: error },
	);
}

export async function writeObservabilityArtifacts(
	config: ManagedObservabilityRuntimeConfig,
): Promise<{
	readonly composePath: string;
	readonly collectorConfigPath: string;
}> {
	const directoryPaths = [
		config.runtimeDir,
		config.dataDir,
		path.join(config.dataDir, 'metrics'),
		path.join(config.dataDir, 'logs'),
		path.join(config.dataDir, 'traces'),
	];
	await Promise.all(
		directoryPaths.map(async (directoryPath) => {
			await mkdir(directoryPath, { mode: OBSERVABILITY_DIRECTORY_MODE, recursive: true });
			await chmod(directoryPath, OBSERVABILITY_DIRECTORY_MODE);
		}),
	);

	const composePath = path.join(config.runtimeDir, 'docker-compose.observability.yml');
	const collectorConfigPath = path.join(config.runtimeDir, 'otel-collector-config.yaml');
	await Promise.all([
		writeFile(
			composePath,
			renderObservabilityComposeYaml(createObservabilityComposeModel(config)),
			{ encoding: 'utf8', mode: OBSERVABILITY_FILE_MODE },
		),
		writeFile(
			collectorConfigPath,
			renderOtelCollectorConfigYaml(createOtelCollectorConfigModel(config)),
			{ encoding: 'utf8', mode: OBSERVABILITY_FILE_MODE },
		),
	]);
	await Promise.all([
		chmod(composePath, OBSERVABILITY_FILE_MODE),
		chmod(collectorConfigPath, OBSERVABILITY_FILE_MODE),
	]);
	return { composePath, collectorConfigPath };
}

function runDockerCompose(options: {
	readonly composePath: string;
	readonly projectName: string;
	readonly wait: boolean;
}): Promise<void> {
	const args = [
		'compose',
		'--project-name',
		options.projectName,
		'--file',
		options.composePath,
		'up',
		'-d',
		...(options.wait ? ['--wait'] : []),
	];
	return new Promise((resolve, reject) => {
		const childProcess = spawn('docker', args, { stdio: 'inherit' });
		childProcess.once('error', reject);
		childProcess.once('exit', (exitCode) => {
			if (exitCode === 0) {
				resolve();
				return;
			}
			reject(new Error(`docker ${args.join(' ')} exited with code ${String(exitCode)}.`));
		});
	});
}

export async function prepareObservabilityStack(
	options: PrepareObservabilityStackOptions,
): Promise<PrepareObservabilityStackResult> {
	const artifacts = await writeObservabilityArtifacts(options.config);
	try {
		await (options.runCompose ?? runDockerCompose)({
			composePath: artifacts.composePath,
			projectName: options.config.projectName,
			wait: options.wait,
		});
	} catch (error) {
		throw createObservabilityComposeStartupError(error);
	}
	if (options.wait) {
		const readinessResult = await (options.checkReadiness ?? checkObservabilityStackReadiness)({
			config: options.config,
		});
		if (!readinessResult.ok) {
			throw new Error(`Host observability stack is not ready: ${readinessResult.reason}`);
		}
	}
	return {
		...artifacts,
		status: options.wait ? 'ready' : 'started',
	};
}

export function resolveBuildObservabilityConfig(
	systemConfig: LoadedSystemConfig,
): ManagedObservabilityRuntimeConfig | undefined {
	const observabilityConfig = createObservabilityRuntimeConfig(systemConfig);
	if (!observabilityConfig.enabled) {
		return undefined;
	}
	if (observabilityConfig.stackMode !== 'managed') {
		return undefined;
	}
	if (!observabilityConfig.prepareOnBuild || observabilityConfig.zones.length === 0) {
		return undefined;
	}
	return observabilityConfig;
}
