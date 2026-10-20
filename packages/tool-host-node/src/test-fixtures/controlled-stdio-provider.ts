import { appendFile } from 'node:fs/promises';
import { Writable } from 'node:stream';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const effectsPath = process.argv[2];
if (effectsPath === undefined)
	throw new Error('The controlled provider needs an owned effect file.');
const server = new Server(
	{ name: 'controlled-stdio-provider', version: '1.0.0' },
	{ capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: ['read', 'fail', 'progress', 'wait'].map((name) => ({
		name,
		inputSchema: {
			type: 'object',
			properties: { value: { type: 'integer' } },
			required: ['value'],
			additionalProperties: false,
		},
		description: `controlled ${process.env.PROVIDER_SECRET ?? ''}`,
	})),
}));
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
	await appendFile(
		effectsPath,
		`${JSON.stringify({ name: request.params.name, arguments: request.params.arguments, pid: process.pid })}\n`,
	);
	if (request.params.name === 'fail')
		process.stderr.write(`stdio diagnostic ${process.env.PROVIDER_SECRET ?? ''}\n`);
	const token = extra['_meta']?.progressToken;
	if (request.params.name === 'wait') {
		if (token !== undefined)
			await extra.sendNotification({
				method: 'notifications/progress',
				params: { progressToken: token, progress: 0, total: 1, message: 'waiting' },
			});
		await new Promise<void>((resolve) => {
			if (extra.signal.aborted) resolve();
			else extra.signal.addEventListener('abort', () => resolve(), { once: true });
		});
		await appendFile(effectsPath, `${JSON.stringify({ event: 'cancelled', pid: process.pid })}\n`);
		process.stderr.write('controlled-cancelled\n');
	}
	if (request.params.name === 'progress' && token !== undefined)
		await extra.sendNotification({
			method: 'notifications/progress',
			params: {
				progressToken: token,
				progress: 1,
				total: 1,
				message: `progress ${process.env.PROVIDER_SECRET ?? ''}`,
			},
		});
	return {
		content: [
			{
				type: 'text',
				text:
					request.params.name === 'fail'
						? `provider tool failure ${process.env.PROVIDER_SECRET ?? ''}`
						: `stdio:${String(request.params.arguments?.value)}`,
			},
		],
		structuredContent: {
			value: request.params.arguments?.value,
			secret: process.env.PROVIDER_SECRET ?? '',
			cache: process.env.UV_CACHE_DIR ?? '',
		},
		...(request.params.name === 'fail' ? { isError: true } : {}),
	};
});
process.stdin.once('end', () => {
	void server.close();
});
// Force a legal pipe segmentation: progress and its result arrive in one data chunk.
// SDK send completion means written, not that the remote notification handler ran.
let heldProgress = '';
const output = new Writable({
	write(chunk: Buffer, _encoding, callback): void {
		const text = chunk.toString('utf8');
		if (text.includes('"method":"notifications/progress"') && text.includes('"progress":1')) {
			heldProgress = text;
			callback();
			return;
		}
		const combined = heldProgress + text;
		heldProgress = '';
		process.stdout.write(combined, callback);
	},
});
await server.connect(new StdioServerTransport(process.stdin, output));
