import {
	isToolVmLeasePeek,
	isToolVmSshLease,
	type ToolVmLeasePeek,
	type ToolVmSshLease,
} from '@agent-vm/gateway-interface';
import type {
	EndToolVmActiveUseRequest,
	HeartbeatToolVmActiveUseRequest,
	HeartbeatToolVmActiveUseResponse,
	StartToolVmActiveUseRequest,
	StartToolVmActiveUseResponse,
} from '@agent-vm/gateway-interface';
import { z } from 'zod';

export type JsonValue =
	| boolean
	| null
	| number
	| string
	| { readonly [key: string]: JsonValue }
	| readonly JsonValue[];

export interface OpenClawRuntimeStatusReport {
	readonly findings: readonly {
		readonly hint: string;
		readonly id: string;
		readonly ok: boolean;
	}[];
	readonly pluginId: 'gondolin';
	readonly zoneId: string;
}

export interface OpenClawGondolinLeaseSandboxSnapshot {
	readonly backend: unknown;
	readonly mode: unknown;
	readonly scope: unknown;
	readonly workspaceAccess: unknown;
}

export interface OpenClawGondolinLeaseRequest {
	readonly agentId: string;
	readonly agentWorkspaceDir: string;
	readonly idleTtlMs?: number;
	readonly profileId: string;
	readonly sessionKey: string;
	readonly workMountDir: string;
	readonly zoneId: string;
}

export interface LeaseClient {
	// Cached handles use renewLease; read-only runtime probes use peekLease.
	endActiveUse(leaseId: string, useId: string, request: EndToolVmActiveUseRequest): Promise<void>;
	heartbeatActiveUse(
		leaseId: string,
		useId: string,
		request: HeartbeatToolVmActiveUseRequest,
	): Promise<HeartbeatToolVmActiveUseResponse>;
	peekLease(leaseId: string): Promise<ToolVmLeasePeek>;
	publishOpenClawRuntimeStatus?(report: OpenClawRuntimeStatusReport): Promise<void>;
	releaseLease(leaseId: string, options?: { readonly force?: boolean }): Promise<void>;
	renewLease(leaseId: string): Promise<ToolVmSshLease>;
	requestLease(request: OpenClawGondolinLeaseRequest): Promise<ToolVmSshLease>;
	startActiveUse(
		leaseId: string,
		request: StartToolVmActiveUseRequest,
	): Promise<StartToolVmActiveUseResponse>;
}

export type ControllerLeaseRequestErrorKind = 'client-error' | 'server-error';

export class ControllerLeaseRequestError extends Error {
	readonly bodyText: string;
	readonly kind: ControllerLeaseRequestErrorKind;
	readonly responseBody: JsonValue | undefined;
	readonly status: number;

	constructor(options: {
		readonly bodyText: string;
		readonly context: string;
		readonly responseBody: JsonValue | undefined;
		readonly status: number;
	}) {
		const kind: ControllerLeaseRequestErrorKind =
			options.status >= 400 && options.status < 500 ? 'client-error' : 'server-error';
		super(
			`${options.context} returned HTTP ${String(options.status)} (${kind})${formatStructuredErrorSuffix(
				options.responseBody,
			)}`,
		);
		this.bodyText = options.bodyText;
		this.kind = kind;
		this.responseBody = options.responseBody;
		this.status = options.status;
	}
}

const structuredControllerErrorSchema = z.object({
	guidance: z.string().trim().min(1).optional(),
	message: z.string().trim().min(1).optional(),
});

function isJsonObjectRecord(value: unknown): value is { readonly [key: string]: JsonValue } {
	return (
		typeof value === 'object' &&
		value !== null &&
		!Array.isArray(value) &&
		Object.values(value).every(isJsonValue)
	);
}

function isJsonValue(value: unknown): value is JsonValue {
	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'boolean' ||
		typeof value === 'number'
	) {
		return true;
	}
	if (Array.isArray(value)) {
		return value.every(isJsonValue);
	}
	return isJsonObjectRecord(value);
}

