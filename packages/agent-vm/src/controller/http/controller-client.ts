import {
	type ControllerLeasePeekResponse,
	controllerLeasePeekResponseSchema,
} from './controller-lease-response-types.js';

export interface ControllerClient {
	destroyZone(zoneId: string, purge: boolean): Promise<unknown>;
	enableZoneSsh(zoneId: string, options?: EnableZoneSshOptions): Promise<unknown>;
	execInZone?(zoneId: string, command: string, options?: ExecInZoneOptions): Promise<unknown>;
	getControllerStatus(): Promise<unknown>;
	getZoneLogs(zoneId: string): Promise<unknown>;
	listLeases(): Promise<unknown>;
	peekLease(leaseId: string): Promise<ControllerLeasePeekResponse>;
	refreshZoneCredentials(zoneId: string): Promise<unknown>;
	releaseLease(leaseId: string): Promise<void>;
	stopController(): Promise<unknown>;
	upgradeZone(zoneId: string): Promise<unknown>;
}

export interface EnableZoneSshOptions {
	readonly adminToken?: string;
	readonly secretEnv?: 'default' | 'with-secrets';
}

export interface ExecInZoneOptions {
	readonly adminToken?: string;
}

async function readJsonResponse(response: Response, context: string): Promise<unknown> {
	const responseBody = await response.text().catch(() => '(unreadable)');
	if (!response.ok) {
		throw new Error(`${context} failed with HTTP ${response.status}: ${responseBody}`);
	}

	try {
		return JSON.parse(responseBody) as unknown;
	} catch (error) {
		throw new Error(
			`${context} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}. Body: ${responseBody}`,
			{ cause: error },
		);
	}
}

async function readLeasePeekResponse(
	response: Response,
	context: string,
): Promise<ControllerLeasePeekResponse> {
	const payload = await readJsonResponse(response, context);
	const parsedPayload = controllerLeasePeekResponseSchema.safeParse(payload);
	if (!parsedPayload.success) {
		throw new Error(`${context} returned an invalid lease peek response.`);
	}
	return parsedPayload.data;
}

export function createControllerClient(options: {
	readonly baseUrl: string;
	readonly fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}): ControllerClient {
	const fetchImpl = options.fetchImpl ?? fetch;
	const baseUrl = options.baseUrl.replace(/\/$/u, '');

	return {
		enableZoneSsh: async (
			zoneId: string,
			enableOptions: EnableZoneSshOptions = {},
		): Promise<unknown> => {
			const response = await fetchImpl(`${baseUrl}/zones/${zoneId}/enable-ssh`, {
				body: JSON.stringify({
					...(enableOptions.adminToken ? { adminToken: enableOptions.adminToken } : {}),
					secretEnv: enableOptions.secretEnv ?? 'default',
				}),
				headers: {
					'content-type': 'application/json',
				},
				method: 'POST',
			});
			return await readJsonResponse(response, `Enable SSH for zone '${zoneId}'`);
		},
		execInZone: async (
			zoneId: string,
			command: string,
			execOptions: ExecInZoneOptions = {},
		): Promise<unknown> => {
			const response = await fetchImpl(`${baseUrl}/zones/${zoneId}/execute-command`, {
				body: JSON.stringify({
					...(execOptions.adminToken ? { adminToken: execOptions.adminToken } : {}),
					command,
				}),
				headers: {
					'content-type': 'application/json',
				},
				method: 'POST',
			});
			return await readJsonResponse(response, `Execute command in zone '${zoneId}'`);
		},
		destroyZone: async (zoneId: string, purge: boolean): Promise<unknown> => {
			const response = await fetchImpl(`${baseUrl}/zones/${zoneId}/destroy`, {
				body: JSON.stringify({ purge }),
				headers: {
					'content-type': 'application/json',
				},
				method: 'POST',
			});
			return await readJsonResponse(response, `Destroy zone '${zoneId}'`);
		},
		getControllerStatus: async (): Promise<unknown> => {
			const response = await fetchImpl(`${baseUrl}/controller-status`);
			return await readJsonResponse(response, 'Get controller status');
		},
		getZoneLogs: async (zoneId: string): Promise<unknown> => {
			const response = await fetchImpl(`${baseUrl}/zones/${zoneId}/logs`);
			return await readJsonResponse(response, `Get logs for zone '${zoneId}'`);
		},
		refreshZoneCredentials: async (zoneId: string): Promise<unknown> => {
			const response = await fetchImpl(`${baseUrl}/zones/${zoneId}/credentials/refresh`, {
				method: 'POST',
			});
			return await readJsonResponse(response, `Refresh credentials for zone '${zoneId}'`);
		},
		listLeases: async (): Promise<unknown> => {
			const response = await fetchImpl(`${baseUrl}/leases`);
			return await readJsonResponse(response, 'List leases');
		},
		peekLease: async (leaseId: string): Promise<ControllerLeasePeekResponse> => {
			const response = await fetchImpl(`${baseUrl}/lease/${leaseId}/peek`);
			return await readLeasePeekResponse(response, `Peek lease '${leaseId}'`);
		},
		releaseLease: async (leaseId: string): Promise<void> => {
			await fetchImpl(`${baseUrl}/lease/${leaseId}`, { method: 'DELETE' });
		},
		stopController: async (): Promise<unknown> => {
			const response = await fetchImpl(`${baseUrl}/stop-controller`, { method: 'POST' });
			return await readJsonResponse(response, 'Stop controller');
		},
		upgradeZone: async (zoneId: string): Promise<unknown> => {
			const response = await fetchImpl(`${baseUrl}/zones/${zoneId}/upgrade`, {
				method: 'POST',
			});
			return await readJsonResponse(response, `Upgrade zone '${zoneId}'`);
		},
	};
}
