import { appendFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';

import { Server } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const eventsPath = z.string().parse(process.argv[2]);
const effectsPath = z.string().parse(process.argv[3]);
await appendFile(eventsPath, `${JSON.stringify({ event: 'started', pid: process.pid })}\n`);
const input = new PassThrough();
let delivered = Promise.resolve();
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
	delivered = delivered.then(async () => {
		const message = z
			.object({
				method: z.string(),
				params: z.object({ _meta: z.unknown().optional() }).passthrough().optional(),
			})
			.passthrough()
			.parse(JSON.parse(line));
		await appendFile(
			eventsPath,
			`${JSON.stringify({ event: 'request', pid: process.pid, method: message.method, meta: message.params?.['_meta'] })}\n`,
		);
		input.write(`${line}\n`);
	});
});
const serving = serveStdio(
	() => {
		const server = new Server(
			{ name: 'modern-stdio-only', version: '1' },
			{ capabilities: { tools: {} } },
		);
		server.setRequestHandler('tools/list', async () => ({
			tools: [{ name: 'read', inputSchema: { type: 'object' } }],
		}));
		server.setRequestHandler('tools/call', async (request) => {
			await appendFile(
				effectsPath,
				`${JSON.stringify({ pid: process.pid, arguments: request.params.arguments })}\n`,
			);
			return { content: [{ type: 'text', text: 'modern stdio once' }] };
		});
		return server;
	},
	{ legacy: 'reject', transport: new StdioServerTransport(input, process.stdout) },
);
process.stdin.once('end', () => {
	void delivered.then(async () => {
		lines.close();
		input.end();
		await serving.close();
	});
});
