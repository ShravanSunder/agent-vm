import path from 'node:path';

import type { ManagedVmExecStreamingOptions } from '@agent-vm/managed-vm';
import { z } from 'zod/v4';

const ControllerRunnerArtifactExtractionRequestSchema = z
	.object({
		artifactId: z
			.string()
			.min(1)
			.max(128)
			.regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
	})
	.strict();

export type ControllerRunnerArtifactExtractionRequest = z.infer<
	typeof ControllerRunnerArtifactExtractionRequestSchema
>;

export interface ControllerRunnerArtifactExtractionPolicy {
	readonly allowedArtifactIds: readonly string[];
	readonly maxBytes: number;
	readonly readTimeoutMs: number;
	readonly runnerScratchRoot: string;
	readonly stockReaderExecutablePath: string;
}

export interface ControllerRunnerArtifactExtraction {
	readonly argv: readonly string[];
	readonly artifactId: string;
	readonly maxBytes: number;
	readonly output: ManagedVmExecStreamingOptions;
	readonly readTimeoutMs: number;
}

export interface CreateFixedControllerRunnerArtifactExtractionOptions {
	readonly controllerPolicy: ControllerRunnerArtifactExtractionPolicy;
	readonly request: unknown;
}

function requirePositiveSafeInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive safe integer.`);
	}
}

function requireFixedAbsolutePath(value: string, name: string): void {
	if (
		!path.posix.isAbsolute(value) ||
		value.includes('\0') ||
		value.length === 1 ||
		path.posix.normalize(value) !== value
	) {
		throw new Error(`${name} must be a fixed non-root absolute path.`);
	}
}

export function createFixedControllerRunnerArtifactExtraction(
	options: CreateFixedControllerRunnerArtifactExtractionOptions,
): ControllerRunnerArtifactExtraction {
	const parsedRequest = ControllerRunnerArtifactExtractionRequestSchema.safeParse(options.request);
	if (!parsedRequest.success) {
		throw new Error('Controller runner artifact request failed strict validation.');
	}
	const { controllerPolicy } = options;
	requirePositiveSafeInteger(controllerPolicy.maxBytes, 'artifact maxBytes');
	requirePositiveSafeInteger(controllerPolicy.readTimeoutMs, 'artifact readTimeoutMs');
	requireFixedAbsolutePath(controllerPolicy.runnerScratchRoot, 'runnerScratchRoot');
	requireFixedAbsolutePath(controllerPolicy.stockReaderExecutablePath, 'stockReaderExecutablePath');
	if (!controllerPolicy.allowedArtifactIds.includes(parsedRequest.data.artifactId)) {
		throw new Error(
			'Controller runner artifact identifier is not authorized by controller policy.',
		);
	}

	return {
		argv: [
			controllerPolicy.stockReaderExecutablePath,
			'--root',
			controllerPolicy.runnerScratchRoot,
			'--artifact-id',
			parsedRequest.data.artifactId,
		],
		artifactId: parsedRequest.data.artifactId,
		maxBytes: controllerPolicy.maxBytes,
		output: {
			stderr: { kind: 'discard' },
			stdout: { kind: 'pipe' },
			windowBytes: controllerPolicy.maxBytes,
		},
		readTimeoutMs: controllerPolicy.readTimeoutMs,
	};
}
