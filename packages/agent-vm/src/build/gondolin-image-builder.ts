import path from 'node:path';
import { fork } from 'node:child_process';
import type { Readable } from 'node:stream';

import {
	buildImage as buildImageFromCore,
	computeBuildFingerprint,
	type BuildConfig,
	type BuildImageOptions,
	type BuildImageResult,
} from '@agent-vm/gondolin-adapter';

import { loadSystemCacheIdentifier } from '../config/system-cache-identifier.js';
import { loadJsonConfigFile } from '../config/json-config-file.js';
import type { TaskOutput } from '../shared/run-task.js';
import { resolveRuntimeBuildVersionTag as resolveRuntimeBuildVersionTagDefault } from './runtime-versions.js';

export interface GondolinImageBuildRequest {
	readonly buildConfigPath: string;
	readonly systemCacheIdentifierPath: string;
	readonly cacheDir: string;
	readonly fullReset?: boolean;
}

export interface RunGondolinBuildChildProcessOptions {
	readonly childModuleUrl?: URL;
	readonly request: GondolinImageBuildRequest;
	readonly streamPreview: TaskOutput;
}

export interface GondolinImageBuilderDependencies {
	readonly buildImage?: (
		options: BuildImageOptions,
		dependencies?: { readonly gondolinVersion?: string },
	) => Promise<BuildImageResult>;
	readonly loadBuildConfig?: (buildConfigPath: string) => Promise<BuildConfig>;
	readonly runBuildChildProcess?: (
		options: RunGondolinBuildChildProcessOptions,
	) => Promise<BuildImageResult>;
	readonly resolveRuntimeBuildVersionTag?: () => Promise<string>;
}

interface GondolinBuildChildResultMessage {
	readonly result: BuildImageResult;
	readonly type: 'result';
}

interface GondolinBuildChildErrorMessage {
	readonly message: string;
	readonly stack?: string;
	readonly type: 'error';
}

type GondolinBuildChildMessage =
	| GondolinBuildChildErrorMessage
	| GondolinBuildChildResultMessage;

const CHILD_EXIT_GRACE_MS = 2_000;
const CHILD_STDERR_TAIL_BYTES = 16_384;

async function loadBuildConfigFromJson(buildConfigPath: string): Promise<BuildConfig> {
	try {
		return (await loadJsonConfigFile(buildConfigPath)) as BuildConfig;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
			throw new Error(`Failed to read build config '${buildConfigPath}': ${message}`, {
				cause: error,
			});
		}
		throw new Error(`Failed to parse build config '${buildConfigPath}': ${message}`, {
			cause: error,
		});
	}
}

export async function computeFingerprintFromConfigPath(
	buildConfigPath: string,
	systemCacheIdentifierPath: string,
	dependencies: Pick<GondolinImageBuilderDependencies, 'resolveRuntimeBuildVersionTag'> = {},
): Promise<string> {
	const buildConfig = await loadBuildConfigFromJson(buildConfigPath);
	const fingerprintInput = await loadSystemCacheIdentifier({ filePath: systemCacheIdentifierPath });
	const runtimeBuildVersionTag = await (
		dependencies.resolveRuntimeBuildVersionTag ?? resolveRuntimeBuildVersionTagDefault
	)();

	return computeBuildFingerprint(buildConfig, runtimeBuildVersionTag, fingerprintInput);
}

function isGondolinBuildChildMessage(value: unknown): value is GondolinBuildChildMessage {
	if (typeof value !== 'object' || value === null || !('type' in value)) {
		return false;
	}
	const message = value as { readonly type?: unknown };
	return message.type === 'result' || message.type === 'error';
}

function childProcessExecArgv(): readonly string[] {
	const filteredArgs: string[] = [];
	let skipNextArg = false;
	for (const arg of process.execArgv) {
		if (skipNextArg) {
			skipNextArg = false;
			continue;
		}
		if (arg === '--input-type') {
			skipNextArg = true;
			continue;
		}
		if (arg.startsWith('--input-type=')) {
			continue;
		}
		filteredArgs.push(arg);
	}
	return filteredArgs;
}

function appendStderrTail(currentTail: string, chunk: Buffer): string {
	const nextTail = `${currentTail}${chunk.toString('utf8')}`;
	if (Buffer.byteLength(nextTail, 'utf8') <= CHILD_STDERR_TAIL_BYTES) {
		return nextTail;
	}
	return nextTail.slice(-CHILD_STDERR_TAIL_BYTES);
}

function formatChildExitError(exitCode: number | null, signal: NodeJS.Signals | null, stderrTail: string): Error {
	const details = [`exitCode=${String(exitCode)}`, `signal=${String(signal)}`];
	const trimmedStderrTail = stderrTail.trim();
	if (trimmedStderrTail.length > 0) {
		details.push(`stderr tail:\n${trimmedStderrTail}`);
	}
	return new Error(`Gondolin build child process exited without a result: ${details.join(' ')}`);
}

