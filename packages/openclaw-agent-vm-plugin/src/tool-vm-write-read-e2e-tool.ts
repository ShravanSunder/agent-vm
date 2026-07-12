import { createHmac, timingSafeEqual } from 'node:crypto';

import {
	AGENT_VM_E2E_CONTROL_ADMISSION_PRESSURE_ENV,
	GATEWAY_CONTROL_ADMISSION_PRESSURE_BATCH_LIMIT,
	getGatewayControlAdmissionPressureE2eActuator,
} from './gateway-control-service/gateway-control-admission-pressure-e2e-testing.js';
import type {
	OpenClawHttpRouteRegistrationApi,
	OpenClawPluginToolContext,
} from './openclaw-sandbox-sdk-contract.js';
import type { createAgentVmSandboxBackendFactory } from './sandbox-backend-factory.js';

export const AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_ENV = 'AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE';
export const AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_KEY_ENV =
	'AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_KEY';
export const AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_IDENTITIES_ENV =
	'AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_IDENTITIES';
export const AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_PATH = '/__agent-vm/e2e/tool-vm-write-read';
export const AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_SIGNATURE_HEADER =
	'x-agent-vm-e2e-tool-vm-write-read-signature';
const maxRouteBodyBytes = 16 * 1024;
const maxConfiguredProbeIdentities = 4;
const proofFilePathPrefix = '.agent-vm/';

type AgentVmSandboxBackendFactory = ReturnType<typeof createAgentVmSandboxBackendFactory>;
type AgentVmSandboxBackendFactoryProvider = () => Promise<AgentVmSandboxBackendFactory>;
type AgentVmSandboxBackendHandle = Awaited<ReturnType<AgentVmSandboxBackendFactory>>;

interface ConfiguredToolVmWriteReadE2eProbeIdentity {
	readonly agentId: string;
	readonly sessionKey: string;
}

type ToolVmWriteReadE2eRouteParams =
	| {
			readonly agentId: string;
			readonly filePath: string;
			readonly marker: string;
			readonly scenario: 'active-operation-containment';
			readonly sentinelFilePath: string;
			readonly sessionKey: string;
	  }
	| {
			readonly agentId: string;
			readonly filePath: string;
			readonly marker: string;
			readonly scenario: 'write-read';
			readonly sessionKey: string;
	  }
	| {
			readonly agentId: string;
			readonly filePath: string;
			readonly marker: string;
			readonly scenario: 'stale-reacquire';
			readonly secondFilePath: string;
			readonly secondMarker: string;
			readonly sessionKey: string;
	  };

type ControlAdmissionPressureRouteParams =
	| {
			readonly action: 'snapshot';
			readonly attachmentGeneration: number;
			readonly scenario: 'control-admission-pressure';
	  }
	| {
			readonly action: 'hold';
			readonly attachmentGeneration: number;
			readonly direction: 'egress' | 'ingress';
			readonly messageClass: 'diagnostic' | 'liveness';
			readonly scenario: 'control-admission-pressure';
	  }
	| {
			readonly action: 'submitBatch';
			readonly attachmentGeneration: number;
			readonly batchSize: number;
			readonly byteLength: number;
			readonly coalesceKeyPrefix: string;
			readonly direction: 'egress' | 'ingress';
			readonly messageClass: 'diagnostic' | 'liveness';
			readonly scenario: 'control-admission-pressure';
	  }
	| {
			readonly action: 'release';
			readonly attachmentGeneration: number;
			readonly holdId: string;
			readonly scenario: 'control-admission-pressure';
	  };

interface ToolVmWriteReadE2eProbeStepDetails {
	readonly filePath: string;
	readonly marker: string;
	readonly readBack: string;
	readonly runtimeId: string;
}

interface ToolVmWriteReadE2eProbeDetails {
	readonly agentId: string;
	readonly filePath: string;
	readonly marker: string;
	readonly readBack: string;
	readonly runtimeId: string;
	readonly sessionKey: string;
	readonly status: 'ok';
	readonly workdir: string;
}

interface ToolVmStaleReacquireE2eProbeDetails {
	readonly agentId: string;
	readonly first: ToolVmWriteReadE2eProbeStepDetails;
	readonly newRuntimeId: string;
	readonly oldRuntimeId: string;
	readonly scenario: 'stale-reacquire';
	readonly second: ToolVmWriteReadE2eProbeStepDetails;
	readonly sameHandle: true;
	readonly sessionKey: string;
	readonly staleTrigger: 'ssh-command-reset';
	readonly status: 'ok';
	readonly workdir: string;
}

function isObjectRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function shellSingleQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function requireContextString(value: string | undefined, fieldName: string): string {
	if (value === undefined || value.length === 0) {
		throw new Error(`tool-vm-write-read-e2e: OpenClaw did not provide ${fieldName}.`);
	}
	return value;
}

class ToolVmWriteReadE2eRouteError extends Error {
	readonly statusCode: number;

	constructor(message: string, statusCode: number) {
		super(message);
		this.name = 'ToolVmWriteReadE2eRouteError';
		this.statusCode = statusCode;
	}
}

function signToolVmWriteReadE2eRouteBody(bodyText: string, key: string): string {
	return createHmac('sha256', key).update(bodyText, 'utf8').digest('base64url');
}

function verifyToolVmWriteReadE2eRouteBody(options: {
	readonly bodyText: string;
	readonly key: string;
	readonly signature: string | undefined;
}): void {
	if (options.signature === undefined || options.signature.length === 0) {
		throw new ToolVmWriteReadE2eRouteError('tool-vm-write-read-e2e: missing proof signature.', 401);
	}
	const expectedSignature = signToolVmWriteReadE2eRouteBody(options.bodyText, options.key);
	const expected = Buffer.from(expectedSignature, 'utf8');
	const received = Buffer.from(options.signature, 'utf8');
	if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
		throw new ToolVmWriteReadE2eRouteError('tool-vm-write-read-e2e: invalid proof signature.', 403);
	}
}

function resolveProbeAgentIdFromSessionKey(sessionKey: string): string {
	const match = /^agent:([^:]+):/u.exec(sessionKey);
	if (match?.[1] === undefined || match[1].length === 0) {
		throw new ToolVmWriteReadE2eRouteError(
			'tool-vm-write-read-e2e: sessionKey must encode an agent id.',
			400,
		);
	}
	return match[1];
}

function readConfiguredProbeIdentitiesFromEnv(): readonly ConfiguredToolVmWriteReadE2eProbeIdentity[] {
	const serializedIdentities = process.env[AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_IDENTITIES_ENV];
	if (serializedIdentities === undefined || serializedIdentities.length === 0) {
		throw new Error(
			`tool-vm-write-read-e2e: ${AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_IDENTITIES_ENV} is required.`,
		);
	}
	let untrustedIdentities: unknown;
	try {
		untrustedIdentities = JSON.parse(serializedIdentities);
	} catch {
		throw new Error('tool-vm-write-read-e2e: configured identity set must be valid JSON.');
	}
	if (
		!Array.isArray(untrustedIdentities) ||
		untrustedIdentities.length < 1 ||
		untrustedIdentities.length > maxConfiguredProbeIdentities
	) {
		throw new Error(
			`tool-vm-write-read-e2e: configured identity set must contain between 1 and ${String(maxConfiguredProbeIdentities)} entries.`,
		);
	}
	const identities: ConfiguredToolVmWriteReadE2eProbeIdentity[] = [];
	const identityTuples = new Set<string>();
	for (const [identityIndex, untrustedIdentity] of untrustedIdentities.entries()) {
		if (
			!isObjectRecord(untrustedIdentity) ||
			Object.keys(untrustedIdentity).toSorted().join(',') !== 'agentId,sessionKey' ||
			typeof untrustedIdentity.agentId !== 'string' ||
			untrustedIdentity.agentId.length === 0 ||
			typeof untrustedIdentity.sessionKey !== 'string' ||
			untrustedIdentity.sessionKey.length === 0
		) {
			throw new Error(
				`tool-vm-write-read-e2e: configured identity set entry ${String(identityIndex)} must contain only non-empty agentId and sessionKey strings.`,
			);
		}
		if (
			resolveProbeAgentIdFromSessionKey(untrustedIdentity.sessionKey) !== untrustedIdentity.agentId
		) {
			throw new Error(
				'tool-vm-write-read-e2e: configured probe session key does not match configured agent id.',
			);
		}
		const identityTuple = `${untrustedIdentity.agentId}\0${untrustedIdentity.sessionKey}`;
		if (identityTuples.has(identityTuple)) {
			throw new Error(
				'tool-vm-write-read-e2e: configured identity set contains a duplicate tuple.',
			);
		}
		identityTuples.add(identityTuple);
		identities.push({
			agentId: untrustedIdentity.agentId,
			sessionKey: untrustedIdentity.sessionKey,
		});
	}
	return identities;
}

