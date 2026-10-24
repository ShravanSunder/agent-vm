import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
	createNodeStdioUpstreamRuntime,
	createNodeStdioUpstreamTransport,
} from '@agent-collaboration/tool-host-node';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { fixtureDirectory, secretCanary } from '#node-host/test-fixtures/node-host-fixture';

// This deadline distinguishes caller cancellation from the provider's 12-second timeout.
async function withinCancellationDeadline<TResult>(operation: Promise<TResult>): Promise<TResult> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() =>
						reject(new Error('Caller cancellation did not reach the provider within 1 second.')),
					1000,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

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
			expect(await withinCancellationDeadline(pending)).toMatchObject({ kind: 'aborted' });
			await withinCancellationDeadline(cancelled);
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

it('keeps SDK stdio identity so an old server can exit on the disposable probe and still execute once', async () => {
	const directory = await fixtureDirectory();
	const eventsPath = path.join(directory, 'preinit-events.jsonl');
	const effectsPath = path.join(directory, 'preinit-effects.jsonl');
	const runtime = createNodeStdioUpstreamRuntime({
		servers: [
			{
				namespace: 'old-only',
				transport: 'stdio',
				command: process.execPath,
				args: [
					path.resolve(
						'packages/tool-host-node/src/test-fixtures/preinitialize-exit-stdio-provider.ts',
					),
					eventsPath,
					effectsPath,
				],
			},
		],
		createUpstreamMcpTransport: createNodeStdioUpstreamTransport(),
	});
	try {
		expect(
			(await runtime.listTools({ agentScopeId: 'legacy-scope', namespace: 'old-only' })).map(
				(tool) => tool.name,
			),
		).toEqual(['read']);
		expect(
			await runtime.callTool({
				agentScopeId: 'legacy-scope',
				namespace: 'old-only',
				toolName: 'read',
				arguments: { value: 23 },
			}),
		).toMatchObject({
			content: [{ type: 'text', text: 'legacy session survived disposable probe' }],
		});
	} finally {
		await runtime.closeAgentScope('legacy-scope');
	}
	const recordSchema = z.object({
		event: z.string(),
		pid: z.number(),
		method: z.string().optional(),
	});
	const events = (await readFile(eventsPath, 'utf8'))
		.trim()
		.split('\n')
		.map((line) => recordSchema.parse(JSON.parse(line)));
	const effects = (await readFile(effectsPath, 'utf8'))
		.trim()
		.split('\n')
		.map((line) =>
			z
				.object({ pid: z.number(), arguments: z.object({ value: z.number() }) })
				.parse(JSON.parse(line)),
		);
	expect(effects).toEqual([{ pid: expect.any(Number), arguments: { value: 23 } }]);
	expect(events.some((entry) => entry.method === 'server/discover')).toBe(true);
	expect(events.filter((entry) => entry.method === 'initialize')).toHaveLength(1);
	const children = new Set(
		events.filter((entry) => entry.event === 'started').map((entry) => entry.pid),
	);
	expect(children.size).toBeGreaterThanOrEqual(2);
	for (const pid of children) expect(() => process.kill(pid, 0)).toThrow();
	process.stdout.write(
		`${JSON.stringify({ legacyStdioEvents: events, effects, closedPids: [...children] })}\n`,
	);
}, 15000);

it('uses modern stdio without initialize, executes once and reaps its SDK probe/session processes', async () => {
	const directory = await fixtureDirectory();
	const eventsPath = path.join(directory, 'modern-events.jsonl');
	const effectsPath = path.join(directory, 'modern-effects.jsonl');
	const runtime = createNodeStdioUpstreamRuntime({
		servers: [
			{
				namespace: 'modern',
				transport: 'stdio',
				command: process.execPath,
				args: [
					path.resolve('packages/tool-host-node/src/test-fixtures/modern-stdio-provider.ts'),
					eventsPath,
					effectsPath,
				],
			},
		],
		createUpstreamMcpTransport: createNodeStdioUpstreamTransport(),
	});
	try {
		expect(
			(await runtime.listTools({ agentScopeId: 'modern-scope', namespace: 'modern' })).map(
				(tool) => tool.name,
			),
		).toEqual(['read']);
		expect(
			await runtime.callTool({
				agentScopeId: 'modern-scope',
				namespace: 'modern',
				toolName: 'read',
				arguments: { value: 47 },
			}),
		).toMatchObject({ content: [{ type: 'text', text: 'modern stdio once' }] });
	} finally {
		await runtime.closeAgentScope('modern-scope');
	}
	const events = (await readFile(eventsPath, 'utf8'))
		.trim()
		.split('\n')
		.map((line) =>
			z
				.object({
					event: z.string(),
					pid: z.number(),
					method: z.string().optional(),
					meta: z.record(z.string(), z.unknown()).optional(),
				})
				.parse(JSON.parse(line)),
		);
	const effects = (await readFile(effectsPath, 'utf8'))
		.trim()
		.split('\n')
		.map((line) =>
			z
				.object({ pid: z.number(), arguments: z.object({ value: z.number() }) })
				.parse(JSON.parse(line)),
		);
	expect(effects).toEqual([{ pid: expect.any(Number), arguments: { value: 47 } }]);
	expect(events.filter((event) => event.method === 'initialize')).toHaveLength(0);
	expect(events.filter((event) => event.method === 'server/discover')).toHaveLength(1);
	expect(
		events
			.filter((event) => event.method === 'tools/call')
			.map((event) => event.meta?.['io.modelcontextprotocol/protocolVersion']),
	).toEqual(['2026-07-28']);
	const children = new Set(
		events.filter((event) => event.event === 'started').map((event) => event.pid),
	);
	expect(children.size).toBeGreaterThanOrEqual(2);
	for (const pid of children) expect(() => process.kill(pid, 0)).toThrow();
	process.stdout.write(
		`${JSON.stringify({ modernStdioEvents: events, effects, closedPids: [...children] })}\n`,
	);
}, 15000);
