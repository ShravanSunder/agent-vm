import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { startNodeHost, nodeHostConfigSchema } from '@agent-collaboration/tool-host-node';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
	connectClient,
	decodedResult,
	fixtureConfig,
	fixtureDirectory,
	headerCanary,
	secretCanary,
	startControlledProvider,
	successfulOutput,
	writeFixtureConfig,
} from '#node-host/test-fixtures/node-host-fixture';

const hostBinary = path.resolve('packages/tool-host-node/dist/bin/tool-host-node.js');
const stdioProvider = path.resolve(
	'packages/tool-host-node/src/test-fixtures/controlled-stdio-provider.ts',
);

function childEnvironment(): Record<string, string> {
	return {
		...Object.fromEntries(
			Object.entries(process.env).filter(
				(entry): entry is [string, string] => entry[1] !== undefined,
			),
		),
		PROVIDER_SECRET: secretCanary,
		HEADER_SECRET: headerCanary,
	};
}

function startHostProcess(configPath: string): {
	readonly child: ChildProcessWithoutNullStreams;
	readonly exited: Promise<readonly [number | null, NodeJS.Signals | null]>;
	readonly stderr: string[];
} {
	const child = spawn(process.execPath, [hostBinary, configPath], {
		env: childEnvironment(),
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	const stderr: string[] = [];
	child.stderr.on('data', (chunk: Buffer) => stderr.push(String(chunk)));
	const exited = new Promise<readonly [number | null, NodeJS.Signals | null]>((resolve, reject) => {
		child.once('error', reject);
		child.once('exit', (code, signal) => resolve([code, signal]));
	});
	return { child, exited, stderr };
}

describe('J1 Node: built HTTP and spawned stdio hosts', () => {
	it('serves the built CLI over real HTTP with the pinned SDK Client, then retires cleanly', async () => {
		const directory = await fixtureDirectory();
		const alpha = await startControlledProvider('alpha');
		const beta = await startControlledProvider('beta');
		const configPath = await writeFixtureConfig(
			fixtureConfig(directory, [alpha.url, beta.url]),
			directory,
		);
		const processHandle = startHostProcess(configPath);
		const lines = createInterface({ input: processHandle.child.stdout });
		try {
			const ready = await Promise.race([
				once(lines, 'line').then(([line]) =>
					z
						.object({ event: z.literal('ready'), endpoint: z.url() })
						.parse(JSON.parse(String(line))),
				),
				processHandle.exited.then((status) => {
					throw new Error(
						`Host exited before readiness: ${JSON.stringify(status)} ${processHandle.stderr.join('')}`,
					);
				}),
			]);
			const contender = startHostProcess(configPath);
			const contenderOutput: string[] = [];
			contender.child.stdout.on('data', (chunk: Buffer) => contenderOutput.push(String(chunk)));
			expect(await contender.exited).toEqual([1, null]);
			expect(contenderOutput).toEqual([]);
			expect(contender.stderr.join('')).toContain('Tool host startup refused.');
			const a = await connectClient(new URL(ready.endpoint), 'credential-a');
			const b = await connectClient(new URL(ready.endpoint), 'credential-b');
			try {
				const call = {
					name: 'mcp_portal_call',
					arguments: {
						calls: [
							{
								id: 'persist-across-reconnect',
								namespace: 'alpha',
								toolName: 'read',
								arguments: { value: 42 },
							},
						],
					},
				};
				expect(
					successfulOutput(await a.client.callTool(call), 'persist-across-reconnect'),
				).toMatchObject({
					namespace: 'alpha',
					result: { content: [{ type: 'text', text: 'alpha:42' }] },
				});
				await a.client.close();
				const reconnect = await connectClient(new URL(ready.endpoint), 'credential-a');
				try {
					await reconnect.client.callTool(call);
				} finally {
					await reconnect.client.close();
				}
				expect(alpha.effects).toHaveLength(1);
				await b.client.callTool({
					name: 'mcp_portal_call',
					arguments: {
						calls: [{ id: 'b-item', namespace: 'beta', toolName: 'read', arguments: { value: 7 } }],
					},
				});
				expect(beta.effects).toEqual([
					{
						name: 'read',
						arguments: { value: 7 },
						authorization: `Bearer ${secretCanary}`,
						selectedHeader: headerCanary,
					},
				]);
			} finally {
				await a.client.close();
				await b.client.close();
			}
			processHandle.child.kill('SIGTERM');
			expect(await processHandle.exited).toEqual([0, null]);
			expect(processHandle.stderr.join('')).not.toContain(secretCanary);
			const replacement = startHostProcess(configPath);
			const replacementLines = createInterface({ input: replacement.child.stdout });
			try {
				const [readyLine] = await once(replacementLines, 'line');
				const readyReplacement = z
					.object({ event: z.literal('ready'), endpoint: z.url() })
					.parse(JSON.parse(String(readyLine)));
				const client = await connectClient(new URL(readyReplacement.endpoint), 'credential-a');
				try {
					expect(
						successfulOutput(
							await client.client.callTool({
								name: 'mcp_portal_call',
								arguments: {
									calls: [
										{
											id: 'persist-across-reconnect',
											namespace: 'alpha',
											toolName: 'read',
											arguments: { value: 42 },
										},
									],
								},
							}),
							'persist-across-reconnect',
						),
					).toMatchObject({ namespace: 'alpha', toolName: 'read' });
					expect(alpha.effects).toHaveLength(1);
				} finally {
					await client.client.close();
				}
				replacement.child.kill('SIGTERM');
				expect(await replacement.exited).toEqual([0, null]);
			} finally {
				replacementLines.close();
				if (replacement.child.exitCode === null) replacement.child.kill('SIGTERM');
				await replacement.exited;
			}
		} finally {
			lines.close();
			if (processHandle.child.exitCode === null) processHandle.child.kill('SIGTERM');
			await processHandle.exited;
			await alpha.close();
			await beta.close();
		}
	}, 15_000);
	it('binds spawned stdio to its configured identity; preserves compact item across JSON-RPC ids and exits on EOF', async () => {
		const directory = await fixtureDirectory();
		const alpha = await startControlledProvider('alpha');
		const beta = await startControlledProvider('beta');
		const config = nodeHostConfigSchema.parse({
			...fixtureConfig(directory, [alpha.url, beta.url]),
			listener: { kind: 'stdio', agentId: 'agent-a' },
		});
		const configPath = await writeFixtureConfig(config, directory);
		const processHandle = startHostProcess(configPath);
		const lines = createInterface({ input: processHandle.child.stdout });
		const pending = new Map<
			number,
			{ readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }
		>();
		lines.on('line', (line: string) => {
			const parsed = z
				.object({ jsonrpc: z.literal('2.0'), id: z.number().optional() })
				.passthrough()
				.parse(JSON.parse(line));
			if (parsed.id !== undefined) {
				pending.get(parsed.id)?.resolve(parsed);
				pending.delete(parsed.id);
			}
		});
		const send = async (
			id: number,
			method: string,
			params: unknown,
		): Promise<Record<string, unknown>> => {
			const response = new Promise<unknown>((resolve, reject) =>
				pending.set(id, { resolve, reject }),
			);
			processHandle.child.stdin.write(
				`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
			);
			return z.record(z.string(), z.unknown()).parse(
				await Promise.race([
					response,
					processHandle.exited.then(() => {
						throw new Error('Host exited before protocol response');
					}),
				]),
			);
		};
		try {
			const initialized = await send(0, 'initialize', {
				protocolVersion: '2025-06-18',
				capabilities: {},
				clientInfo: { name: 'pretend-agent-b', version: '1' },
			});
			expect(initialized.error).toBeUndefined();
			processHandle.child.stdin.write(
				`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
			);
			const listed = await send(1, 'tools/list', {});
			expect(JSON.stringify(listed)).toContain('mcp_portal_call');
			const call = {
				name: 'mcp_portal_call',
				arguments: {
					calls: [
						{
							id: 'stdio-stable-item',
							namespace: 'alpha',
							toolName: 'read',
							arguments: { value: 42 },
						},
					],
				},
			};
			expect(
				successfulOutput((await send(2, 'tools/call', call)).result, 'stdio-stable-item'),
			).toMatchObject({ namespace: 'alpha', toolName: 'read' });
			expect(await send(3, 'tools/call', call)).toMatchObject({
				result: (await send(4, 'tools/call', call)).result,
			});
			const spoof = await send(5, 'tools/call', {
				name: 'mcp_portal_call',
				arguments: { principal: 'agent-b', ...call.arguments },
			});
			expect(spoof).toMatchObject({ result: { isError: true } });
			expect(alpha.effects).toHaveLength(1);
			expect(beta.effects).toEqual([]);
			processHandle.child.stdin.end();
			expect(await processHandle.exited).toEqual([0, null]);
			expect(processHandle.stderr.join('')).not.toContain(secretCanary);
		} finally {
			lines.close();
			if (processHandle.child.exitCode === null) processHandle.child.kill('SIGTERM');
			await processHandle.exited;
			await alpha.close();
			await beta.close();
		}
	}, 15_000);
	it('selects real stdio and HTTP upstreams by configuration and redacts stdio catalog/result/error/stderr', async () => {
		const directory = await fixtureDirectory();
		const alpha = await startControlledProvider('alpha');
		const unusedBeta = await startControlledProvider('unused');
		const original = fixtureConfig(directory, [alpha.url, unusedBeta.url]);
		const effectsPath = path.join(directory, 'stdio-effects.jsonl');
		const profileA = original.profiles['profile-a'];
		const profileB = original.profiles['profile-b'];
		if (profileA === undefined || profileB === undefined)
			throw new Error('Missing fixture profile');
		const config = nodeHostConfigSchema.parse({
			...original,
			profiles: {
				...original.profiles,
				'profile-a': {
					...profileA,
					profile: {
						...profileA.profile,
						namespaces: { ...profileA.profile.namespaces, ...profileB.profile.namespaces },
					},
				},
			},
			mcp: {
				...original.mcp,
				providers: {
					...original.mcp.providers,
					beta: {
						kind: 'mcp',
						namespace: 'beta',
						transport: {
							kind: 'stdio',
							command: process.execPath,
							args: [stdioProvider, effectsPath],
							env: { PROVIDER_SECRET: { source: 'environment', name: 'PROVIDER_SECRET' } },
						},
					},
				},
			},
		});
		const configPath = await writeFixtureConfig(config, directory);
		const diagnostics: string[] = [];
		const host = await startNodeHost({
			configPath,
			secrets: {
				resolve: async (secret) =>
					secret.source === 'environment' && secret.name === 'PROVIDER_SECRET'
						? secretCanary
						: headerCanary,
			},
			onDiagnostic: (event) => diagnostics.push(event),
		});
		if (host.http === undefined) throw new Error('Missing HTTP listener');
		const a = await connectClient(host.http.endpoint, 'credential-a');
		try {
			const catalog = await a.client.callTool({
				name: 'mcp_portal_list',
				arguments: { requests: [{ id: 'catalog' }] },
			});
			expect(JSON.stringify(catalog)).not.toContain(secretCanary);
			await a.client.callTool({
				name: 'mcp_portal_call',
				arguments: {
					calls: [
						{ id: 'http-item', namespace: 'alpha', toolName: 'read', arguments: { value: 1 } },
						{ id: 'stdio-item', namespace: 'beta', toolName: 'read', arguments: { value: 2 } },
					],
				},
			});
			const failed = await a.client.callTool({
				name: 'mcp_portal_call',
				arguments: {
					calls: [
						{ id: 'stdio-error', namespace: 'beta', toolName: 'fail', arguments: { value: 3 } },
					],
				},
			});
			expect(failed).toMatchObject({ isError: true });
			expect(decodedResult(failed)).toMatchObject({
				ok: false,
				results: {
					'stdio-error': {
						ok: false,
						error: { kind: 'ambiguous', reason: 'resource-authority-unconfirmed' },
					},
				},
			});
			expect(JSON.stringify({ catalog, failed, diagnostics })).not.toContain(secretCanary);
			expect(alpha.effects.map((effect) => effect.arguments)).toEqual([{ value: 1 }]);
			const effects = (await readFile(effectsPath, 'utf8'))
				.trim()
				.split('\n')
				.map((line) =>
					z
						.object({ name: z.string(), arguments: z.unknown(), pid: z.number() })
						.parse(JSON.parse(line)),
				);
			expect(
				effects.map(({ name, arguments: arguments_ }) => ({ name, arguments: arguments_ })),
			).toEqual([
				{ name: 'read', arguments: { value: 2 } },
				{ name: 'fail', arguments: { value: 3 } },
			]);
		} finally {
			await a.client.close();
			await host.retire();
			await alpha.close();
			await unusedBeta.close();
		}
	}, 15_000);
});