const jsonValueSchema = z.custom<JsonValue>(isJsonValue);

function objectValue(value: unknown): object | undefined {
	return typeof value === 'object' && value !== null ? value : undefined;
}

function formatStructuredErrorSuffix(responseBody: JsonValue | undefined): string {
	const parsedError = structuredControllerErrorSchema.safeParse(responseBody);
	if (!parsedError.success) {
		return '';
	}
	const { guidance, message } = parsedError.data;
	const parts = [message, guidance ? `Guidance: ${guidance}` : undefined].filter(
		(part): part is string => part !== undefined,
	);
	return parts.length > 0 ? `: ${parts.join(' ')}` : '';
}

function isStartActiveUseResponse(value: unknown): value is StartToolVmActiveUseResponse {
	const record = objectValue(value);
	return (
		record !== undefined &&
		typeof Reflect.get(record, 'expiresAt') === 'number' &&
		typeof Reflect.get(record, 'heartbeatAfterMs') === 'number' &&
		typeof Reflect.get(record, 'useId') === 'string'
	);
}

function isHeartbeatActiveUseResponse(value: unknown): value is HeartbeatToolVmActiveUseResponse {
	const record = objectValue(value);
	return (
		record !== undefined &&
		typeof Reflect.get(record, 'expiresAt') === 'number' &&
		typeof Reflect.get(record, 'heartbeatAfterMs') === 'number'
	);
}

function formatUnknownError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function writeLeaseClientLog(message: string): void {
	process.stderr.write(`[openclaw-agent-vm-plugin] ${message}\n`);
}

function parseJsonBody(bodyText: string, context: string): JsonValue | undefined {
	try {
		const parsedJson: unknown = JSON.parse(bodyText);
		const parsedBody = jsonValueSchema.safeParse(parsedJson);
		return parsedBody.success ? parsedBody.data : undefined;
	} catch (error) {
		writeLeaseClientLog(`${context} returned a non-JSON error body: ${formatUnknownError(error)}`);
		return undefined;
	}
}

async function readErrorBody(
	response: Response,
	context: string,
): Promise<{
	readonly bodyText: string;
	readonly responseBody: JsonValue | undefined;
}> {
	const bodyText = await response.text().catch(() => '(unreadable)');
	return {
		bodyText,
		responseBody: bodyText === '(unreadable)' ? undefined : parseJsonBody(bodyText, context),
	};
}

async function readJsonResponse<TValue>(
	response: Response,
	context: string,
	isExpectedResponse: (value: unknown) => value is TValue,
): Promise<TValue> {
	if (!response.ok) {
		const errorBody = await readErrorBody(response, context);
		throw new ControllerLeaseRequestError({
			bodyText: errorBody.bodyText,
			context,
			responseBody: errorBody.responseBody,
			status: response.status,
		});
	}
	const payload = await response.json();
	if (!isExpectedResponse(payload)) {
		throw new TypeError(
			`${context} returned an invalid response: ${JSON.stringify(payload).slice(0, 200)}`,
		);
	}
	return payload;
}

