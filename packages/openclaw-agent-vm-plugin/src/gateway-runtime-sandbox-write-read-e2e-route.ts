import { createHmac, timingSafeEqual } from 'node:crypto';

import type { ManagedAgentProjection } from '@agent-vm/agent-portal-sdk/contracts';
import type { GatewayRuntimeClientTrustedInvocationContext } from '@agent-vm/agent-portal-sdk/gateway-runtime-client';

import {
	actuateGatewayRuntimeSandboxE2eProbe,
	type GatewayRuntimeSandboxE2eActuatorClient,
	type GatewayRuntimeSandboxE2eActuatorParams,
} from './gateway-runtime-sandbox-write-read-e2e-actuator.js';
import type { OpenClawHttpRouteRegistrationApi } from './openclaw-sandbox-sdk-contract.js';

export const AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_ENV =
	'AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE';
export const AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_IDENTITIES_ENV =
	'AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_IDENTITIES';
export const AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_KEY_ENV =
	'AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_KEY';
export const AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_PATH =
	'/plugins/gondolin/e2e/gateway-runtime-sandbox-write-read';
export const AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_SIGNATURE_HEADER =
	'x-agent-vm-e2e-gateway-runtime-sandbox-signature';

const maximumBodyBytes = 16 * 1024;
const maximumConfiguredIdentities = 8;
const maximumMarkerBytes = 8 * 1024;
const proofFilePathPrefix = 'agent-vm-e2e-';

export type OpenClawGatewayRuntimeSandboxE2eClient = GatewayRuntimeSandboxE2eActuatorClient;

export function assertOpenClawGatewayRuntimeSandboxE2eClient(
	value: unknown,
): asserts value is OpenClawGatewayRuntimeSandboxE2eClient {
	if (!isObjectRecord(value)) {
		throw new Error('gateway-runtime-sandbox-write-read-e2e: client is unavailable.');
	}
	const sandbox = value.sandbox;
	const environment = isObjectRecord(sandbox) ? sandbox.environment : undefined;
	const execution = isObjectRecord(sandbox) ? sandbox.execution : undefined;
	const filesystem = isObjectRecord(sandbox) ? sandbox.filesystem : undefined;
	const stream = isObjectRecord(sandbox) ? sandbox.stream : undefined;
	if (
		!isObjectRecord(environment) ||
		typeof environment.open !== 'function' ||
		typeof environment.close !== 'function' ||
		!isObjectRecord(execution) ||
		typeof execution.start !== 'function' ||
		typeof execution.wait !== 'function' ||
		typeof execution.cancel !== 'function' ||
		!isObjectRecord(filesystem) ||
		typeof filesystem.write !== 'function' ||
		typeof filesystem.read !== 'function' ||
		!isObjectRecord(stream) ||
		typeof stream.close !== 'function'
	) {
		throw new Error(
			'gateway-runtime-sandbox-write-read-e2e: required Sandbox operations are unavailable.',
		);
	}
}

interface ConfiguredProbeIdentity {
	readonly agentId: string;
	readonly sessionKey: string;
}

type SandboxProbeRouteParams = GatewayRuntimeSandboxE2eActuatorParams;

type SandboxOperationErrorDiagnostic =
	| {
			readonly code: string;
			readonly kind: 'coded-error';
			readonly name: string;
	  }
	| {
			readonly kind: 'uncoded-error';
			readonly name: string;
	  };

class GatewayRuntimeSandboxE2eRouteError extends Error {
	readonly statusCode: number;

	constructor(message: string, statusCode: number) {
		super(message);
		this.name = 'GatewayRuntimeSandboxE2eRouteError';
		this.statusCode = statusCode;
	}
}

function isObjectRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedDiagnosticToken(value: unknown): string | undefined {
	if (typeof value !== 'string' && typeof value !== 'number') return undefined;
	const token = String(value);
	return /^[A-Za-z0-9_.:-]{1,64}$/u.test(token) ? token : undefined;
}

function resolveSandboxOperationErrorDiagnostic(error: unknown): SandboxOperationErrorDiagnostic {
	const errorRecord = isObjectRecord(error) ? error : undefined;
	const name = boundedDiagnosticToken(errorRecord?.['name']) ?? 'unknown';
	const code = boundedDiagnosticToken(errorRecord?.['code']);
	return code === undefined ? { kind: 'uncoded-error', name } : { code, kind: 'coded-error', name };
}

