import path from 'node:path';
import { fork } from 'node:child_process';
import type { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadJsonConfigFile } from '../config/json-config-file.js';
import type { TaskOutput } from '../shared/run-task.js';
import {
	createManagedVmBackendImageBuildTooling,
	type ManagedGatewayImageBootProjection,
	type ManagedVmBackendImageBuildOptions,
	type ManagedVmBackendImageBuildResult,
} from './gondolin-managed-vm-build-tooling.js';
import { resolveRuntimeBuildVersionTag as resolveRuntimeBuildVersionTagDefault } from './runtime-versions.js';

type BuildImageResult = ManagedVmBackendImageBuildResult;
const defaultImageBuildTooling = createManagedVmBackendImageBuildTooling();

export interface ManagedVmImageBuildRequest {
	readonly buildConfigPath: string;
	readonly cacheDir: string;
	readonly fingerprintInput?: unknown;
	readonly fullReset?: boolean;
	readonly managedGatewayBoot?: ManagedGatewayImageBootProjection;
	readonly previewOutput?: boolean;
}

export interface RunManagedVmBuildChildProcessOptions {
	readonly childModuleUrl?: URL;
	readonly request: ManagedVmImageBuildRequest;
	readonly streamPreview: TaskOutput;
}

export interface ManagedVmImageBuilderDependencies {
	readonly buildImage?: (
		options: ManagedVmBackendImageBuildOptions,
		dependencies?: { readonly gondolinVersion?: string },
	) => Promise<BuildImageResult>;
	readonly loadBuildConfig?: (buildConfigPath: string) => Promise<unknown>;
	readonly runBuildChildProcess?: (
		options: RunManagedVmBuildChildProcessOptions,
	) => Promise<BuildImageResult>;
	readonly resolveRuntimeBuildVersionTag?: () => Promise<string>;
}

interface ComputeFingerprintFromConfigPathOptions {
	readonly fingerprintInput?: unknown;
	readonly managedGatewayBoot?: ManagedGatewayImageBootProjection;
}

interface ManagedVmBuildChildResultMessage {
	readonly result: BuildImageResult;
	readonly type: 'result';
}

interface ManagedVmBuildChildErrorMessage {
	readonly message: string;
	readonly stack?: string;
	readonly type: 'error';
}

type ManagedVmBuildChildMessage =
	| ManagedVmBuildChildErrorMessage
	| ManagedVmBuildChildResultMessage;

const CHILD_EXIT_GRACE_MS = 2_000;
const CHILD_STDERR_TAIL_BYTES = 16_384;
const silentTaskOutput: TaskOutput = {
	write: () => true,
};

function hasRuntimeBuildVersionDependency(
	optionsOrDependencies:
		| ComputeFingerprintFromConfigPathOptions
		| Pick<ManagedVmImageBuilderDependencies, 'resolveRuntimeBuildVersionTag'>,
): optionsOrDependencies is Pick<ManagedVmImageBuilderDependencies, 'resolveRuntimeBuildVersionTag'> {
	return 'resolveRuntimeBuildVersionTag' in optionsOrDependencies;
}

