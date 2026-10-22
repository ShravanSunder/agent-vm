import { appendFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

import { z } from 'zod';

// Deliberate old-only control: a probe must not consume the session child's lifetime.
const eventsPath = z.string().parse(process.argv[2]);
const effectsPath = z.string().parse(process.argv[3]);
const messageSchema = z.object({
	id: z.union([z.string(), z.number()]).optional(),
	method: z.string(),
	params: z.record(z.string(), z.unknown()).optional(),
});
await appendFile(eventsPath, `${JSON.stringify({ event: 'started', pid: process.pid })}\n`);
let initialized = false;
for await (const line of createInterface({ input: process.stdin })) {
	const message = messageSchema.parse(JSON.parse(line));
	await appendFile(
		eventsPath,
		`${JSON.stringify({ event: 'request', method: message.method, pid: process.pid })}\n`,
	);
	if (!initialized && message.method !== 'initialize') process.exit(23);
	if (message.method.startsWith('notifications/')) continue;
	let result: unknown;
	switch (message.method) {
		case 'initialize':
			initialized = true;
			result = {
				protocolVersion: '2025-11-25',
				capabilities: { tools: {} },
				serverInfo: { name: 'preinitialize-exit-control', version: '1' },
			};
			break;
		case 'tools/list':
			result = {
				tools: [
					{
						name: 'read',
						inputSchema: {
							type: 'object',
							properties: { value: { type: 'integer' } },
							required: ['value'],
						},
					},
				],
			};
			break;
		case 'tools/call':
			await appendFile(
				effectsPath,
				`${JSON.stringify({ pid: process.pid, arguments: message.params?.['arguments'] })}\n`,
			);
			result = { content: [{ type: 'text', text: 'legacy session survived disposable probe' }] };
			break;
		default:
			throw new Error(`Unexpected old-only request ${message.method}`);
	}
	process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
}
