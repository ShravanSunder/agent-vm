import { execFile } from 'node:child_process';
/** Account-free manual proof: run only on request, never from the CI test inventory. */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { startNodeHost, nodeHostConfigSchema } from '@agent-collaboration/tool-host-node';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';

import { advertisedVersions } from '#node-host/manual-tests/advertised-protocol-versions';

const endpoint = new URL('https://mcp.deepwiki.com/mcp');
const originalFetch = globalThis.fetch;
const requests: {
	method: string;
	protocolVersion: string | null;
	status: number;
	negotiationResponse?: string;
}[] = [];
const requestSchema = z.object({ method: z.string() }).passthrough();
// Observation only, scoped to this manual process. No response is replaced.
globalThis.fetch = async (input, init) => {
	const url = new URL(input instanceof Request ? input.url : String(input));
	const upstream = url.origin === endpoint.origin;
	const body = typeof init?.body === 'string' ? init.body : undefined;
	const parsed = body === undefined ? undefined : requestSchema.safeParse(JSON.parse(body));
	const response = await originalFetch(input, init);
	if (upstream && parsed?.success === true) {
		const method = parsed.data.method;
		const headers = new Headers(input instanceof Request ? input.headers : undefined);
		new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
		requests.push({
			method,
			protocolVersion: headers.get('mcp-protocol-version'),
			status: response.status,
			...(method === 'server/discover' || method === 'initialize'
				? { negotiationResponse: await response.clone().text() }
				: {}),
		});
	}
	return response;
};
const directory = await mkdtemp(path.join(tmpdir(), '2026-10-s4d-deepwiki-'));
const repositoryRoot = path.resolve(import.meta.dirname, '../../../..');
const config = nodeHostConfigSchema.parse({
	schemaVersion: 1,
	authority: 'manual-deepwiki-proof',
	revision: { owner: 'manual-proof', revision: '1' },
	workspaceLayer: 'not-configured',
	storeDirectory: path.join(directory, 'store'),
	auth: {
		audience: 'tool-portal:mcp',
		serviceGeneration: 'manual-proof',
		credentials: [
			{
				bearerToken: 'manual-local-caller',
				credentialVersion: 1,
				principal: {
					agentId: 'manual',
					toolPortalProfileId: 'manual',
					profileAssignmentRevision: '1',
				},
			},
		],
	},
	profiles: {
		manual: {
			revision: { owner: 'manual-proof', revision: '1' },
			profile: {
				profileId: 'manual',
				namespaces: {
					deepwiki: {
						backendKind: 'mcp_provider',
						tools: { allow: '*', deny: [] },
						calls: {
							kind: 'selectors',
							withoutApproval: { allow: ['ask_wiki_question'], deny: [] },
							requiresApproval: { allow: [], deny: [] },
						},
						operations: {},
					},
				},
			},
		},
	},
	mcp: {
		schemaVersion: 1,
		providers: {
			deepwiki: {
				kind: 'mcp',
				namespace: 'deepwiki',
				transport: {
					kind: 'streamable-http',
					url: endpoint.href,
					headers: {},
					connectionTimeoutMs: 120000,
				},
			},
		},
	},
	listener: {
		kind: 'http',
		hostname: '127.0.0.1',
		port: 0,
		routePath: '/mcp',
		allowedHosts: ['127.0.0.1'],
		allowedOrigins: [],
	},
	exposure: 'catalog',
});
const configPath = path.join(directory, 'host.jsonc');
await writeFile(configPath, JSON.stringify(config));
const client = new Client(
	{ name: 's4d-live-deepwiki-proof', version: '1' },
	{ versionNegotiation: { mode: { pin: '2026-07-28' } } },
);
let host: Awaited<ReturnType<typeof startNodeHost>> | undefined;
try {
	host = await startNodeHost({
		configPath,
		secrets: {
			resolve: async () => {
				throw new Error('DeepWiki manual proof must not resolve account credentials.');
			},
		},
	});
	if (host.http === undefined) throw new Error('Manual proof needs the actual HTTP gateway.');
	const localEndpoint = new URL(host.http.endpoint);
	localEndpoint.searchParams.set('tools', 'direct');
	await client.connect(
		new StreamableHTTPClientTransport(localEndpoint, {
			requestInit: { headers: { Authorization: 'Bearer manual-local-caller' } },
		}),
	);
	const tools = (await client.listTools()).tools;
	const deepwikiTools = tools.filter((tool) => tool.name.startsWith('deepwiki__'));
	const questionTool = deepwikiTools.find((tool) =>
		tool.name.startsWith('deepwiki__ask_wiki_question__'),
	);
	if (questionTool === undefined)
		throw new Error(
			`DeepWiki ask_wiki_question is missing through the gateway: ${JSON.stringify({ offeredTools: tools.map((tool) => tool.name), upstreamAttempts: requests })}`,
		);
	const question = {
		repoName: 'modelcontextprotocol/typescript-sdk',
		question: 'What is the main purpose of this repository? Answer briefly from its documentation.',
	};
	const result = await client.callTool(
		{ name: questionTool.name, arguments: question },
		{ timeout: 120000 },
	);
	if (result.isError === true) throw new Error('DeepWiki read-only gateway call failed.');
	const calls = requests.filter((request) => request.method === 'tools/call');
	if (calls.length !== 1)
		throw new Error(`Expected one DeepWiki read-only call, saw ${calls.length}.`);
	const negotiated = [
		...new Set(
			requests
				.filter((request) => request.method === 'tools/list' || request.method === 'tools/call')
				.map((request) => request.protocolVersion)
				.filter((version) => version !== null),
		),
	];
	if (negotiated.length !== 1)
		throw new Error('DeepWiki negotiated wire version is missing or inconsistent.');
	const advertised = [
		...new Set(
			requests
				.filter((request) => request.method === 'server/discover')
				.flatMap((request) => advertisedVersions(request.negotiationResponse ?? '')),
		),
	];
	if (advertised.length === 0)
		throw new Error(
			'DeepWiki advertised protocol versions were not observed; inspect the raw negotiation response.',
		);
	if (!advertised.includes(negotiated[0] ?? ''))
		throw new Error('Selected wire version was absent from the advertised set.');
	const exec = promisify(execFile);
	const head = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot })).stdout.trim();
	const builtHashes = Object.fromEntries(
		await Promise.all(
			(await readdir(path.join(repositoryRoot, 'packages/tool-host-node/dist')))
				.filter((name) => name.endsWith('.js'))
				.map(
					async (name): Promise<readonly [string, string]> => [
						name,
						createHash('sha256')
							.update(
								await readFile(path.join(repositoryRoot, 'packages/tool-host-node/dist', name)),
							)
							.digest('hex'),
					],
				),
		),
	);
	process.stdout.write(
		`${JSON.stringify({ observedAt: new Date().toISOString(), sourceHead: head, node: process.version, endpoint: endpoint.href, advertisedProtocolVersions: advertised, negotiatedProtocolVersion: negotiated[0], upstreamAttempts: requests, offeredTools: deepwikiTools.map((tool) => tool.name), readOnlyCall: { name: 'ask_wiki_question', arguments: question, count: calls.length }, result, builtNodeHashes: builtHashes }, null, 2)}\n`,
	);
} finally {
	await client.close();
	await host?.retire();
	globalThis.fetch = originalFetch;
	await rm(directory, { recursive: true, force: true });
}