function normalizeProofFilePath(filePath: string, fieldName = 'filePath'): string {
	if (
		filePath.startsWith('/') ||
		filePath.includes('\0') ||
		filePath.split('/').some((segment) => segment === '..') ||
		!filePath.startsWith(proofFilePathPrefix)
	) {
		throw new ToolVmWriteReadE2eRouteError(
			`tool-vm-write-read-e2e: ${fieldName} must stay under ${proofFilePathPrefix}.`,
			400,
		);
	}
	return filePath;
}

function readProbeParams(params: unknown): {
	readonly filePath: string;
	readonly marker: string;
} {
	if (!isObjectRecord(params)) {
		throw new Error('tool-vm-write-read-e2e: request body must be an object.');
	}
	return readProbeStepParams({
		filePathField: 'filePath',
		markerField: 'marker',
		params,
	});
}

function readProbeStepParams(options: {
	readonly filePathField: 'filePath' | 'secondFilePath';
	readonly markerField: 'marker' | 'secondMarker';
	readonly params: Readonly<Record<string, unknown>>;
}): {
	readonly filePath: string;
	readonly marker: string;
} {
	const marker = options.params[options.markerField];
	if (typeof marker !== 'string' || marker.length === 0) {
		throw new Error(`tool-vm-write-read-e2e: ${options.markerField} is required.`);
	}
	const filePath = options.params[options.filePathField];
	if (filePath !== undefined && typeof filePath !== 'string') {
		throw new Error(
			`tool-vm-write-read-e2e: ${options.filePathField} must be a string when provided.`,
		);
	}
	return {
		filePath:
			filePath === undefined || filePath.length === 0
				? `.agent-vm/e2e-tool-vm-write-read-${Date.now().toString(36)}.txt`
				: normalizeProofFilePath(filePath),
		marker,
	};
}

function readRouteParams(
	params: unknown,
	probeIdentities: readonly ConfiguredToolVmWriteReadE2eProbeIdentity[],
): ToolVmWriteReadE2eRouteParams {
	if (!isObjectRecord(params)) {
		throw new Error('tool-vm-write-read-e2e: request body must be an object.');
	}
	if (params.sessionKey !== undefined && typeof params.sessionKey !== 'string') {
		throw new Error('tool-vm-write-read-e2e: sessionKey must be a string when provided.');
	}
	if (params.agentId !== undefined && typeof params.agentId !== 'string') {
		throw new Error('tool-vm-write-read-e2e: agentId must be a string when provided.');
	}
	const probeParams = readProbeParams(params);
	const probeIdentity = resolveConfiguredProbeIdentity(params, probeIdentities);
	const scenario = params.scenario === undefined ? 'write-read' : params.scenario;
	if (
		scenario !== 'write-read' &&
		scenario !== 'stale-reacquire' &&
		scenario !== 'active-operation-containment'
	) {
		throw new ToolVmWriteReadE2eRouteError(
			'tool-vm-write-read-e2e: scenario must be write-read, stale-reacquire, active-operation-containment, or control-admission-pressure.',
			400,
		);
	}
	if (scenario === 'write-read') {
		return {
			agentId: probeIdentity.agentId,
			filePath: probeParams.filePath,
			marker: probeParams.marker,
			scenario,
			sessionKey: probeIdentity.sessionKey,
		};
	}
	if (scenario === 'active-operation-containment') {
		if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(probeParams.marker)) {
			throw new ToolVmWriteReadE2eRouteError(
				'tool-vm-write-read-e2e: active-operation marker must be a bounded token.',
				400,
			);
		}
		if (typeof params.sentinelFilePath !== 'string' || params.sentinelFilePath.length === 0) {
			throw new ToolVmWriteReadE2eRouteError(
				'tool-vm-write-read-e2e: sentinelFilePath is required for active-operation-containment.',
				400,
			);
		}
		const sentinelFilePath = normalizeProofFilePath(params.sentinelFilePath, 'sentinelFilePath');
		if (sentinelFilePath === probeParams.filePath) {
			throw new ToolVmWriteReadE2eRouteError(
				'tool-vm-write-read-e2e: sentinelFilePath must differ from filePath.',
				400,
			);
		}
		return {
			agentId: probeIdentity.agentId,
			filePath: probeParams.filePath,
			marker: probeParams.marker,
			scenario,
			sentinelFilePath,
			sessionKey: probeIdentity.sessionKey,
		};
	}
	const secondProbeParams = readProbeStepParams({
		filePathField: 'secondFilePath',
		markerField: 'secondMarker',
		params,
	});
	return {
		agentId: probeIdentity.agentId,
		filePath: probeParams.filePath,
		marker: probeParams.marker,
		scenario,
		secondFilePath: secondProbeParams.filePath,
		secondMarker: secondProbeParams.marker,
		sessionKey: probeIdentity.sessionKey,
	};
}

