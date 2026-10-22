import { constants as fsConstants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod/v4';

import { credentialedRuntimeRecordSchema } from '../controller/credentialed-runtime/credentialed-runtime-record.js';
import {
	portalCompositionProgramPhaseFilename,
	portalCompositionProgramPhases,
} from './portal-composition-hermes-e2e-test-fixture.js';

const programPhaseSchema = z.object({ phase: z.enum(portalCompositionProgramPhases) });
type ProgramPhaseEvidence =
	| ({ readonly kind: 'present-valid' } & z.infer<typeof programPhaseSchema>)
	| { readonly kind: MissingFileState | 'no-tool-vm-workspace-request' };
type CredentialedRuntimeEvidence =
	| {
			readonly kind: 'present-valid';
			readonly state: z.infer<typeof credentialedRuntimeRecordSchema>['kind'];
			readonly generation: number;
			readonly updatedAtMs: number;
			readonly identityPresent: boolean;
			readonly startedAtMs?: number;
	  }
	| { readonly kind: MissingFileState | 'multiple-records' | 'not-configured' };

const maximumBodyBytes = 4096;
const maximumBodyChunks = 64;
const maximumFacts = 64;
const maximumCount = 1000;
const diagnosticDeadlineMilliseconds = 1000;

type ContentTypeClass = 'text/plain' | 'json' | 'other';
interface ResponseMetadata {
	readonly contentTypeClass: ContentTypeClass;
	readonly retainedBodyBytes: number;
}
export type PortalCompositionResponseFailure = ResponseMetadata &
	(
		| { readonly kind: 'gondolin-bad-gateway' }
		| {
				readonly kind: 'hermes-agent-incomplete';
				readonly completed: boolean;
				readonly partial: boolean;
				readonly failed: boolean;
		  }
		| { readonly kind: 'unknown' | 'truncated' | 'parse-failed' | 'read-failed' }
	);

const incompleteResponseSchema = z.object({
	error: z.object({
		code: z.literal('agent_incomplete'),
		hermes: z.object({ completed: z.boolean(), partial: z.boolean(), failed: z.boolean() }),
	}),
});
const boundedCounterSchema = z
	.number()
	.int()
	.nonnegative()
	.transform((count) => Math.min(count, maximumCount));
const modelProgressSchema = z.object({
	executeCodeToolCallsPrepared: boundedCounterSchema,
	finalResponseIssued: z.boolean(),
	firstExecuteCodeMarkerAccepted: z.boolean(),
	firstExecuteCodeResultObserved: z.boolean(),
	generatedTerminalToolCallsPrepared: boundedCounterSchema,
	generatedTerminalResultPresent: z.boolean(),
	promptedModelRequests: boundedCounterSchema,
	secondExecuteCodeResultPresent: z.boolean(),
});
const requestSchema = z.object({
	sessionLabel: z.string().max(256),
	mounts: z.object({ '/workspace': z.unknown().optional() }),
});
const workspaceSchema = z.object({
	kind: z.literal('owned-filtered-workspace'),
	directory: z.object({ identity: z.object({ canonicalPath: z.string().max(4096) }) }),
});
const originSchema = z.object({
	interpreter: z.string().max(256),
	hostSentinelVisible: z.boolean(),
});
const hostEffectSchema = z.object({ destination: z.string().max(256) });

async function withinDiagnosticDeadline<TResult>(
	operation: Promise<TResult>,
	fallback: TResult,
): Promise<TResult> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation.catch(() => fallback),
			new Promise<TResult>((resolve) => {
				timer = setTimeout(() => resolve(fallback), diagnosticDeadlineMilliseconds);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

function classifyContentType(value: string | null): ContentTypeClass {
	const mediaType = value?.split(';', 1)[0]?.trim().toLowerCase();
	if (mediaType === 'text/plain') return 'text/plain';
	return mediaType === 'application/json' ? 'json' : 'other';
}

function classifyBody(
	bytes: Buffer,
	contentTypeClass: ContentTypeClass,
): PortalCompositionResponseFailure {
	const metadata = { contentTypeClass, retainedBodyBytes: bytes.length };
	if (contentTypeClass === 'text/plain' && bytes.equals(Buffer.from('bad gateway\n'))) {
		return { ...metadata, kind: 'gondolin-bad-gateway' };
	}
	if (contentTypeClass !== 'json') return { ...metadata, kind: 'unknown' };
	let parsed: unknown;
	try {
		parsed = JSON.parse(bytes.toString('utf8'));
	} catch {
		return { ...metadata, kind: 'parse-failed' };
	}
	const incomplete = incompleteResponseSchema.safeParse(parsed);
	if (!incomplete.success) return { ...metadata, kind: 'unknown' };
	return { ...metadata, kind: 'hermes-agent-incomplete', ...incomplete.data.error.hermes };
}

/** Read a bounded failure prefix; cancellation must never hold the original HTTP error. */
export async function classifyPortalCompositionResponseFailure(
	response: Pick<Response, 'body' | 'headers'>,
): Promise<PortalCompositionResponseFailure> {
	let contentTypeClass: ContentTypeClass = 'other';
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let retainedBodyBytes = 0;
	try {
		contentTypeClass = classifyContentType(response.headers.get('content-type'));
		reader = response.body?.getReader();
		if (reader === undefined) return { contentTypeClass, retainedBodyBytes, kind: 'unknown' };
		const bodyReader = reader;
		const readPrefix = async (): Promise<PortalCompositionResponseFailure> => {
			const prefix = Buffer.alloc(maximumBodyBytes);
			for (let count = 0; count < maximumBodyChunks; count += 1) {
				// oxlint-disable-next-line no-await-in-loop -- one stream reader owns the bounded sequential prefix.
				const next = await bodyReader.read();
				if (next.done) return classifyBody(prefix.subarray(0, retainedBodyBytes), contentTypeClass);
				const remaining = maximumBodyBytes - retainedBodyBytes;
				const retained = next.value.subarray(0, remaining);
				prefix.set(retained, retainedBodyBytes);
				retainedBodyBytes += retained.length;
				if (next.value.byteLength > remaining) {
					return { contentTypeClass, retainedBodyBytes, kind: 'truncated' };
				}
			}
			return { contentTypeClass, retainedBodyBytes, kind: 'truncated' };
		};
		const evidence = await withinDiagnosticDeadline(readPrefix(), {
			contentTypeClass,
			retainedBodyBytes: 0,
			kind: 'read-failed',
		});
		return evidence.kind === 'read-failed' ? { ...evidence, retainedBodyBytes } : evidence;
	} catch {
		return { contentTypeClass, retainedBodyBytes, kind: 'read-failed' };
	} finally {
		// Do not await cancel: even the cancellation promise can remain pending.
		try {
			const cancellation = reader === undefined ? response.body?.cancel() : reader.cancel();
			void cancellation?.catch(() => undefined);
		} catch {
			// Failure observation never replaces the original turn error.
		}
	}
}

export async function reportPortalCompositionResponseFailure(response: Response): Promise<void> {
	try {
		const evidence = await classifyPortalCompositionResponseFailure(response);
		process.stderr.write('[portal-composition-http-failure] ' + JSON.stringify(evidence) + '\n');
	} catch {
		// Includes writer failures; the caller still throws its original HTTP error.
	}
}

export type PortalCompositionFileInput =
	| { readonly kind: 'content'; readonly text: string }
	| { readonly kind: 'absent' | 'read-failed' | 'truncated' };
export type PortalCompositionFileReader = (filename: string) => Promise<PortalCompositionFileInput>;
type MissingFileState = 'absent' | 'read-failed' | 'malformed';
interface DiagnosticPaths {
	readonly hostEffectPath: string;
	readonly concurrencyOrderPath: string;
	readonly lossOrderPath: string;
	readonly lossPidPath: string;
	readonly lossFastTimestampPath: string;
}
interface FailureFactsOptions {
	readonly paths: DiagnosticPaths;
	readonly modelProgress: () => unknown;
	readonly mcpCalls: readonly { readonly name: string }[];
	readonly vmRequests: readonly unknown[];
	readonly readFile?: PortalCompositionFileReader;
	readonly credentialedRuntimeDirectory?: string;
	readonly readDirectory?: (directory: string) => Promise<readonly string[]>;
}
type ModelEvidence =
	| { readonly kind: 'present-valid'; readonly progress: z.infer<typeof modelProgressSchema> }
	| { readonly kind: 'unavailable' | 'read-failed' };
type OriginEvidence =
	| {
			readonly kind: 'present-valid';
			readonly interpreterIsManaged: boolean;
			readonly hostSentinelVisible: boolean;
	  }
	| { readonly kind: MissingFileState | 'no-tool-vm-workspace-request' };
type HostEffectEvidence =
	| { readonly kind: 'present-valid'; readonly destinationControllerHost: boolean }
	| { readonly kind: MissingFileState };
interface OrderedEvidence {
	readonly kind: 'present' | MissingFileState;
	readonly tokens: readonly string[];
	readonly unknownCount: number;
	readonly collectionTruncated: boolean;
}
export interface PortalCompositionFailureFacts {
	readonly kind: 'phase-facts';
	readonly model: ModelEvidence;
	readonly mcp: {
		readonly names: readonly ('read_thing' | 'write_thing')[];
		readonly unknownCount: number;
		readonly collectionTruncated: boolean;
	};
	readonly vmRequests: {
		readonly toolVmWorkspace: number;
		readonly credentialedRuntime: number;
		readonly other: number;
		readonly collectionTruncated: boolean;
	};
	readonly origin: OriginEvidence;
	readonly programPhase: ProgramPhaseEvidence;
	readonly credentialedRuntime: CredentialedRuntimeEvidence;
	readonly hostEffect: HostEffectEvidence;
	readonly concurrencyOrder: OrderedEvidence;
	readonly lossOrder: OrderedEvidence;
	readonly lossPid: { readonly kind: 'present' | MissingFileState };
	readonly lossTimestamp: { readonly kind: 'present' | MissingFileState };
}

async function readFilePrefix(filename: string): Promise<PortalCompositionFileInput> {
	try {
		const file = await open(
			filename,
			fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
		);
		try {
			if (!(await file.stat()).isFile()) return { kind: 'read-failed' };
			const buffer = Buffer.alloc(maximumBodyBytes + 1);
			const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
			if (bytesRead > maximumBodyBytes) return { kind: 'truncated' };
			return { kind: 'content', text: buffer.subarray(0, bytesRead).toString('utf8') };
		} finally {
			await file.close();
		}
	} catch (error: unknown) {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
			return { kind: 'absent' };
		}
		return { kind: 'read-failed' };
	}
}

async function readBoundedFile(
	filename: string,
	readFile: PortalCompositionFileReader,
): Promise<PortalCompositionFileInput> {
	const input = await withinDiagnosticDeadline(
		Promise.resolve().then(() => readFile(filename)),
		{ kind: 'read-failed' },
	);
	if (input.kind === 'content' && Buffer.byteLength(input.text) > maximumBodyBytes) {
		return { kind: 'truncated' };
	}
	return input;
}

function missingFileKind(
	input: Exclude<PortalCompositionFileInput, { readonly kind: 'content' }>,
): MissingFileState {
	return input.kind === 'truncated' ? 'malformed' : input.kind;
}

function parseFile<TParsed>(
	input: PortalCompositionFileInput,
	schema: z.ZodType<TParsed>,
): { readonly kind: 'parsed'; readonly value: TParsed } | { readonly kind: MissingFileState } {
	if (input.kind !== 'content') return { kind: missingFileKind(input) };
	try {
		const parsed = schema.safeParse(JSON.parse(input.text));
		return parsed.success ? { kind: 'parsed', value: parsed.data } : { kind: 'malformed' };
	} catch {
		return { kind: 'malformed' };
	}
}

function projectOrder(
	input: PortalCompositionFileInput,
	allowed: readonly string[],
): OrderedEvidence {
	if (input.kind !== 'content') {
		return {
			kind: missingFileKind(input),
			tokens: [],
			unknownCount: 0,
			collectionTruncated: false,
		};
	}
	const lines = input.text.split(/\r?\n/u).filter((line) => line !== '');
	const tokens: string[] = [];
	let unknownCount = 0;
	for (const line of lines.slice(0, maximumFacts)) {
		if (allowed.includes(line)) tokens.push(line);
		else unknownCount += 1;
	}
	return {
		kind: 'present',
		tokens,
		unknownCount,
		collectionTruncated: lines.length > maximumFacts,
	};
}

function projectModel(readModel: () => unknown): ModelEvidence {
	try {
		const value = readModel();
		if (value === undefined) return { kind: 'unavailable' };
		const parsed = modelProgressSchema.safeParse(value);
		return parsed.success
			? { kind: 'present-valid', progress: parsed.data }
			: { kind: 'read-failed' };
	} catch {
		return { kind: 'read-failed' };
	}
}

function presence(input: PortalCompositionFileInput): {
	readonly kind: 'present' | MissingFileState;
} {
	return { kind: input.kind === 'content' || input.kind === 'truncated' ? 'present' : input.kind };
}

async function collectCredentialedRuntimeEvidence(
	options: FailureFactsOptions,
): Promise<CredentialedRuntimeEvidence> {
	const directory = options.credentialedRuntimeDirectory;
	if (directory === undefined) return { kind: 'not-configured' };
	if (!path.isAbsolute(directory) || path.normalize(directory) !== directory)
		return { kind: 'read-failed' };
	const collect = async (): Promise<CredentialedRuntimeEvidence> => {
		try {
			const names = await (options.readDirectory ?? readdir)(directory);
			if (names.length > maximumFacts) return { kind: 'malformed' };
			let filename: string | undefined;
			for (const name of names) {
				if (!/^credentialed-[a-f0-9]{64}\.json$/u.test(name)) continue;
				if (filename !== undefined) return { kind: 'multiple-records' };
				filename = name;
			}
			if (filename === undefined) return { kind: 'absent' };
			const input = await readBoundedFile(
				path.join(directory, filename),
				options.readFile ?? readFilePrefix,
			);
			const parsed = parseFile(input, credentialedRuntimeRecordSchema);
			if (parsed.kind !== 'parsed') return parsed;
			const record = parsed.value;
			return {
				kind: 'present-valid',
				state: record.kind,
				generation: record.generation,
				updatedAtMs: record.updatedAtMs,
				identityPresent: 'identity' in record && record.identity !== null,
				...('startedAtMs' in record ? { startedAtMs: record.startedAtMs } : {}),
			};
		} catch {
			return { kind: 'read-failed' };
		}
	};
	return await withinDiagnosticDeadline(collect(), { kind: 'read-failed' });
}

export async function collectPortalCompositionFailureFacts(
	options: FailureFactsOptions,
): Promise<PortalCompositionFailureFacts> {
	const model = projectModel(options.modelProgress);
	const mcpNames: ('read_thing' | 'write_thing')[] = [];
	let unknownMcpCount = 0;
	for (const call of options.mcpCalls.slice(0, maximumFacts)) {
		if (call.name === 'read_thing' || call.name === 'write_thing') mcpNames.push(call.name);
		else unknownMcpCount += 1;
	}
	let workspaceRoot: string | undefined;
	const vmCounts = { toolVmWorkspace: 0, credentialedRuntime: 0, other: 0 };
	for (const request of options.vmRequests.slice(0, maximumFacts)) {
		const parsed = requestSchema.safeParse(request);
		if (!parsed.success) {
			vmCounts.other += 1;
			continue;
		}
		const workspace = workspaceSchema.safeParse(parsed.data.mounts['/workspace']);
		if (parsed.data.sessionLabel.startsWith('credentialed-runtime-'))
			vmCounts.credentialedRuntime += 1;
		else if (workspace.success) {
			vmCounts.toolVmWorkspace += 1;
			const candidate = workspace.data.directory.identity.canonicalPath;
			if (path.isAbsolute(candidate) && path.normalize(candidate) === candidate)
				workspaceRoot ??= candidate;
		} else vmCounts.other += 1;
	}
	const reader = options.readFile ?? readFilePrefix;
	const [
		originInput,
		hostInput,
		concurrencyInput,
		lossInput,
		pidInput,
		timestampInput,
		phaseInput,
		credentialedRuntime,
	] = await Promise.all([
		workspaceRoot === undefined
			? Promise.resolve(undefined)
			: readBoundedFile(path.join(workspaceRoot, 'portal-composition-tool-vm-origin.json'), reader),
		readBoundedFile(options.paths.hostEffectPath, reader),
		readBoundedFile(options.paths.concurrencyOrderPath, reader),
		readBoundedFile(options.paths.lossOrderPath, reader),
		readBoundedFile(options.paths.lossPidPath, reader),
		readBoundedFile(options.paths.lossFastTimestampPath, reader),
		workspaceRoot === undefined
			? Promise.resolve(undefined)
			: readBoundedFile(path.join(workspaceRoot, portalCompositionProgramPhaseFilename), reader),
		collectCredentialedRuntimeEvidence(options),
	]);
	const origin = originInput === undefined ? undefined : parseFile(originInput, originSchema);
	const host = parseFile(hostInput, hostEffectSchema);
	const phase = phaseInput === undefined ? undefined : parseFile(phaseInput, programPhaseSchema);
	return {
		kind: 'phase-facts',
		model,
		mcp: {
			names: mcpNames,
			unknownCount: Math.min(unknownMcpCount, maximumCount),
			collectionTruncated: options.mcpCalls.length > maximumFacts,
		},
		vmRequests: { ...vmCounts, collectionTruncated: options.vmRequests.length > maximumFacts },
		origin:
			origin === undefined
				? { kind: vmCounts.toolVmWorkspace === 0 ? 'no-tool-vm-workspace-request' : 'read-failed' }
				: origin.kind === 'parsed'
					? {
							kind: 'present-valid',
							interpreterIsManaged: /^\/opt\/agent-vm-tools\/bin\/python(?:3(?:\.\d+)?)?$/u.test(
								origin.value.interpreter,
							),
							hostSentinelVisible: origin.value.hostSentinelVisible,
						}
					: origin,
		programPhase:
			phase === undefined
				? { kind: vmCounts.toolVmWorkspace === 0 ? 'no-tool-vm-workspace-request' : 'read-failed' }
				: phase.kind === 'parsed'
					? { kind: 'present-valid', ...phase.value }
					: phase,
		credentialedRuntime,
		hostEffect:
			host.kind === 'parsed'
				? {
						kind: 'present-valid',
						destinationControllerHost: host.value.destination === 'controller-host',
					}
				: host,
		concurrencyOrder: projectOrder(concurrencyInput, [
			'prepared',
			'slow-admitted',
			'fast-completed',
			'release-started',
			'slow-completed',
		]),
		lossOrder: projectOrder(lossInput, [
			'loss-prepared',
			'loss-admitted',
			'loss-fast',
			'loss-completed',
		]),
		lossPid: presence(pidInput),
		lossTimestamp: presence(timestampInput),
	};
}

function emitPortalCompositionFailureFacts(
	evidence: PortalCompositionFailureFacts | { readonly kind: 'diagnostic-read-failed' },
): void {
	process.stderr.write('[portal-composition-failure] ' + JSON.stringify(evidence) + '\n');
}

export async function rethrowPortalCompositionFailure(
	error: unknown,
	options: FailureFactsOptions & {
		readonly emit?: (
			evidence: PortalCompositionFailureFacts | { readonly kind: 'diagnostic-read-failed' },
		) => void;
	},
): Promise<never> {
	try {
		(options.emit ?? emitPortalCompositionFailureFacts)(
			await collectPortalCompositionFailureFacts(options),
		);
	} catch {
		try {
			(options.emit ?? emitPortalCompositionFailureFacts)({ kind: 'diagnostic-read-failed' });
		} catch {
			// Preserve the exact original error even when observation or output fails.
		}
	}
	throw error;
}
