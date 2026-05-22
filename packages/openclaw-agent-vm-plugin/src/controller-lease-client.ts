import type {
	EndToolVmActiveUseRequest,
	HeartbeatToolVmActiveUseResponse,
	StartToolVmActiveUseRequest,
	StartToolVmActiveUseResponse,
} from '@agent-vm/gateway-interface';

export interface GondolinLeaseResponse {
	readonly leaseId: string;
	readonly ssh: {
		readonly host: string;
		readonly identityPem: string;
		readonly knownHostsLine: string;
		readonly port: number;
		readonly user: string;
	};
	readonly tcpSlot: number;
	readonly workdir: string;
}

export interface LeasePeekResponse {
	readonly createdAt: number;
	readonly lastUsedAt: number;
	readonly leaseId: string;
	readonly profileId: string;
	readonly scopeKey: string;
	readonly ssh: {
		readonly host: string;
		readonly port: number;
		readonly user: string;
	};
	readonly tcpSlot: number;
	readonly zoneId: string;
}

export interface OpenClawRuntimeStatusReport {
	readonly findings: readonly {
		readonly hint: string;
		readonly id: string;
		readonly ok: boolean;
	}[];
	readonly pluginId: 'gondolin';
	readonly zoneId: string;
}

export interface LeaseClient {
	// Cached handles use renewLease; read-only runtime probes use peekLease.
	endActiveUse(leaseId: string, useId: string, request: EndToolVmActiveUseRequest): Promise<void>;
	heartbeatActiveUse(leaseId: string, useId: string): Promise<HeartbeatToolVmActiveUseResponse>;
	peekLease(leaseId: string): Promise<LeasePeekResponse>;
	publishOpenClawRuntimeStatus?(report: OpenClawRuntimeStatusReport): Promise<void>;
	releaseLease(leaseId: string, options?: { readonly force?: boolean }): Promise<void>;
	renewLease(leaseId: string): Promise<GondolinLeaseResponse>;
	requestLease(request: {
		readonly agentWorkspaceDir: string;
		readonly profileId: string;
		readonly scopeKey: string;
		readonly workMountDir: string;
		readonly zoneId: string;
	}): Promise<GondolinLeaseResponse>;
	startActiveUse(
		leaseId: string,
		request: StartToolVmActiveUseRequest,
	): Promise<StartToolVmActiveUseResponse>;
}

export type ControllerLeaseRequestErrorKind = 'client-error' | 'server-error';

export class ControllerLeaseRequestError extends Error {
	readonly bodyText: string;
	readonly kind: ControllerLeaseRequestErrorKind;
	readonly responseBody: unknown;
	readonly status: number;

	constructor(options: {
		readonly bodyText: string;
		readonly context: string;
		readonly responseBody: unknown;
		readonly status: number;
	}) {
		const kind: ControllerLeaseRequestErrorKind =
			options.status >= 400 && options.status < 500 ? 'client-error' : 'server-error';
		super(`${options.context} returned HTTP ${String(options.status)} (${kind})`);
		this.bodyText = options.bodyText;
		this.kind = kind;
		this.responseBody = options.responseBody;
		this.status = options.status;
	}
}

function objectValue(value: unknown): object | undefined {
	return typeof value === 'object' && value !== null ? value : undefined;
}

function isSshResponse(value: unknown): value is GondolinLeaseResponse['ssh'] {
	const record = objectValue(value);
	return (
		record !== undefined &&
		typeof Reflect.get(record, 'host') === 'string' &&
		typeof Reflect.get(record, 'identityPem') === 'string' &&
		typeof Reflect.get(record, 'knownHostsLine') === 'string' &&
		typeof Reflect.get(record, 'port') === 'number' &&
		typeof Reflect.get(record, 'user') === 'string'
	);
}

function isLeasePeekSshResponse(value: unknown): value is LeasePeekResponse['ssh'] {
	const record = objectValue(value);
	return (
		record !== undefined &&
		typeof Reflect.get(record, 'host') === 'string' &&
		typeof Reflect.get(record, 'port') === 'number' &&
		typeof Reflect.get(record, 'user') === 'string'
	);
}

function isGondolinLeaseResponse(value: unknown): value is GondolinLeaseResponse {
	const record = objectValue(value);
	return (
		record !== undefined &&
		typeof Reflect.get(record, 'leaseId') === 'string' &&
		isSshResponse(Reflect.get(record, 'ssh')) &&
		typeof Reflect.get(record, 'tcpSlot') === 'number' &&
		typeof Reflect.get(record, 'workdir') === 'string'
	);
}

function isLeasePeekResponse(value: unknown): value is LeasePeekResponse {
	const record = objectValue(value);
	return (
		record !== undefined &&
		typeof Reflect.get(record, 'createdAt') === 'number' &&
		typeof Reflect.get(record, 'lastUsedAt') === 'number' &&
		typeof Reflect.get(record, 'leaseId') === 'string' &&
		typeof Reflect.get(record, 'profileId') === 'string' &&
		typeof Reflect.get(record, 'scopeKey') === 'string' &&
		isLeasePeekSshResponse(Reflect.get(record, 'ssh')) &&
		typeof Reflect.get(record, 'tcpSlot') === 'number' &&
		typeof Reflect.get(record, 'zoneId') === 'string'
	);
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

function parseJsonBody(bodyText: string, context: string): unknown {
	try {
		return JSON.parse(bodyText);
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
	readonly responseBody: unknown;
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
	const renewLease = async (leaseId: string): Promise<GondolinLeaseResponse> => {
		const response = await fetchImpl(`${baseUrl}/lease/${encodeURIComponent(leaseId)}/renew`, {
			method: 'POST',
		});
		return await readJsonResponse(response, 'Controller lease renew API', isGondolinLeaseResponse);
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
		): Promise<HeartbeatToolVmActiveUseResponse> => {
			const response = await fetchImpl(
				`${baseUrl}/lease/${encodeURIComponent(leaseId)}/uses/${encodeURIComponent(useId)}/heartbeat`,
				{
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
		peekLease: async (leaseId: string): Promise<LeasePeekResponse> => {
			const response = await fetchImpl(`${baseUrl}/lease/${leaseId}/peek`);
			return await readJsonResponse(response, 'Controller lease peek API', isLeasePeekResponse);
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
		requestLease: async (request): Promise<GondolinLeaseResponse> => {
			const response = await fetchImpl(`${baseUrl}/lease`, {
				body: JSON.stringify({
					agentWorkspaceDir: request.agentWorkspaceDir,
					profileId: request.profileId,
					scopeKey: request.scopeKey,
					workMountDir: request.workMountDir,
					zoneId: request.zoneId,
				}),
				headers: {
					'content-type': 'application/json',
				},
				method: 'POST',
			});
			return await readJsonResponse(response, 'Controller lease API', isGondolinLeaseResponse);
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