function resolveAgentIdFromSessionKey(sessionKey: string): string {
	const match = /^agent:([^:]+):/u.exec(sessionKey);
	if (match?.[1] === undefined || match[1].length === 0) {
		throw new GatewayRuntimeSandboxE2eRouteError(
			'gateway-runtime-sandbox-write-read-e2e: sessionKey must encode an agent id.',
			400,
		);
	}
	return match[1];
}

function readConfiguredProbeIdentities(): readonly ConfiguredProbeIdentity[] {
	const serializedIdentities =
		process.env[AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_IDENTITIES_ENV];
	if (serializedIdentities === undefined || serializedIdentities.length === 0) {
		throw new Error(
			`gateway-runtime-sandbox-write-read-e2e: ${AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_IDENTITIES_ENV} is required.`,
		);
	}
	let parsedIdentities: unknown;
	try {
		parsedIdentities = JSON.parse(serializedIdentities);
	} catch {
		throw new Error(
			'gateway-runtime-sandbox-write-read-e2e: configured identities must be valid JSON.',
		);
	}
	if (
		!Array.isArray(parsedIdentities) ||
		parsedIdentities.length < 1 ||
		parsedIdentities.length > maximumConfiguredIdentities
	) {
		throw new Error(
			`gateway-runtime-sandbox-write-read-e2e: configured identities must contain between 1 and ${String(maximumConfiguredIdentities)} entries.`,
		);
	}
	const identities: ConfiguredProbeIdentity[] = [];
	const identityKeys = new Set<string>();
	for (const [identityIndex, parsedIdentity] of parsedIdentities.entries()) {
		if (
			!isObjectRecord(parsedIdentity) ||
			Object.keys(parsedIdentity).toSorted().join(',') !== 'agentId,sessionKey' ||
			typeof parsedIdentity.agentId !== 'string' ||
			parsedIdentity.agentId.length === 0 ||
			typeof parsedIdentity.sessionKey !== 'string' ||
			parsedIdentity.sessionKey.length === 0
		) {
			throw new Error(
				`gateway-runtime-sandbox-write-read-e2e: configured identity ${String(identityIndex)} must contain only non-empty agentId and sessionKey strings.`,
			);
		}
		if (resolveAgentIdFromSessionKey(parsedIdentity.sessionKey) !== parsedIdentity.agentId) {
			throw new Error(
				'gateway-runtime-sandbox-write-read-e2e: configured sessionKey does not match its agentId.',
			);
		}
		const identityKey = `${parsedIdentity.agentId}\0${parsedIdentity.sessionKey}`;
		if (identityKeys.has(identityKey)) {
			throw new Error(
				'gateway-runtime-sandbox-write-read-e2e: configured identities contain a duplicate tuple.',
			);
		}
		identityKeys.add(identityKey);
		identities.push({
			agentId: parsedIdentity.agentId,
			sessionKey: parsedIdentity.sessionKey,
		});
	}
	return identities;
}

function normalizeProofFilePath(filePath: string): string {
	if (
		filePath.length > 1_024 ||
		filePath.startsWith('/') ||
		filePath.endsWith('/') ||
		filePath.includes('\0') ||
		filePath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..') ||
		!filePath.startsWith(proofFilePathPrefix)
	) {
		throw new GatewayRuntimeSandboxE2eRouteError(
			`gateway-runtime-sandbox-write-read-e2e: filePath must stay under ${proofFilePathPrefix}.`,
			400,
		);
	}
	return filePath;
}

function requireConfiguredIdentity(options: {
	readonly agentId: string;
	readonly configuredIdentities: readonly ConfiguredProbeIdentity[];
	readonly sessionKey: string;
}): ConfiguredProbeIdentity {
	if (resolveAgentIdFromSessionKey(options.sessionKey) !== options.agentId) {
		throw new GatewayRuntimeSandboxE2eRouteError(
			'gateway-runtime-sandbox-write-read-e2e: body agentId does not match sessionKey.',
			403,
		);
	}
	const configuredIdentity = options.configuredIdentities.find(
		(identity) =>
			identity.agentId === options.agentId && identity.sessionKey === options.sessionKey,
	);
	if (configuredIdentity === undefined) {
		throw new GatewayRuntimeSandboxE2eRouteError(
			'gateway-runtime-sandbox-write-read-e2e: request identity is not configured.',
			403,
		);
	}
	return configuredIdentity;
}