function forwardChildStream(stream: Readable | null, output: TaskOutput, onChunk?: (chunk: Buffer) => void): void {
	stream?.on('data', (chunk: Buffer) => {
		onChunk?.(chunk);
		const canContinue = output.write(chunk);
		if (!canContinue) {
			stream.pause();
			process.nextTick(() => {
				stream.resume();
			});
		}
	});
}

export async function runGondolinImageBuildRequest(
	request: GondolinImageBuildRequest,
	dependencies: Omit<GondolinImageBuilderDependencies, 'runBuildChildProcess'> = {},
): Promise<BuildImageResult> {
	const loadBuildConfig = dependencies.loadBuildConfig ?? loadBuildConfigFromJson;
	const buildImage = dependencies.buildImage ?? buildImageFromCore;
	const configDir = path.dirname(path.resolve(request.buildConfigPath));
	const buildConfig = await loadBuildConfig(request.buildConfigPath);
	const fingerprintInput = await loadSystemCacheIdentifier({
		filePath: request.systemCacheIdentifierPath,
	});
	const runtimeBuildVersionTag = await (
		dependencies.resolveRuntimeBuildVersionTag ?? resolveRuntimeBuildVersionTagDefault
	)();

	return await buildImage(
		{
			buildConfig,
			cacheDir: request.cacheDir,
			configDir,
			fingerprintInput,
			...(request.fullReset ? { fullReset: true } : {}),
		},
		{
			gondolinVersion: runtimeBuildVersionTag,
		},
	);
}

export async function runGondolinBuildChildProcess(
	options: RunGondolinBuildChildProcessOptions,
): Promise<BuildImageResult> {
	return await new Promise<BuildImageResult>((resolve, reject) => {
		const childModuleUrl =
			options.childModuleUrl ??
			new URL('./gondolin-image-build-child-entrypoint.js', import.meta.url);
		const childProcess = fork(childModuleUrl, [], {
			execArgv: [...childProcessExecArgv()],
			stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
		});
		let childResult: BuildImageResult | undefined;
		let childError: Error | undefined;
		let settled = false;
		let stderrTail = '';
		let graceTimer: NodeJS.Timeout | undefined;

		const clearGraceTimer = (): void => {
			if (graceTimer) {
				clearTimeout(graceTimer);
				graceTimer = undefined;
			}
		};

		forwardChildStream(childProcess.stdout, options.streamPreview);
		forwardChildStream(childProcess.stderr, options.streamPreview, (chunk) => {
			stderrTail = appendStderrTail(stderrTail, chunk);
		});
		childProcess.on('message', (message: unknown) => {
			if (settled) {
				return;
			}
			if (!isGondolinBuildChildMessage(message)) {
				return;
			}
			if (message.type === 'result') {
				childResult = message.result;
				settled = true;
				resolve(message.result);
				graceTimer = setTimeout(() => {
					if (!childProcess.killed) {
						childProcess.kill();
					}
				}, CHILD_EXIT_GRACE_MS);
				return;
			}
			childError = new Error(message.message);
			if (message.stack) {
				childError.stack = message.stack;
			}
			settled = true;
			reject(childError);
		});
		childProcess.on('error', (error) => {
			if (settled) {
				return;
			}
			childError = error;
			settled = true;
			reject(error);
		});
		childProcess.on('close', (exitCode, signal) => {
			clearGraceTimer();
			if (settled) {
				return;
			}
			if (childResult) {
				resolve(childResult);
				return;
			}
			if (childError) {
				reject(childError);
				return;
			}
			reject(formatChildExitError(exitCode, signal, stderrTail));
		});
		childProcess.send({
			request: options.request,
			type: 'build-request',
		});
	});
}

export async function buildGondolinImage(
	options: {
		readonly buildConfigPath: string;
		readonly systemCacheIdentifierPath: string;
		readonly cacheDir: string;
		readonly fullReset?: boolean;
		readonly streamPreview?: TaskOutput;
	},
	dependencies: GondolinImageBuilderDependencies = {},
): Promise<BuildImageResult> {
	const request: GondolinImageBuildRequest = {
		buildConfigPath: options.buildConfigPath,
		cacheDir: options.cacheDir,
		systemCacheIdentifierPath: options.systemCacheIdentifierPath,
		...(options.fullReset ? { fullReset: true } : {}),
	};

	if (options.streamPreview) {
		const runBuildChildProcess =
			dependencies.runBuildChildProcess ?? runGondolinBuildChildProcess;
		return await runBuildChildProcess({ request, streamPreview: options.streamPreview });
	}

	return await runGondolinImageBuildRequest(request, dependencies);
}
