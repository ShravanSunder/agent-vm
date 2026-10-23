import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { requestPortalCompositionApprovalRun } from '#agent-vm/integration-tests/portal-composition-approval-test-fixture';

async function readBody(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of request)
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** A protocol stand-in tests the driver; the CI Hermes journey owns native presentation proof. */
async function startRunProtocolFixture(
	mode: 'approval' | 'missing-approval' | 'wrong-run',
): Promise<{
	readonly port: number;
	readonly choices: readonly unknown[];
	readonly starts: readonly unknown[];
	readonly close: () => Promise<void>;
}> {
	const choices: unknown[] = [];
	const starts: unknown[] = [];
	const streams = new Map<string, ServerResponse>();
	const server = createServer((request, response) => {
		void (async () => {
			expect(request.headers.authorization).toBe('Bearer fixture-key');
			if (request.url === '/p/main/v1/runs' && request.method === 'POST') {
				starts.push(await readBody(request));
				response
					.writeHead(202, { 'content-type': 'application/json' })
					.end(JSON.stringify({ run_id: `run-${starts.length}` }));
				return;
			}
			const match = /^\/p\/main\/v1\/runs\/(run-\d+)\/(events|approval)$/u.exec(request.url ?? '');
			const runId = match?.[1];
			if (runId === undefined) {
				response.writeHead(404).end();
				return;
			}
			const frame = (event: string, fields: Readonly<Record<string, unknown>>): string =>
				`event: ${event}\ndata: ${JSON.stringify({ event, run_id: runId, ...fields })}\n\n`;
			if (match?.[2] === 'events') {
				response.writeHead(200, { 'content-type': 'text/event-stream' });
				if (mode === 'missing-approval') {
					response.end(frame('run.completed', { output: 'finished' }));
					return;
				}
				if (mode === 'wrong-run') {
					response.end(frame('run.completed', { run_id: 'other-run', output: 'finished' }));
					return;
				}
				streams.set(runId, response);
				const pending = frame('approval.request', {
					request_id: `${runId}-request`,
					command: 'Approve fixture.write once?',
					choices: ['once', 'deny'],
				});
				// A real stream may split a frame at any byte; its comment is not JSON.
				response.write(': keepalive\n\n');
				response.write(pending.slice(0, 17));
				response.write(pending.slice(17));
				return;
			}
			const choice = z
				.object({ request_id: z.literal(`${runId}-request`), choice: z.enum(['once', 'deny']) })
				.parse(await readBody(request));
			choices.push(choice);
			response
				.writeHead(200, { 'content-type': 'application/json' })
				.end(JSON.stringify({ ...choice, run_id: runId, resolved: 1 }));
			streams.get(runId)?.end(frame('run.completed', { output: `${runId}-finished` }));
		})().catch((error: unknown) => {
			response.writeHead(500).end(String(error));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (address === null || typeof address === 'string') throw new Error('Missing fixture port');
	return {
		port: address.port,
		choices,
		starts,
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error === undefined ? resolve() : reject(error))),
			);
		},
	};
}

describe('native run approval protocol driver', () => {
	it('drives separate runs with exact request identity and once then deny', async () => {
		const fixture = await startRunProtocolFixture('approval');
		const base = {
			gatewayPort: fixture.port,
			agentId: 'main',
			apiServerKey: 'fixture-key',
			modelName: 'fixture-model',
			prompt: 'same program',
		};
		try {
			expect(
				await requestPortalCompositionApprovalRun({
					...base,
					sessionId: 'first',
					onApproval: async () => 'once',
				}),
			).toBe('run-1-finished');
			expect(
				await requestPortalCompositionApprovalRun({
					...base,
					sessionId: 'second',
					onApproval: async () => 'deny',
				}),
			).toBe('run-2-finished');
			expect(fixture.starts).toEqual([
				{ input: 'same program', model: 'fixture-model', session_id: 'first' },
				{ input: 'same program', model: 'fixture-model', session_id: 'second' },
			]);
			expect(fixture.choices).toEqual([
				{ request_id: 'run-1-request', choice: 'once' },
				{ request_id: 'run-2-request', choice: 'deny' },
			]);
		} finally {
			await fixture.close();
		}
	});

	it.each(['missing-approval', 'wrong-run'] as const)(
		'rejects %s instead of accepting a completion marker',
		async (mode) => {
			const fixture = await startRunProtocolFixture(mode);
			try {
				await expect(
					requestPortalCompositionApprovalRun({
						gatewayPort: fixture.port,
						agentId: 'main',
						apiServerKey: 'fixture-key',
						modelName: 'fixture-model',
						prompt: 'same program',
						sessionId: 'first',
						onApproval: async () => 'once',
					}),
				).rejects.toThrow(mode === 'wrong-run' ? 'different run' : 'one native approval');
				expect(fixture.choices).toHaveLength(0);
			} finally {
				await fixture.close();
			}
		},
	);
});