export function createLeaseClient(options: {
	readonly controllerUrl: string;
	readonly fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}): LeaseClient {
	const fetchImpl = options.fetchImpl ?? fetch;
	const baseUrl = options.controllerUrl.replace(/\/$/u, '');
	const renewLease = async (leaseId: string): Promise<ToolVmSshLease> => {
		const response = await fetchImpl(`${baseUrl}/lease/${encodeURIComponent(leaseId)}/renew`, {
			method: 'POST',
		});
		return await readJsonResponse(response, 'Controller lease renew API', isToolVmSshLease);
	};

	return {
		endActiveUse: async (
			leaseId: string,
			useId: string,
			request: EndToolVmActiveUseRequest,
		): Promise<void> => {
			const response = await fetchImpl(
				`${baseUrl}/lease/${encodeURIComponent(leaseId)}/uses/${encodeURIComponent(useId)}`,
				{
					body: JSON.stringify(request),
					headers: {
						'content-type': 'application/json',
					},
					method: 'DELETE',
				},
			);
			if (!response.ok) {
				const errorBody = await readErrorBody(response, 'Controller active-use end API');
				throw new ControllerLeaseRequestError({
					bodyText: errorBody.bodyText,
					context: 'Controller active-use end API',
					responseBody: errorBody.responseBody,
					status: response.status,
				});
			}
		},
		heartbeatActiveUse: async (
			leaseId: string,
			useId: string,
			request: HeartbeatToolVmActiveUseRequest,
		): Promise<HeartbeatToolVmActiveUseResponse> => {
			const response = await fetchImpl(
				`${baseUrl}/lease/${encodeURIComponent(leaseId)}/uses/${encodeURIComponent(useId)}/heartbeat`,
				{
					body: JSON.stringify(request),
					headers: {
						'content-type': 'application/json',
					},
					method: 'POST',
				},
			);
			return await readJsonResponse(
				response,
				'Controller active-use heartbeat API',
				isHeartbeatActiveUseResponse,
			);
		},
		renewLease,
		peekLease: async (leaseId: string): Promise<ToolVmLeasePeek> => {
			const response = await fetchImpl(`${baseUrl}/lease/${encodeURIComponent(leaseId)}/peek`);
			return await readJsonResponse(response, 'Controller lease peek API', isToolVmLeasePeek);
		},
		publishOpenClawRuntimeStatus: async (report): Promise<void> => {
			const response = await fetchImpl(
				`${baseUrl}/zones/${encodeURIComponent(report.zoneId)}/openclaw-runtime-status`,
				{
					body: JSON.stringify(report),
					headers: {
						'content-type': 'application/json',
					},
					method: 'POST',
				},
			);
			if (!response.ok) {
				const errorBody = await readErrorBody(response, 'Controller OpenClaw runtime status API');
				throw new ControllerLeaseRequestError({
					bodyText: errorBody.bodyText,
					context: 'Controller OpenClaw runtime status API',
					responseBody: errorBody.responseBody,
					status: response.status,
				});
			}
		},
		releaseLease: async (
			leaseId: string,
			releaseOptions: { readonly force?: boolean } = {},
		): Promise<void> => {
			const releaseUrl = new URL(`${baseUrl}/lease/${encodeURIComponent(leaseId)}`);
			if (releaseOptions.force === true) {
				releaseUrl.searchParams.set('force', 'true');
			}
			const response = await fetchImpl(releaseUrl.toString(), {
				method: 'DELETE',
			});
			if (!response.ok) {
				const errorBody = await readErrorBody(response, 'Controller lease release API');
				throw new ControllerLeaseRequestError({
					bodyText: errorBody.bodyText,
					context: 'Controller lease release API',
					responseBody: errorBody.responseBody,
					status: response.status,
				});
			}
		},
		requestLease: async (request): Promise<ToolVmSshLease> => {
			const response = await fetchImpl(`${baseUrl}/lease`, {
				body: JSON.stringify({
					agentId: request.agentId,
					agentWorkspaceDir: request.agentWorkspaceDir,
					...(request.idleTtlMs !== undefined ? { idleTtlMs: request.idleTtlMs } : {}),
					profileId: request.profileId,
					sessionKey: request.sessionKey,
					workMountDir: request.workMountDir,
					zoneId: request.zoneId,
				}),
				headers: {
					'content-type': 'application/json',
				},
				method: 'POST',
			});
			return await readJsonResponse(response, 'Controller lease API', isToolVmSshLease);
		},
		startActiveUse: async (
			leaseId: string,
			request: StartToolVmActiveUseRequest,
		): Promise<StartToolVmActiveUseResponse> => {
			const response = await fetchImpl(`${baseUrl}/lease/${encodeURIComponent(leaseId)}/uses`, {
				body: JSON.stringify(request),
				headers: {
					'content-type': 'application/json',
				},
				method: 'POST',
			});
			return await readJsonResponse(
				response,
				'Controller active-use start API',
				isStartActiveUseResponse,
			);
		},
	};
}