function resolveConfiguredProbeIdentity(
	params: Readonly<Record<string, unknown>>,
	probeIdentities: readonly ConfiguredToolVmWriteReadE2eProbeIdentity[],
): ConfiguredToolVmWriteReadE2eProbeIdentity {
	let probeIdentity: ConfiguredToolVmWriteReadE2eProbeIdentity | undefined;
	if (
		params.agentId === undefined &&
		params.sessionKey === undefined &&
		probeIdentities.length === 1
	) {
		probeIdentity = probeIdentities[0];
	} else if (typeof params.agentId === 'string' && typeof params.sessionKey === 'string') {
		if (params.agentId !== resolveProbeAgentIdFromSessionKey(params.sessionKey)) {
			throw new ToolVmWriteReadE2eRouteError(
				'tool-vm-write-read-e2e: body agentId does not match sessionKey agent.',
				403,
			);
		}
		probeIdentity = probeIdentities.find(
			(candidate) =>
				candidate.agentId === params.agentId && candidate.sessionKey === params.sessionKey,
		);
	}
	if (probeIdentity === undefined) {
		throw new ToolVmWriteReadE2eRouteError(
			'tool-vm-write-read-e2e: request identity does not match the configured probe identity set.',
			403,
		);
	}
	return probeIdentity;
}

function requireControlAdmissionPressureInteger(
	params: Readonly<Record<string, unknown>>,
	fieldName: 'attachmentGeneration' | 'batchSize' | 'byteLength',
): number {
	const value = params[fieldName];
	if (!Number.isSafeInteger(value) || typeof value !== 'number' || value <= 0) {
		throw new ToolVmWriteReadE2eRouteError(
			`tool-vm-write-read-e2e: ${fieldName} must be a positive safe integer.`,
			400,
		);
	}
	return value;
}

function readControlAdmissionPressureRouteParams(
	params: Readonly<Record<string, unknown>>,
	probeIdentities: readonly ConfiguredToolVmWriteReadE2eProbeIdentity[],
): ControlAdmissionPressureRouteParams {
	resolveConfiguredProbeIdentity(params, probeIdentities);
	if (process.env[AGENT_VM_E2E_CONTROL_ADMISSION_PRESSURE_ENV] !== '1') {
		throw new ToolVmWriteReadE2eRouteError(
			'tool-vm-write-read-e2e: control admission pressure probe is disabled.',
			404,
		);
	}
	const attachmentGeneration = requireControlAdmissionPressureInteger(
		params,
		'attachmentGeneration',
	);
	if (params.action === 'snapshot') {
		return { action: 'snapshot', attachmentGeneration, scenario: 'control-admission-pressure' };
	}
	if (params.action === 'release') {
		if (typeof params.holdId !== 'string' || params.holdId.length === 0) {
			throw new ToolVmWriteReadE2eRouteError(
				'tool-vm-write-read-e2e: holdId is required for control admission release.',
				400,
			);
		}
		return {
			action: 'release',
			attachmentGeneration,
			holdId: params.holdId,
			scenario: 'control-admission-pressure',
		};
	}
	if (params.action !== 'hold' && params.action !== 'submitBatch') {
		throw new ToolVmWriteReadE2eRouteError(
			'tool-vm-write-read-e2e: control admission action must be snapshot, hold, submitBatch, or release.',
			400,
		);
	}
	if (params.direction !== 'egress' && params.direction !== 'ingress') {
		throw new ToolVmWriteReadE2eRouteError(
			'tool-vm-write-read-e2e: control admission direction must be egress or ingress.',
			400,
		);
	}
	if (params.messageClass !== 'diagnostic' && params.messageClass !== 'liveness') {
		throw new ToolVmWriteReadE2eRouteError(
			'tool-vm-write-read-e2e: control admission messageClass must be diagnostic or liveness.',
			400,
		);
	}
	if (params.action === 'hold') {
		return {
			action: 'hold',
			attachmentGeneration,
			direction: params.direction,
			messageClass: params.messageClass,
			scenario: 'control-admission-pressure',
		};
	}
	const batchSize = requireControlAdmissionPressureInteger(params, 'batchSize');
	if (batchSize > GATEWAY_CONTROL_ADMISSION_PRESSURE_BATCH_LIMIT) {
		throw new ToolVmWriteReadE2eRouteError(
			`tool-vm-write-read-e2e: batchSize must not exceed ${String(GATEWAY_CONTROL_ADMISSION_PRESSURE_BATCH_LIMIT)}.`,
			400,
		);
	}
	const byteLength = requireControlAdmissionPressureInteger(params, 'byteLength');
	if (typeof params.coalesceKeyPrefix !== 'string' || params.coalesceKeyPrefix.length === 0) {
		throw new ToolVmWriteReadE2eRouteError(
			'tool-vm-write-read-e2e: coalesceKeyPrefix is required for control admission batch.',
			400,
		);
	}
	return {
		action: 'submitBatch',
		attachmentGeneration,
		batchSize,
		byteLength,
		coalesceKeyPrefix: params.coalesceKeyPrefix,
		direction: params.direction,
		messageClass: params.messageClass,
		scenario: 'control-admission-pressure',
	};
}

