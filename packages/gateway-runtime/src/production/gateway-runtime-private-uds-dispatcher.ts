import {
	GatewayRuntimeTrustedInvocationContextSchema,
	GatewayApprovalDecisionRequestSchema,
	GatewayApprovalDecisionResultSchema,
	PortalArtifactReadRequestSchema,
	PortalArtifactReadResultSchema,
	PortalCallRequestSchema,
	PortalCallResultSchema,
	PortalDescribeRequestSchema,
	PortalDescribeResultSchema,
	PortalListRequestSchema,
	PortalListResultSchema,
	PortalSearchRequestSchema,
	PortalSearchResultSchema,
	SANDBOX_METHOD_CONTRACTS,
	type GatewayRuntimeTrustedInvocationContext,
} from '@agent-vm/agent-portal-sdk';
import {
	GatewayRuntimeTraceContextSchema,
	type GatewayRuntimeTraceContext,
} from '@agent-vm/agent-portal-sdk/gateway-runtime-client';
import { z } from 'zod/v4';

import type { GatewayRuntimeApprovalDecisionOperations } from '../gateway-runtime-approval-decision-operations.js';
import type {
	GatewayRuntimeArtifactProjectionOperations,
	GatewayRuntimePortalProjectionOperations,
} from '../tool-portal-projections.js';

const GatewayRuntimeInvocationEnvelopeSchema = z
	.object({
		publicRequest: z.unknown(),
		traceContext: GatewayRuntimeTraceContextSchema.optional(),
		trustedContext: GatewayRuntimeTrustedInvocationContextSchema,
	})
	.strict();

export type GatewayRuntimeSandboxMethod = keyof typeof SANDBOX_METHOD_CONTRACTS;

export interface GatewayRuntimePrivateUdsDispatchRequest {
	readonly connectionId: string;
	readonly method: string;
	readonly params: unknown;
	readonly signal: AbortSignal;
}

export interface GatewayRuntimeSandboxDispatchRequest {
	readonly connectionId: string;
	readonly method: GatewayRuntimeSandboxMethod;
	readonly publicRequest: unknown;
	readonly signal: AbortSignal;
	readonly trustedContext: GatewayRuntimeTrustedInvocationContext;
}

export interface GatewayRuntimePrivateUdsDispatcher {
	readonly dispatch: (request: GatewayRuntimePrivateUdsDispatchRequest) => Promise<unknown>;
}

export interface GatewayRuntimeTraceContextDispatchOptions {
	readonly connectionId: string;
	readonly method: string;
	readonly traceContext: GatewayRuntimeTraceContext | undefined;
	readonly trustedContext: GatewayRuntimeTrustedInvocationContext;
}

export type GatewayRuntimeTraceContextDispatch = <TResult>(
	options: GatewayRuntimeTraceContextDispatchOptions,
	dispatch: () => Promise<TResult>,
) => Promise<TResult>;

export interface CreateGatewayRuntimePrivateUdsDispatcherProps {
	readonly approvalOperations: GatewayRuntimeApprovalDecisionOperations;
	readonly artifactOperations: GatewayRuntimeArtifactProjectionOperations;
	readonly portalOperations: GatewayRuntimePortalProjectionOperations;
	readonly sandboxDispatch: (request: GatewayRuntimeSandboxDispatchRequest) => Promise<unknown>;
	readonly traceContextDispatch?: GatewayRuntimeTraceContextDispatch;
}

export type GatewayRuntimePrivateUdsDispatcherErrorCode =
	| 'invalid-backend-result'
	| 'invalid-request'
	| 'method-not-found';

export class GatewayRuntimePrivateUdsDispatcherError extends Error {
	readonly code: GatewayRuntimePrivateUdsDispatcherErrorCode;

	constructor(
		code: GatewayRuntimePrivateUdsDispatcherErrorCode,
		message: string,
		options: ErrorOptions = {},
	) {
		super(message, options);
		this.name = GatewayRuntimePrivateUdsDispatcherError.name;
		this.code = code;
	}
}

interface CanonicalSchema<TValue> {
	readonly parse: (value: unknown) => TValue;
}

function parseInvocationEnvelope<TPublicRequest>(props: {
	readonly params: unknown;
	readonly requestSchema: CanonicalSchema<TPublicRequest>;
}): {
	readonly publicRequest: TPublicRequest;
	readonly traceContext: GatewayRuntimeTraceContext | undefined;
	readonly trustedContext: GatewayRuntimeTrustedInvocationContext;
} {
	try {
		const envelope = GatewayRuntimeInvocationEnvelopeSchema.parse(props.params);
		return {
			publicRequest: props.requestSchema.parse(envelope.publicRequest),
			traceContext: envelope.traceContext,
			trustedContext: envelope.trustedContext,
		};
	} catch (error: unknown) {
		throw new GatewayRuntimePrivateUdsDispatcherError(
			'invalid-request',
			'Gateway runtime private UDS request is invalid.',
			{ cause: error },
		);
	}
}

async function dispatchWithValidatedTraceContext<TResult>(props: {
	readonly connectionId: string;
	readonly dispatch: () => Promise<TResult>;
	readonly dispatcherProps: CreateGatewayRuntimePrivateUdsDispatcherProps;
	readonly method: string;
	readonly traceContext: GatewayRuntimeTraceContext | undefined;
	readonly trustedContext: GatewayRuntimeTrustedInvocationContext;
}): Promise<TResult> {
	if (props.dispatcherProps.traceContextDispatch === undefined) return await props.dispatch();
	return await props.dispatcherProps.traceContextDispatch(
		{
			connectionId: props.connectionId,
			method: props.method,
			traceContext: props.traceContext,
			trustedContext: props.trustedContext,
		},
		props.dispatch,
	);
}

