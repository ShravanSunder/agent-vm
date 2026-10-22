import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';

import {
	createStandaloneToolPortalApprovalToken,
	startStandaloneToolPortalMcpHttpServer,
	startStandaloneToolPortalMcpStdioServer,
} from '@agent-collaboration/tool-host-node';
import { z } from 'zod';

import {
	startControlledProvider,
	toolInputSchema,
} from '#node-host/test-fixtures/node-host-fixture';
import {
	createPythonWheelStandaloneFixture,
	standaloneCredentials,
	standaloneKey,
} from '#node-host/test-fixtures/python-mcp-standalone-fixture';

const mode = process.argv[2];
if (mode !== 'http' && mode !== 'stdio') throw new Error('Expected HTTP or stdio fixture mode.');
const receiptPath = z.string().min(1).parse(process.argv[3]);
const provider = await startControlledProvider(
	'python-wheel',
	['read', 'ask', 'binary'].map((name) => ({ name, inputSchema: toolInputSchema })),
);
const fixture = await createPythonWheelStandaloneFixture(provider);
const observations: {
	readonly method: string;
	readonly meta: unknown;
	readonly headers: unknown;
}[] = [];
const messageSchema = z
	.object({
		method: z.string().optional(),
		params: z.object({ _meta: z.unknown().optional() }).passthrough().optional(),
	})
	.passthrough();
function observe(text: string, headers: unknown): void {
	const message = messageSchema.parse(JSON.parse(text));
	if (message.method !== undefined)
		observations.push({ method: message.method, meta: message.params?.['_meta'], headers });
}
let hold: ReturnType<typeof provider.holdCalls> | undefined;
let tokenCounter = 0;
let retired = false;
const clientExited = Promise.withResolvers<void>();
const cancelledCallSettled = Promise.withResolvers<void>();
const control = createServer((request, response) => {
	void (async () => {
		const operation = new URL(request.url ?? '/', 'http://control.invalid').pathname;
		let result: unknown = {};
		switch (operation) {
			case '/snapshot':
				result = { effects: provider.effects, observations, childPid: process.pid };
				break;
			case '/token': {
				const intent = fixture.approvalIntents.at(-1);
				if (intent === undefined)
					throw new Error('No protected batch reached the real coordinator.');
				tokenCounter++;
				result = {
					token: createStandaloneToolPortalApprovalToken({
						intent,
						expiresAt: new Date(fixture.now() + 60_000).toISOString(),
						hmacKey: standaloneKey,
						keyVersion: 1,
						tokenId: `10000000-0000-4000-8000-${String(tokenCounter).padStart(12, '0')}`,
					}),
				};
				break;
			}
			case '/hold':
				hold = provider.holdCalls();
				break;
			case '/entered':
				if (hold === undefined) throw new Error('Missing call hold.');
				await hold.entered;
				provider.holdCalls().release();
				break;
			case '/release':
				hold?.release();
				break;
			case '/settled':
				await cancelledCallSettled.promise;
				break;
			case '/shutdown':
				clientExited.resolve();
				break;
			default:
				throw new Error(`Unknown control operation ${operation}`);
		}
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end(JSON.stringify(result));
	})().catch((error: unknown) => {
		response.writeHead(500);
		response.end(String(error));
	});
});
control.listen(0, '127.0.0.1');
await once(control, 'listening');
const controlAddress = control.address();
if (controlAddress === null || typeof controlAddress === 'string')
	throw new Error('No control port.');
const controlUrl = `http://127.0.0.1:${controlAddress.port}`;
const principal = standaloneCredentials.credentials[0];
if (principal === undefined) throw new Error('Missing principal.');
const common = {
	service: {
		...fixture.service,
		call: async (
			...args: Parameters<typeof fixture.service.call>
		): ReturnType<typeof fixture.service.call> => {
			try {
				return await fixture.service.call(...args);
			} finally {
				if (args[0].calls.some((call) => call.id === 'cancelled')) cancelledCallSettled.resolve();
			}
		},
	},
	artifactReader: fixture.artifactReader,
};
let endpoint: string | undefined;
let retireHost: () => Promise<void>;
let retireCapture: () => Promise<void> = async () => {};
if (mode === 'http') {
	const host = await startStandaloneToolPortalMcpHttpServer({
		...common,
		hostname: '127.0.0.1',
		port: 0,
		routePath: '/portal',
		allowedHosts: ['127.0.0.1'],
		allowedOrigins: [],
		credentialSet: standaloneCredentials,
	});
	retireHost = host.retire;
	// Forward unchanged protocol bytes to the built authenticated listener. This tap never supplies MCP results.
	const capture = createServer((request, response) => {
		void (async () => {
			const disconnected = new AbortController();
			response.once('close', () => {
				if (!response.writableEnded) disconnected.abort();
			});
			const chunks: Buffer[] = [];
			for await (const chunk of request)
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
			const body = Buffer.concat(chunks);
			if (body.length > 0) observe(body.toString('utf8'), request.headers);
			const headers = new Headers();
			for (const [key, value] of Object.entries(request.headers))
				if (typeof value === 'string') headers.set(key, value);
			const upstream = await fetch(host.endpoint, {
				method: request.method ?? 'POST',
				headers,
				...(body.length === 0 ? {} : { body }),
				signal: AbortSignal.any([disconnected.signal, AbortSignal.timeout(30_000)]),
			});
			response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
			if (upstream.body !== null) for await (const chunk of upstream.body) response.write(chunk);
			response.end();
		})().catch((error: unknown) => {
			if (!response.headersSent) response.writeHead(502);
			response.end(String(error));
		});
	});
	capture.listen(0, '127.0.0.1');
	await once(capture, 'listening');
	const address = capture.address();
	if (address === null || typeof address === 'string') throw new Error('No capture port.');
	endpoint = `http://127.0.0.1:${address.port}/portal`;
	retireCapture = async () => {
		capture.closeAllConnections();
		await new Promise<void>((resolve, reject) =>
			capture.close((error) => (error === undefined ? resolve() : reject(error))),
		);
	};
} else {
	const input = new PassThrough();
	const lines = createInterface({ input: process.stdin });
	lines.on('line', (line) => {
		observe(line, null);
		input.write(`${line}\n`);
	});
	process.stdin.once('end', () => {
		lines.close();
		input.end();
		clientExited.resolve();
	});
	const host = await startStandaloneToolPortalMcpStdioServer({
		...common,
		authenticatedEnvelope: {
			audience: standaloneCredentials.audience,
			serviceGeneration: standaloneCredentials.serviceGeneration,
			principal: { ...principal.principal, credentialVersion: principal.credentialVersion },
		},
		input,
		output: process.stdout,
	});
	retireHost = host.retire;
}
await writeFile(receiptPath, JSON.stringify({ controlUrl, endpoint, childPid: process.pid }));
process.stderr.write(
	`PYTHON_MCP_HOST_READY ${JSON.stringify({ controlUrl, endpoint, childPid: process.pid })}\n`,
);
async function retire(): Promise<void> {
	if (retired) return;
	retired = true;
	hold?.release();
	await retireCapture();
	await retireHost();
	await fixture.close();
	await provider.close();
	control.closeAllConnections();
	await new Promise<void>((resolve, reject) =>
		control.close((error) => (error === undefined ? resolve() : reject(error))),
	);
	await writeFile(
		`${receiptPath}.closed`,
		JSON.stringify({ childPid: process.pid, effects: provider.effects, observations }),
	);
}
process.once('SIGTERM', () => {
	clientExited.resolve();
});
process.once('SIGINT', () => {
	clientExited.resolve();
});
await clientExited.promise;
await retire();
