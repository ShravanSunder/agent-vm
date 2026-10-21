import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
	createNodeStdioUpstreamRuntime,
	createNodeStdioUpstreamTransport,
} from '@agent-collaboration/tool-host-node';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { fixtureDirectory, secretCanary } from '#node-host/test-fixtures/node-host-fixture';

describe('real Node outgoing stdio process boundary', () => {
	it('isolates scopes, redacts result/error/stderr, forwards progress and cancellation, and closes one scope without retiring its sibling', async () => {
		const directory = await fixtureDirectory();
		const effectsPath = path.join(directory, 'stdio-runtime-effects.jsonl');
		const stderr: string[] = [];
		let cancellationObserved: (() => void) | undefined;
		const cancelled = new Promise<void>((resolve) => {
			cancellationObserved = resolve;
		});
		const runtime = createNodeStdioUpstreamRuntime({
			servers: [
				{
					namespace: 'stdio',
					transport: 'stdio',
					command: process.execPath,
					args: [
						path.resolve('packages/tool-host-node/src/test-fixtures/controlled-stdio-provider.ts'),
						effectsPath,
					],
					env: { PROVIDER_SECRET: secretCanary },
				},
			],
			createUpstreamMcpTransport: createNodeStdioUpstreamTransport({
				stderr: (text) => {
					stderr.push(text);
					if (stderr.join('').includes('controlled-cancelled')) cancellationObserved?.();
				},
			}),
		});
		try {
			const catalog = await runtime.listTools({ agentScopeId: 'scope-a', namespace: 'stdio' });
			expect(catalog.map((tool) => tool.name)).toEqual(['read', 'fail', 'progress', 'wait']);
			expect(JSON.stringify(catalog)).not.toContain(secretCanary);
			const a = await runtime.callTool({
				agentScopeId: 'scope-a',
				namespace: 'stdio',
				toolName: 'read',
				arguments: { value: 1 },
			});
			const b = await runtime.callTool({
				agentScopeId: 'scope-b',
				namespace: 'stdio',
				toolName: 'read',
				arguments: { value: 2 },
			});
			expect(a).toMatchObject({
				content: [{ type: 'text', text: 'stdio:1' }],
				structuredContent: { value: 1, secret: '[REDACTED]' },
			});
			expect(b).toMatchObject({ content: [{ type: 'text', text: 'stdio:2' }] });
			const initial = (await readFile(effectsPath, 'utf8'))
				.trim()
				.split('\n')
				.map((line) => z.object({ pid: z.number() }).parse(JSON.parse(line)));
			expect(new Set(initial.map((record) => record.pid)).size).toBe(2);
			await runtime.closeAgentScope('scope-a');
			const events: unknown[] = [];
			await runtime.callTool({
				agentScopeId: 'scope-b',
				namespace: 'stdio',
				toolName: 'progress',
				arguments: { value: 3 },
				onEvent: (event) => {
					events.push(event);
				},
			});
			expect(events).toEqual([
				{ kind: 'progress', message: 'progress [REDACTED]', progress: 1, total: 1 },
			]);
			await expect(
				runtime.callTool({
					agentScopeId: 'scope-b',
					namespace: 'stdio',
					toolName: 'fail',
					arguments: { value: 4 },
				}),
			).rejects.toMatchObject({
				details: {
					phase: 'call_tool',
					failureClass: 'tool_error',
					providerErrorMessage: 'provider tool failure [REDACTED]',
				},
			});
			let entered: (() => void) | undefined;
			const waiting = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const controller = new AbortController();
			const pending = runtime
				.callTool({
					agentScopeId: 'scope-b',
					namespace: 'stdio',
					toolName: 'wait',
					arguments: { value: 5 },
					signal: controller.signal,
					onEvent: (event) => {
						if (event.kind === 'progress' && event.message === 'waiting') entered?.();
					},
				})
				.then(
					() => ({ kind: 'unexpected' }),
					(error: unknown) => ({
						kind: 'aborted',
						error: error instanceof Error ? error.message : String(error),
					}),
				);
			await waiting;
			controller.abort(new Error('caller cancelled'));
			expect(await pending).toMatchObject({ kind: 'aborted' });
			await cancelled;
			expect(JSON.stringify({ a, b, events, stderr })).not.toContain(secretCanary);
			expect(
				(await readFile(effectsPath, 'utf8'))
					.trim()
					.split('\n')
					.map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line))),
			).toEqual(expect.arrayContaining([expect.objectContaining({ event: 'cancelled' })]));
		} finally {
			await runtime.closeAgentScope('scope-a');
			await runtime.closeAgentScope('scope-b');
		}
	}, 15_000);
});