function parseRouteParams(
	value: unknown,
	configuredIdentities: readonly ConfiguredProbeIdentity[],
): SandboxProbeRouteParams {
	if (
		!isObjectRecord(value) ||
		typeof value.action !== 'string' ||
		typeof value.agentId !== 'string' ||
		value.agentId.length === 0 ||
		typeof value.sessionKey !== 'string' ||
		value.sessionKey.length === 0
	) {
		throw new GatewayRuntimeSandboxE2eRouteError(
			'gateway-runtime-sandbox-write-read-e2e: body must contain a supported action and non-empty identity strings.',
			400,
		);
	}
	const configuredIdentity = requireConfiguredIdentity({
		agentId: value.agentId,
		configuredIdentities,
		sessionKey: value.sessionKey,
	});
	if (value.action === 'reset-connection') {
		if (Object.keys(value).toSorted().join(',') !== 'action,agentId,sessionKey') {
			throw new GatewayRuntimeSandboxE2eRouteError(
				'gateway-runtime-sandbox-write-read-e2e: reset body contains unsupported fields.',
				400,
			);
		}
		return { action: value.action, ...configuredIdentity };
	}
	if (value.action === 'active-operation-containment') {
		if (
			Object.keys(value).toSorted().join(',') !==
				'action,agentId,filePath,marker,sentinelFilePath,sessionKey' ||
			typeof value.filePath !== 'string' ||
			typeof value.marker !== 'string' ||
			value.marker.length === 0 ||
			typeof value.sentinelFilePath !== 'string'
		) {
			throw new GatewayRuntimeSandboxE2eRouteError(
				'gateway-runtime-sandbox-write-read-e2e: active-operation body contains unsupported fields.',
				400,
			);
		}
		if (Buffer.byteLength(value.marker, 'utf8') > maximumMarkerBytes) {
			throw new GatewayRuntimeSandboxE2eRouteError(
				'gateway-runtime-sandbox-write-read-e2e: marker exceeds the byte limit.',
				413,
			);
		}
		return {
			action: value.action,
			...configuredIdentity,
			filePath: normalizeProofFilePath(value.filePath),
			marker: value.marker,
			sentinelFilePath: normalizeProofFilePath(value.sentinelFilePath),
		};
	}
	if (
		value.action !== 'write-read' ||
		Object.keys(value).toSorted().join(',') !== 'action,agentId,filePath,marker,sessionKey' ||
		typeof value.filePath !== 'string' ||
		typeof value.marker !== 'string' ||
		value.marker.length === 0
	) {
		throw new GatewayRuntimeSandboxE2eRouteError(
			'gateway-runtime-sandbox-write-read-e2e: write-read body contains unsupported fields.',
			400,
		);
	}
	if (Buffer.byteLength(value.marker, 'utf8') > maximumMarkerBytes) {
		throw new GatewayRuntimeSandboxE2eRouteError(
			'gateway-runtime-sandbox-write-read-e2e: marker exceeds the byte limit.',
			413,
		);
	}
	return {
		action: value.action,
		...configuredIdentity,
		filePath: normalizeProofFilePath(value.filePath),
		marker: value.marker,
	};
}

function createTrustedInvocationContext(options: {
	readonly agentProjections: Readonly<Record<string, ManagedAgentProjection>>;
	readonly identity: ConfiguredProbeIdentity;
}): GatewayRuntimeClientTrustedInvocationContext {
	const projection = options.agentProjections[options.identity.agentId];
	if (
		projection === undefined ||
		projection.agentId !== options.identity.agentId ||
		projection.frameworkIdentity.kind !== 'openclaw' ||
		projection.frameworkIdentity.agentId !== options.identity.agentId
	) {
		throw new GatewayRuntimeSandboxE2eRouteError(
			'gateway-runtime-sandbox-write-read-e2e: configured agent has no matching OpenClaw projection.',
			403,
		);
	}
	return {
		correlation: { sessionKey: options.identity.sessionKey },
		principal: {
			agentId: projection.agentId,
			frameworkIdentity: projection.frameworkIdentity,
			profileAssignmentRevision: projection.profileAssignmentRevision,
			toolPortalProfileId: projection.toolPortalProfileId,
		},
	};
}

