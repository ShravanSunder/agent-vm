export interface GatewayToolInvocation {
	readonly tool: string;
	readonly args: Record<string, unknown>;
	readonly sessionKey?: string;
	readonly dryRun?: boolean;
}

/**
 * Liveness probe response from `/health` or `/healthz`.
 * Gateway returns `{ ok: true, status: "live" }` when the process is alive.
 */
export interface GatewayLivenessResponse {
	readonly ok: boolean;
	readonly status: 'live';
}

/**
 * Readiness probe response from `/readyz`.
 * Authenticated callers also receive `failing` and `uptimeMs` detail fields.
 */
export interface GatewayReadinessResponse {
	readonly ready: boolean;
	readonly failing?: readonly string[];
	readonly uptimeMs?: number;
}

export interface GatewayApiClient {
	/** Check gateway readiness via the `/readyz` probe endpoint. */
	getGatewayStatus(): Promise<GatewayReadinessResponse>;
	invokeTool(invocation: GatewayToolInvocation): Promise<unknown>;
}

export function createGatewayApiClient(options: {
	readonly gatewayUrl: string;
	readonly token: string;
	readonly fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}): GatewayApiClient {
	const fetchImpl = options.fetchImpl ?? fetch;
	const baseUrl = options.gatewayUrl.replace(/\/$/u, '');

	return {
		getGatewayStatus: async (): Promise<GatewayReadinessResponse> => {
			const response = await fetchImpl(`${baseUrl}/readyz`, {
				headers: {
					authorization: `Bearer ${options.token}`,
				},
			});
			return (await response.json()) as GatewayReadinessResponse;
		},
		invokeTool: async (invocation: GatewayToolInvocation): Promise<unknown> => {
			const response = await fetchImpl(`${baseUrl}/tools/invoke`, {
				body: JSON.stringify(invocation),
				headers: {
					authorization: `Bearer ${options.token}`,
					'content-type': 'application/json',
				},
				method: 'POST',
			});
			if (!response.ok) {
				throw new Error(`Gateway API returned status ${response.status}`);
			}
			return await response.json();
		},
	};
}