function parseBackendResult<TResult>(
	resultSchema: CanonicalSchema<TResult>,
	result: unknown,
): TResult {
	try {
		return resultSchema.parse(result);
	} catch (error: unknown) {
		throw new GatewayRuntimePrivateUdsDispatcherError(
			'invalid-backend-result',
			'Gateway runtime backend returned an invalid private UDS result.',
			{ cause: error },
		);
	}
}

async function dispatchProjectionRequest<TPublicRequest, TResult>(props: {
	readonly dispatcherProps: CreateGatewayRuntimePrivateUdsDispatcherProps;
	readonly projection: (invocation: {
		readonly publicRequest: TPublicRequest;
		readonly trustedContext: GatewayRuntimeTrustedInvocationContext;
	}) => Promise<unknown>;
	readonly request: GatewayRuntimePrivateUdsDispatchRequest;
	readonly requestSchema: CanonicalSchema<TPublicRequest>;
	readonly resultSchema: CanonicalSchema<TResult>;
}): Promise<TResult> {
	const invocation = parseInvocationEnvelope({
		params: props.request.params,
		requestSchema: props.requestSchema,
	});
	return await dispatchWithValidatedTraceContext({
		connectionId: props.request.connectionId,
		dispatch: async () =>
			parseBackendResult(
				props.resultSchema,
				await props.projection({
					publicRequest: invocation.publicRequest,
					trustedContext: invocation.trustedContext,
				}),
			),
		dispatcherProps: props.dispatcherProps,
		method: props.request.method,
		traceContext: invocation.traceContext,
		trustedContext: invocation.trustedContext,
	});
}

function isSandboxMethod(method: string): method is GatewayRuntimeSandboxMethod {
	return Object.hasOwn(SANDBOX_METHOD_CONTRACTS, method);
}

export function resolveGatewayRuntimeOperationGroup(method: string): string | undefined {
	if (method === 'approval.decide') return 'approval';
	if (method.startsWith('portal.')) return 'portal';
	if (method === 'artifact.read') return 'artifact.read';
	if (method.startsWith('sandbox.environment.')) return 'sandbox.environment';
	if (method.startsWith('sandbox.exec.')) return 'sandbox.execution';
	if (method.startsWith('sandbox.fs.')) return 'sandbox.filesystem';
	if (method.startsWith('sandbox.process.')) return 'sandbox.process';
	if (method.startsWith('sandbox.retained-result.')) return 'sandbox.retained-results';
	if (method.startsWith('sandbox.stream.')) return 'sandbox.stream';
	if (method.startsWith('sandbox.terminal.')) return 'sandbox.terminal';
	return undefined;
}

async function dispatchSandboxRequest(props: {
	readonly dispatcherProps: CreateGatewayRuntimePrivateUdsDispatcherProps;
	readonly request: GatewayRuntimePrivateUdsDispatchRequest;
	readonly sandboxMethod: GatewayRuntimeSandboxMethod;
}): Promise<unknown> {
	const methodContract = SANDBOX_METHOD_CONTRACTS[props.sandboxMethod];
	return await dispatchProjectionRequest<unknown, unknown>({
		dispatcherProps: props.dispatcherProps,
		projection: async (invocation) =>
			await props.dispatcherProps.sandboxDispatch({
				connectionId: props.request.connectionId,
				method: props.sandboxMethod,
				publicRequest: invocation.publicRequest,
				signal: props.request.signal,
				trustedContext: invocation.trustedContext,
			}),
		request: props.request,
		requestSchema: methodContract.request,
		resultSchema: methodContract.result,
	});
}

export function createGatewayRuntimePrivateUdsDispatcher(
	props: CreateGatewayRuntimePrivateUdsDispatcherProps,
): GatewayRuntimePrivateUdsDispatcher {
	return {
		dispatch: async (request): Promise<unknown> => {
			switch (request.method) {
				case 'approval.decide':
					return await dispatchProjectionRequest({
						dispatcherProps: props,
						projection: props.approvalOperations.decide,
						request,
						requestSchema: GatewayApprovalDecisionRequestSchema,
						resultSchema: GatewayApprovalDecisionResultSchema,
					});
				case 'portal.list':
					return await dispatchProjectionRequest({
						dispatcherProps: props,
						projection: props.portalOperations.list,
						request,
						requestSchema: PortalListRequestSchema,
						resultSchema: PortalListResultSchema,
					});
				case 'portal.search':
					return await dispatchProjectionRequest({
						dispatcherProps: props,
						projection: props.portalOperations.search,
						request,
						requestSchema: PortalSearchRequestSchema,
						resultSchema: PortalSearchResultSchema,
					});
				case 'portal.describe':
					return await dispatchProjectionRequest({
						dispatcherProps: props,
						projection: props.portalOperations.describe,
						request,
						requestSchema: PortalDescribeRequestSchema,
						resultSchema: PortalDescribeResultSchema,
					});
				case 'portal.call':
					return await dispatchProjectionRequest({
						dispatcherProps: props,
						projection: props.portalOperations.call,
						request,
						requestSchema: PortalCallRequestSchema,
						resultSchema: PortalCallResultSchema,
					});
				case 'artifact.read':
					return await dispatchProjectionRequest({
						dispatcherProps: props,
						projection: props.artifactOperations.read,
						request,
						requestSchema: PortalArtifactReadRequestSchema,
						resultSchema: PortalArtifactReadResultSchema,
					});
				default:
					if (isSandboxMethod(request.method)) {
						return await dispatchSandboxRequest({
							dispatcherProps: props,
							request,
							sandboxMethod: request.method,
						});
					}
					throw new GatewayRuntimePrivateUdsDispatcherError(
						'method-not-found',
						'Gateway runtime private UDS method was not found.',
					);
			}
		},
	};
}