async function readBoundedBody(request: AsyncIterable<Buffer | string>): Promise<string> {
	const chunks: Buffer[] = [];
	let byteLength = 0;
	for await (const chunk of request) {
		const chunkBuffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
		byteLength += chunkBuffer.byteLength;
		if (byteLength > maximumBodyBytes) {
			throw new GatewayRuntimeSandboxE2eRouteError(
				'gateway-runtime-sandbox-write-read-e2e: request body too large.',
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
	if (typeof value === 'string') return value;
	if (!Array.isArray(value)) return undefined;
	const firstValue: unknown = value[0];
	return typeof firstValue === 'string' ? firstValue : undefined;
}

function verifySignedBody(options: {
	readonly bodyText: string;
	readonly key: string;
	readonly signature: string | undefined;
}): void {
	if (options.signature === undefined || options.signature.length === 0) {
		throw new GatewayRuntimeSandboxE2eRouteError(
			'gateway-runtime-sandbox-write-read-e2e: missing proof signature.',
			401,
		);
	}
	const expectedSignature = createHmac('sha256', options.key)
		.update(options.bodyText, 'utf8')
		.digest('base64url');
	const expectedBytes = Buffer.from(expectedSignature, 'utf8');
	const receivedBytes = Buffer.from(options.signature, 'utf8');
	if (
		expectedBytes.byteLength !== receivedBytes.byteLength ||
		!timingSafeEqual(expectedBytes, receivedBytes)
	) {
		throw new GatewayRuntimeSandboxE2eRouteError(
			'gateway-runtime-sandbox-write-read-e2e: invalid proof signature.',
			403,
		);
	}
}

function writeJsonResponse(options: {
	readonly body: unknown;
	readonly response: Parameters<
		NonNullable<OpenClawHttpRouteRegistrationApi['registerHttpRoute']>
	>[0]['handler'] extends (request: infer _TRequest, response: infer TResponse) => unknown
		? TResponse
		: never;
	readonly statusCode: number;
}): void {
	options.response.statusCode = options.statusCode;
	options.response.setHeader('cache-control', 'no-store');
	options.response.setHeader('content-type', 'application/json; charset=utf-8');
	options.response.end(JSON.stringify(options.body));
}

export function registerGatewayRuntimeSandboxWriteReadE2eRoute(options: {
	readonly agentProjections: Readonly<Record<string, ManagedAgentProjection>>;
	readonly api: OpenClawHttpRouteRegistrationApi;
	readonly client: OpenClawGatewayRuntimeSandboxE2eClient;
}): void {
	if (process.env[AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_ENV] !== '1') return;
	const proofKey = process.env[AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_KEY_ENV];
	if (proofKey === undefined || proofKey.length === 0) {
		throw new Error(
			`gateway-runtime-sandbox-write-read-e2e: ${AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_KEY_ENV} is required.`,
		);
	}
	const configuredIdentities = readConfiguredProbeIdentities();
	const registerHttpRoute = options.api.registerHttpRoute;
	if (typeof registerHttpRoute !== 'function') {
		throw new Error(
			'gateway-runtime-sandbox-write-read-e2e: OpenClaw did not provide registerHttpRoute.',
		);
	}
	registerHttpRoute({
		auth: 'plugin',
		handler: async (request, response) => {
			try {
				if (request.method !== 'POST') {
					throw new GatewayRuntimeSandboxE2eRouteError(
						'gateway-runtime-sandbox-write-read-e2e: method must be POST.',
						405,
					);
				}
				const bodyText = await readBoundedBody(request);
				verifySignedBody({
					bodyText,
					key: proofKey,
					signature: readHeaderValue(
						request.headers,
						AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_SIGNATURE_HEADER,
					),
				});
				let parsedBody: unknown;
				try {
					parsedBody = JSON.parse(bodyText);
				} catch {
					throw new GatewayRuntimeSandboxE2eRouteError(
						'gateway-runtime-sandbox-write-read-e2e: body must be valid JSON.',
						400,
					);
				}
				const params = parseRouteParams(parsedBody, configuredIdentities);
				const trustedContext = createTrustedInvocationContext({
					agentProjections: options.agentProjections,
					identity: params,
				});
				const details = await actuateGatewayRuntimeSandboxE2eProbe({
					client: options.client,
					params,
					trustedContext,
				});
				writeJsonResponse({ body: { details, ok: true }, response, statusCode: 200 });
			} catch (error) {
				const routeError = error instanceof GatewayRuntimeSandboxE2eRouteError ? error : undefined;
				writeJsonResponse({
					body: {
						error: {
							...(routeError === undefined
								? { diagnostic: resolveSandboxOperationErrorDiagnostic(error) }
								: {}),
							message:
								routeError?.message ??
								'gateway-runtime-sandbox-write-read-e2e: sandbox operation failed.',
						},
						ok: false,
					},
					response,
					statusCode: routeError?.statusCode ?? 503,
				});
			}
			return true;
		},
		match: 'exact',
		path: AGENT_VM_E2E_GATEWAY_RUNTIME_SANDBOX_PROBE_PATH,
	});
}

export const gatewayRuntimeSandboxWriteReadE2eTestExports = {
	signBody(bodyText: string, key: string): string {
		return createHmac('sha256', key).update(bodyText, 'utf8').digest('base64url');
	},
};
