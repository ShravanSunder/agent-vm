export interface GatewayToolInvocation {
	readonly tool: string;
	readonly args: Record<string, unknown>;
	readonly sessionKey?: string;
	readonly dryRun?: boolean;
}

export interface GatewayApiClient {
	getStatus(): Promise<unknown>;
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
		getStatus: async (): Promise<unknown> => {
			const response = await fetchImpl(`${baseUrl}/api/status`);
			return await response.json();
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
