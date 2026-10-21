import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { unstable_dev, type Unstable_DevWorker } from 'wrangler';
import { z } from 'zod';

import {
	organizationConfigurations,
	organizationOne,
	organizationTwo,
	portalAudience,
	signingKeyHex,
	startControlledMcpIssuer,
	type ControlledMcpIssuer,
} from '#worker-host/test-fixtures/controlled-mcp-issuer';

export type LocalWorkerResponse = Awaited<ReturnType<Unstable_DevWorker['fetch']>>;
export interface LocalWorkerHarness {
	readonly worker: Unstable_DevWorker;
	readonly fixture: ControlledMcpIssuer;
	readonly token: string;
	readonly control: (input: Readonly<Record<string, unknown>>) => Promise<void>;
	readonly rpc: (
		method: string,
		params?: Readonly<Record<string, unknown>>,
		options?: {
			readonly token?: string;
			readonly path?: string;
			readonly headers?: Readonly<Record<string, string>>;
			readonly signal?: AbortSignal;
		},
	) => Promise<LocalWorkerResponse>;
	readonly close: () => Promise<void>;
}
export async function startLocalWorkerHarness(
	options: {
		readonly setup?: (fixture: ControlledMcpIssuer) => void;
		readonly configurations?: (url: string) => unknown;
	} = {},
): Promise<LocalWorkerHarness> {
	const fixture = await startControlledMcpIssuer();
	options.setup?.(fixture);
	const stateDirectory = await mkdtemp(path.join(tmpdir(), '2026-10-s6-worker-'));
	process.env.WRANGLER_LOG_PATH = path.join(stateDirectory, 'wrangler.log');
	process.env.WRANGLER_SEND_METRICS = 'false';
	const worker = await unstable_dev(
		'packages/tool-host-cloudflare/src/test-fixtures/worker-proof-entrypoint.ts',
		{
			config: 'packages/tool-host-cloudflare/wrangler.local.jsonc',
			local: true,
			persist: true,
			persistTo: stateDirectory,
			logLevel: 'error',
			vars: {
				SIGN_IN_ISSUER: fixture.url,
				SIGN_IN_JWKS_URL: `${fixture.url}/jwks`,
				TOOL_PORTAL_AUDIENCE: portalAudience,
				ORGANIZATION_CONFIGURATIONS: JSON.stringify(
					(options.configurations ?? organizationConfigurations)(fixture.url),
				),
				ONE_CREDENTIAL: 'one-secret-canary',
				TWO_CREDENTIAL: 'two-secret-canary',
				APPROVAL_KEY: signingKeyHex,
			},
			experimental: { disableExperimentalWarning: true, disableDevRegistry: true },
		},
	);
	const fetchLocalWorker = worker.fetch;
	worker.fetch = async (input, init) =>
		fetchLocalWorker(input, {
			...init,
			headers: Object.assign({}, init?.headers, { connection: 'close' }),
		});
	process.stderr.write('S6 proof stage runtime-ready\n');
	async function control(input: Readonly<Record<string, unknown>>): Promise<void> {
		const response = await worker.fetch('/__proof', {
			method: 'POST',
			body: JSON.stringify(input),
		});
		if (response.status !== 200)
			throw new Error(`Proof control failed: ${String(response.status)}`);
		await response.body?.cancel();
	}
	await Promise.all(
		[organizationOne, organizationTwo].flatMap((organizationId) =>
			['agent-one', 'agent-two'].map(async (agentId) =>
				control({ kind: 'admission', organizationId, agentId, state: 'listed' }),
			),
		),
	);
	process.stderr.write('S6 proof stage admission-ready\n');
	const token = await fixture.sign();
	return {
		worker,
		fixture,
		token,
		control,
		rpc: async (method, params = {}, options = {}) =>
			worker.fetch(options.path ?? '/mcp', {
				method: 'POST',
				...(options.signal === undefined ? {} : { signal: options.signal }),
				headers: {
					authorization: `Bearer ${options.token ?? token}`,
					'content-type': 'application/json',
					accept: 'application/json, text/event-stream',
					'MCP-Protocol-Version': '2026-07-28',
					'Mcp-Method': method,
					...(typeof params.name === 'string' ? { 'Mcp-Name': params.name } : {}),
					...options.headers,
				},
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 'proof',
					method,
					params: {
						_meta: {
							'io.modelcontextprotocol/protocolVersion': '2026-07-28',
							'io.modelcontextprotocol/clientCapabilities': {},
						},
						...params,
					},
				}),
			}),
		close: async () => {
			await worker.stop();
			await fixture.close();
			await rm(stateDirectory, { recursive: true, force: true });
		},
	};
}
export async function rpcResult(response: LocalWorkerResponse): Promise<Record<string, unknown>> {
	if (response.status !== 200)
		throw new Error(`MCP status ${String(response.status)}: ${await response.text()}`);
	const value = z
		.object({ result: z.record(z.string(), z.unknown()) })
		.parse(await response.json());
	return value.result;
}
export function portalRead(value: unknown = 'ok', id = 'call'): Readonly<Record<string, unknown>> {
	return {
		name: 'mcp_portal_call',
		arguments: {
			calls: [{ id, namespace: 'same-server', toolName: 'read', arguments: { value } }],
		},
	};
}