async function runControlAdmissionPressureAction(
	params: ControlAdmissionPressureRouteParams,
): Promise<unknown> {
	const actuator = getGatewayControlAdmissionPressureE2eActuator();
	if (actuator === undefined) {
		throw new ToolVmWriteReadE2eRouteError(
			'tool-vm-write-read-e2e: control admission pressure actuator is unavailable.',
			503,
		);
	}
	try {
		switch (params.action) {
			case 'snapshot':
				return actuator.snapshot(params.attachmentGeneration);
			case 'hold':
				return await actuator.hold(params);
			case 'submitBatch':
				return await actuator.submitBatch(params);
			case 'release':
				await actuator.release(params);
				return { released: true };
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new ToolVmWriteReadE2eRouteError(message, message.includes('stale') ? 409 : 500);
	}
}

async function readRequestBodyText(request: AsyncIterable<Buffer | string>): Promise<string> {
	const chunks: Buffer[] = [];
	let byteLength = 0;
	for await (const chunk of request) {
		const chunkBuffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
		byteLength += chunkBuffer.byteLength;
		if (byteLength > maxRouteBodyBytes) {
			throw new ToolVmWriteReadE2eRouteError(
				'tool-vm-write-read-e2e: request body too large.',
				413,
			);
		}
		chunks.push(chunkBuffer);
	}
	return Buffer.concat(chunks).toString('utf8');
}

function readHeaderValue(
	headers: Readonly<Record<string, string | readonly string[] | undefined>>,
	headerName: string,
): string | undefined {
	const value = headers[headerName];
	if (typeof value === 'string') {
		return value;
	}
	if (!isReadonlyStringArray(value)) {
		return undefined;
	}
	const firstValue: string | undefined = value[0];
	return typeof firstValue === 'string' ? firstValue : undefined;
}

function isReadonlyStringArray(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

async function runToolVmWriteReadE2eProbe(options: {
	readonly context: OpenClawPluginToolContext;
	readonly factoryProvider: AgentVmSandboxBackendFactoryProvider;
	readonly params: {
		readonly filePath: string;
		readonly marker: string;
	};
}): Promise<ToolVmWriteReadE2eProbeDetails> {
	const backendContext = await createToolVmWriteReadE2eBackend({
		context: options.context,
		factoryProvider: options.factoryProvider,
	});
	const step = await runToolVmWriteReadE2eProbeStep({
		backend: backendContext.backend,
		params: options.params,
	});
	return {
		agentId: backendContext.agentId,
		filePath: step.filePath,
		marker: step.marker,
		readBack: step.readBack,
		runtimeId: backendContext.backend.runtimeId,
		sessionKey: backendContext.sessionKey,
		status: 'ok',
		workdir: backendContext.backend.workdir,
	};
}

async function createToolVmWriteReadE2eBackend(options: {
	readonly context: OpenClawPluginToolContext;
	readonly factoryProvider: AgentVmSandboxBackendFactoryProvider;
}): Promise<{
	readonly agentId: string;
	readonly backend: AgentVmSandboxBackendHandle;
	readonly sessionKey: string;
}> {
	const agentId = requireContextString(options.context.agentId, 'agentId');
	const sessionKey =
		options.context.sessionKey === undefined || options.context.sessionKey.length === 0
			? `agent:${agentId}:tool-vm-write-read:${Date.now().toString(36)}`
			: options.context.sessionKey;
	const agentWorkspaceDir =
		options.context.agentDir ?? options.context.workspaceDir ?? `/zone/agents/${agentId}`;
	const workspaceDir = options.context.workspaceDir ?? agentWorkspaceDir;
	const factory = await options.factoryProvider();
	const backend = await factory({
		agentWorkspaceDir,
		cfg: {
			backend: 'gondolin',
			mode: 'all',
			scope: 'agent',
			workspaceAccess: 'rw',
		},
		scopeKey: sessionKey,
		sessionKey,
		workspaceDir,
	});
	return { agentId, backend, sessionKey };
}

async function runToolVmWriteReadE2eProbeStep(options: {
	readonly backend: AgentVmSandboxBackendHandle;
	readonly params: {
		readonly filePath: string;
		readonly marker: string;
	};
}): Promise<ToolVmWriteReadE2eProbeStepDetails> {
	const commandResult = await options.backend.runShellCommand({
		script: [
			'set -eu',
			`proof_file=${shellSingleQuote(options.params.filePath)}`,
			`proof_marker=${shellSingleQuote(options.params.marker)}`,
			'mkdir -p "$(dirname "$proof_file")"',
			'printf "%s" "$proof_marker" >"$proof_file"',
			'cat "$proof_file"',
		].join('\n'),
	});
	const readBack = commandResult.stdout.toString('utf8');
	if (commandResult.code !== 0) {
		throw new Error(
			`tool-vm-write-read-e2e: command failed with ${String(commandResult.code)}: ${commandResult.stderr.toString('utf8')}`,
		);
	}
	return {
		filePath: options.params.filePath,
		marker: options.params.marker,
		readBack,
		runtimeId: options.backend.runtimeId,
	};
}

function buildActiveOperationContainmentScript(params: {
	readonly filePath: string;
	readonly marker: string;
	readonly sentinelFilePath: string;
	readonly workspaceDirectory: string;
}): string {
	const workspaceDirectory = params.workspaceDirectory.replace(/\/$/u, '');
	return [
		'set -eu',
		'umask 077',
		`proof_file=${shellSingleQuote(`${workspaceDirectory}/${params.filePath}`)}`,
		`proof_marker=${shellSingleQuote(params.marker)}`,
		`sentinel_file=${shellSingleQuote(`${workspaceDirectory}/${params.sentinelFilePath}`)}`,
		'sentinel_temp_file="${sentinel_file}.tmp.$$"',
		'mkdir -p "$(dirname "$proof_file")" "$(dirname "$sentinel_file")"',
		'if [ -f "$proof_file" ] && grep -Fqx -- "$proof_marker" "$proof_file"; then',
		'  printf "%s\\n" "agent-vm-e2e-active-operation: marker replay refused" >&2',
		'  exit 91',
		'fi',
		'test ! -e "$sentinel_file"',
		'printf "%s\\n" "$proof_marker" >>"$proof_file"',
		'sync "$proof_file"',
		'printf "%s\\n" "$proof_marker" >"$sentinel_temp_file"',
		'sync "$sentinel_temp_file"',
		'mv "$sentinel_temp_file" "$sentinel_file"',
		'sync "$sentinel_file"',
		'while :; do',
		'  sleep 3600',
		'done',
	].join('\n');
}

function isExpectedActiveOperationConnectionLoss(error: unknown): boolean {
	const message = errorMessageFromUnknown(error);
	return sshResetFailureMessageFragments.some((fragment) => message.includes(fragment));
}

async function runActiveOperationContainmentProbe(options: {
	readonly context: OpenClawPluginToolContext;
	readonly factoryProvider: AgentVmSandboxBackendFactoryProvider;
	readonly params: {
		readonly filePath: string;
		readonly marker: string;
		readonly sentinelFilePath: string;
	};
}): Promise<never> {
	const backendContext = await createToolVmWriteReadE2eBackend({
		context: options.context,
		factoryProvider: options.factoryProvider,
	});
	try {
		await backendContext.backend.runShellCommand({
			script: buildActiveOperationContainmentScript({
				...options.params,
				workspaceDirectory: backendContext.backend.workdir,
			}),
		});
	} catch (error) {
		if (isExpectedActiveOperationConnectionLoss(error)) {
			throw new ToolVmWriteReadE2eRouteError(
				'tool-vm-write-read-e2e: active operation lost its Tool VM connection.',
				503,
			);
		}
		throw error instanceof Error ? error : new Error(String(error));
	}
	throw new Error('tool-vm-write-read-e2e: active operation completed before termination.');
}

function buildToolVmWriteReadE2eSshResetScript(): string {
	return [
		'set -eu',
		'printf "%s\\n" "agent-vm-e2e-resetting-tool-vm-sshd" >&2',
		'current_pid=$$',
		"target_pid=''",
		'while [ "$current_pid" != "1" ]; do',
		'  parent_pid=$(awk \'/^PPid:/ { print $2 }\' "/proc/$current_pid/status" 2>/dev/null || true)',
		'  if [ -z "$parent_pid" ] || [ "$parent_pid" = "0" ]; then',
		'    break',
		'  fi',
		'  parent_comm=$(cat "/proc/$parent_pid/comm" 2>/dev/null || true)',
		'  if [ "$parent_comm" = "sshd" ]; then',
		'    target_pid="$parent_pid"',
		'    break',
		'  fi',
		'  current_pid="$parent_pid"',
		'done',
		'if [ -z "$target_pid" ]; then',
		'  printf "%s\\n" "agent-vm-e2e-resetting-tool-vm-sshd: no sshd ancestor found" >&2',
		'  exit 97',
		'fi',
		'kill -9 "$target_pid"',
		'sleep 5',
		'printf "%s\\n" "agent-vm-e2e-resetting-tool-vm-sshd: ssh session survived reset" >&2',
		'exit 98',
	].join('\n');
}

const sshResetFailureMessageFragments = [
	'Connection reset by peer',
	'closed by remote host',
	'kex_exchange_identification',
	'ssh_exchange_identification',
] as const;

const sshResetScriptFailureMessageFragments = [
	'agent-vm-e2e-resetting-tool-vm-sshd: no sshd ancestor found',
	'agent-vm-e2e-resetting-tool-vm-sshd: ssh session survived reset',
] as const;

function errorMessageFromUnknown(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isExpectedToolVmWriteReadE2eSshResetError(error: unknown): boolean {
	const message = errorMessageFromUnknown(error);
	if (sshResetScriptFailureMessageFragments.some((fragment) => message.includes(fragment))) {
		return false;
	}
	return sshResetFailureMessageFragments.some((fragment) => message.includes(fragment));
}

async function markToolVmWriteReadE2eHandleStaleWithSshCommandReset(
	backend: AgentVmSandboxBackendHandle,
): Promise<void> {
	try {
		await backend.runShellCommand({
			script: buildToolVmWriteReadE2eSshResetScript(),
		});
	} catch (error) {
		if (isExpectedToolVmWriteReadE2eSshResetError(error)) {
			return;
		}
		throw error instanceof Error ? error : new Error(String(error));
	}
	throw new Error('tool-vm-write-read-e2e: SSH reset command completed without stale evidence.');
}

async function runToolVmStaleReacquireE2eProbe(options: {
	readonly context: OpenClawPluginToolContext;
	readonly factoryProvider: AgentVmSandboxBackendFactoryProvider;
	readonly params: {
		readonly filePath: string;
		readonly marker: string;
		readonly secondFilePath: string;
		readonly secondMarker: string;
	};
}): Promise<ToolVmStaleReacquireE2eProbeDetails> {
	const backendContext = await createToolVmWriteReadE2eBackend({
		context: options.context,
		factoryProvider: options.factoryProvider,
	});
	const first = await runToolVmWriteReadE2eProbeStep({
		backend: backendContext.backend,
		params: {
			filePath: options.params.filePath,
			marker: options.params.marker,
		},
	});
	const oldRuntimeId = backendContext.backend.runtimeId;
	await markToolVmWriteReadE2eHandleStaleWithSshCommandReset(backendContext.backend);
	const second = await runToolVmWriteReadE2eProbeStep({
		backend: backendContext.backend,
		params: {
			filePath: options.params.secondFilePath,
			marker: options.params.secondMarker,
		},
	});
	const newRuntimeId = backendContext.backend.runtimeId;
	if (newRuntimeId === oldRuntimeId) {
		throw new Error(
			`tool-vm-write-read-e2e: stale-reacquire returned the old runtime id '${oldRuntimeId}'.`,
		);
	}
	return {
		agentId: backendContext.agentId,
		first,
		newRuntimeId,
		oldRuntimeId,
		scenario: 'stale-reacquire',
		second,
		sameHandle: true,
		sessionKey: backendContext.sessionKey,
		staleTrigger: 'ssh-command-reset',
		status: 'ok',
		workdir: backendContext.backend.workdir,
	};
}

export function registerToolVmWriteReadE2eRoute(options: {
	readonly api: {
		readonly registerHttpRoute: OpenClawHttpRouteRegistrationApi['registerHttpRoute'];
	};
	readonly factoryProvider: AgentVmSandboxBackendFactoryProvider;
}): void {
	if (
		process.env[AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_ENV] !== '1' &&
		process.env[AGENT_VM_E2E_CONTROL_ADMISSION_PRESSURE_ENV] !== '1'
	) {
		return;
	}
	const proofKey = process.env[AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_KEY_ENV];
	if (proofKey === undefined || proofKey.length === 0) {
		throw new Error(
			`tool-vm-write-read-e2e: ${AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_KEY_ENV} is required.`,
		);
	}
	const probeIdentities = readConfiguredProbeIdentitiesFromEnv();
	const registerHttpRoute = options.api.registerHttpRoute;
	if (typeof registerHttpRoute !== 'function') {
		throw new Error('tool-vm-write-read-e2e: OpenClaw did not provide registerHttpRoute.');
	}
	registerHttpRoute({
		auth: 'plugin',
		handler: async (request, response) => {
			try {
				const bodyText = await readRequestBodyText(request);
				verifyToolVmWriteReadE2eRouteBody({
					bodyText,
					key: proofKey,
					signature: readHeaderValue(
						request.headers,
						AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_SIGNATURE_HEADER,
					),
				});
				const parsedBody: unknown = bodyText.length === 0 ? {} : JSON.parse(bodyText);
				const controlAdmissionParams =
					isObjectRecord(parsedBody) && parsedBody.scenario === 'control-admission-pressure'
						? readControlAdmissionPressureRouteParams(parsedBody, probeIdentities)
						: undefined;
				if (controlAdmissionParams !== undefined) {
					const details = await runControlAdmissionPressureAction(controlAdmissionParams);
					response.statusCode = 200;
					response.setHeader('cache-control', 'no-store');
					response.setHeader('content-type', 'application/json; charset=utf-8');
					response.end(JSON.stringify({ details, ok: true }));
					return true;
				}
				const routeParams = readRouteParams(parsedBody, probeIdentities);
				const context = {
					agentDir: `/zone/agents/${routeParams.agentId}`,
					agentId: routeParams.agentId,
					sessionKey: routeParams.sessionKey,
					workspaceDir: `/zone/agents/${routeParams.agentId}`,
				} satisfies OpenClawPluginToolContext;
				const details =
					routeParams.scenario === 'active-operation-containment'
						? await runActiveOperationContainmentProbe({
								context,
								factoryProvider: options.factoryProvider,
								params: routeParams,
							})
						: routeParams.scenario === 'stale-reacquire'
							? await runToolVmStaleReacquireE2eProbe({
									context,
									factoryProvider: options.factoryProvider,
									params: {
										filePath: routeParams.filePath,
										marker: routeParams.marker,
										secondFilePath: routeParams.secondFilePath,
										secondMarker: routeParams.secondMarker,
									},
								})
							: await runToolVmWriteReadE2eProbe({
									context,
									factoryProvider: options.factoryProvider,
									params: routeParams,
								});
				response.statusCode = 200;
				response.setHeader('cache-control', 'no-store');
				response.setHeader('content-type', 'application/json; charset=utf-8');
				response.end(JSON.stringify({ details, ok: true }));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				response.statusCode =
					error instanceof ToolVmWriteReadE2eRouteError ? error.statusCode : 500;
				response.setHeader('cache-control', 'no-store');
				response.setHeader('content-type', 'application/json; charset=utf-8');
				response.end(JSON.stringify({ error: { message }, ok: false }));
			}
			return true;
		},
		match: 'exact',
		path: AGENT_VM_E2E_TOOL_VM_WRITE_READ_PROBE_PATH,
	});
}

export const testExports = {
	signToolVmWriteReadE2eRouteBody,
};