async function loadBuildConfigFromJson(buildConfigPath: string): Promise<unknown> {
	try {
		return await loadJsonConfigFile(buildConfigPath);
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
	optionsOrDependencies:
		| ComputeFingerprintFromConfigPathOptions
		| Pick<ManagedVmImageBuilderDependencies, 'resolveRuntimeBuildVersionTag'> = {},
	dependencies: Pick<ManagedVmImageBuilderDependencies, 'resolveRuntimeBuildVersionTag'> = {},
): Promise<string> {
	const options: ComputeFingerprintFromConfigPathOptions = hasRuntimeBuildVersionDependency(
		optionsOrDependencies,
	)
		? {}
		: optionsOrDependencies;
	const resolvedDependencies = hasRuntimeBuildVersionDependency(optionsOrDependencies)
		? optionsOrDependencies
		: dependencies;
	const buildConfig = await loadBuildConfigFromJson(buildConfigPath);
	const runtimeBuildVersionTag = await (
		resolvedDependencies.resolveRuntimeBuildVersionTag ?? resolveRuntimeBuildVersionTagDefault
	)();

	return await defaultImageBuildTooling.computeFingerprint({
		buildConfig,
		configDir: path.dirname(path.resolve(buildConfigPath)),
		...(options.fingerprintInput === undefined ? {} : { fingerprintInput: options.fingerprintInput }),
		gondolinVersion: runtimeBuildVersionTag,
		...(options.managedGatewayBoot === undefined
			? {}
			: { managedGatewayBoot: options.managedGatewayBoot }),
	});
}

function isManagedVmBuildChildMessage(value: unknown): value is ManagedVmBuildChildMessage {
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

function createProcessStderrOutput(): TaskOutput {
	const writeToStderr = process.stderr.write.bind(process.stderr);
	return {
		write: (chunk) => writeToStderr(chunk),
	};
}

export function resolveDefaultManagedVmBuildChildModuleUrl(moduleUrl: URL): URL {
	const modulePath = fileURLToPath(moduleUrl);
	const sourceBuildDirectory = `${path.sep}src${path.sep}build${path.sep}`;
	if (modulePath.includes(sourceBuildDirectory)) {
		const packageRootPath = path.resolve(path.dirname(modulePath), '..', '..');
		return pathToFileURL(
			path.join(packageRootPath, 'dist', 'build', 'gondolin-image-build-child-entrypoint.js'),
		);
	}
	return new URL('./gondolin-image-build-child-entrypoint.js', moduleUrl);
}

export async function runManagedVmImageBuildRequest(
	request: ManagedVmImageBuildRequest,
	dependencies: Omit<ManagedVmImageBuilderDependencies, 'runBuildChildProcess'> = {},
): Promise<BuildImageResult> {
	const loadBuildConfig = dependencies.loadBuildConfig ?? loadBuildConfigFromJson;
	const buildImage = dependencies.buildImage ?? defaultImageBuildTooling.buildImage;
	const configDir = path.dirname(path.resolve(request.buildConfigPath));
	const buildConfig = await loadBuildConfig(request.buildConfigPath);
	const runtimeBuildVersionTag = await (
		dependencies.resolveRuntimeBuildVersionTag ?? resolveRuntimeBuildVersionTagDefault
	)();

	return await buildImage(
		{
			buildConfig,
			cacheDir: request.cacheDir,
			configDir,
			...(request.fingerprintInput === undefined
				? {}
				: { fingerprintInput: request.fingerprintInput }),
			...(request.managedGatewayBoot === undefined
				? {}
				: { managedGatewayBoot: request.managedGatewayBoot }),
			...(request.fullReset ? { fullReset: true } : {}),
			...(request.previewOutput ? { output: createProcessStderrOutput() } : {}),
		},
		{
			gondolinVersion: runtimeBuildVersionTag,
		},
	);
}

export async function runManagedVmBuildChildProcess(
	options: RunManagedVmBuildChildProcessOptions,
): Promise<BuildImageResult> {
	return await new Promise<BuildImageResult>((resolve, reject) => {
		const childModuleUrl =
			options.childModuleUrl ??
			resolveDefaultManagedVmBuildChildModuleUrl(new URL(import.meta.url));
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
			if (!isManagedVmBuildChildMessage(message)) {
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

export async function buildManagedVmImage(
	options: {
		readonly buildConfigPath: string;
		readonly cacheDir: string;
		readonly fingerprintInput?: unknown;
		readonly fullReset?: boolean;
		readonly managedGatewayBoot?: ManagedGatewayImageBootProjection;
		readonly streamPreview?: TaskOutput;
	},
	dependencies: ManagedVmImageBuilderDependencies = {},
): Promise<BuildImageResult> {
	const request: ManagedVmImageBuildRequest = {
		buildConfigPath: options.buildConfigPath,
		cacheDir: options.cacheDir,
		...(options.fingerprintInput === undefined ? {} : { fingerprintInput: options.fingerprintInput }),
		...(options.fullReset ? { fullReset: true } : {}),
		...(options.managedGatewayBoot === undefined
			? {}
			: { managedGatewayBoot: options.managedGatewayBoot }),
		...(options.streamPreview ? { previewOutput: true } : {}),
	};

	if (options.streamPreview || dependencies.runBuildChildProcess) {
		const runBuildChildProcess =
			dependencies.runBuildChildProcess ?? runManagedVmBuildChildProcess;
		return await runBuildChildProcess({
			request,
			streamPreview: options.streamPreview ?? silentTaskOutput,
		});
	}

	if (Object.keys(dependencies).length === 0) {
		return await runManagedVmBuildChildProcess({
			request,
			streamPreview: silentTaskOutput,
		});
	}

	return await runManagedVmImageBuildRequest(request, dependencies);
}
