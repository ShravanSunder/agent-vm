import { describe, expect, it } from 'vitest';

import { startNodeHost } from '#node-host/node-host-startup';
import {
	connectClient,
	decodedResult,
	fixtureConfig,
	fixtureDirectory,
	startControlledProvider,
	writeFixtureConfig,
} from '#node-host/test-fixtures/node-host-fixture';

function call(
	item: string,
	value = 42,
): {
	readonly name: string;
	readonly arguments: {
		readonly calls: readonly {
			readonly id: string;
			readonly namespace: string;
			readonly toolName: string;
			readonly arguments: { readonly value: number };
		}[];
	};
} {
	return {
		name: 'mcp_portal_call',
		arguments: {
			calls: [{ id: item, namespace: 'alpha', toolName: 'read', arguments: { value } }],
		},
	};
}

function outcome(result: unknown, item: string): unknown {
	const batch = decodedResult(result);
	const results = batch.results;
	if (typeof results !== 'object' || results === null || !(item in results))
		throw new Error('Missing batch item');
	return Reflect.get(results, item);
}

const secrets = { resolve: async (): Promise<string> => 'fixture-only-credential' };

describe('Node operation capacity through real HTTP ingress and dispatcher', () => {
	it('reserves exactly two fixture slots under overlapping creates, keeps reuse/conflict/lookup and restores capacity after restart without evicting history', async () => {
		const directory = await fixtureDirectory();
		const alpha = await startControlledProvider('alpha');
		const beta = await startControlledProvider('beta');
		const base = fixtureConfig(directory, [alpha.url, beta.url]);
		const config = {
			...base,
			operationStoreBounds: { ...base.operationStoreBounds, maximumOperations: 2 },
		};
		const configPath = await writeFixtureConfig(config, directory);
		const diagnostics: string[] = [];
		let host = await startNodeHost({
			configPath,
			secrets,
			onDiagnostic: (event) => {
				diagnostics.push(event);
			},
		});
		if (host.http === undefined) throw new Error('Missing HTTP ingress');
		let connection = await connectClient(host.http.endpoint, 'credential-a');
		try {
			// Network handlers overlap; provider effects are an independent oracle.
			const items = ['first', 'second', 'third'];
			const responses = await Promise.all(
				items.map(async (item) => connection.client.callTool(call(item))),
			);
			const entries = responses.map((result, index) => outcome(result, items[index] ?? 'missing'));
			expect(
				entries.filter(
					(entry) =>
						typeof entry === 'object' && entry !== null && 'ok' in entry && entry.ok === true,
				),
			).toHaveLength(2);
			expect(entries).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						ok: false,
						error: { kind: 'not-dispatched', reason: 'unavailable' },
					}),
				]),
			);
			expect(alpha.effects).toHaveLength(2);
			expect(diagnostics).toContain('operation-store-capacity');
			expect(diagnostics).not.toContain('operation-store-storage-failed');
			const admitted = items.filter((_item, index) => {
				const entry = entries[index];
				return typeof entry === 'object' && entry !== null && 'ok' in entry && entry.ok === true;
			});
			await Promise.all(
				admitted.map(async (item) => {
					const index = items.indexOf(item);
					expect(await connection.client.callTool(call(item))).toEqual(responses[index]);
					expect(outcome(await connection.client.callTool(call(item, 43)), item)).toMatchObject({
						ok: false,
						error: { kind: 'not-dispatched', reason: 'conflict' },
					});
					expect(
						await host.composition.operations.lookup({
							version: 'tool-operation-v1',
							key: { authority: config.authority, principal: 'agent-a', item },
							verifiedContextRef: 'agent-a:v1',
						}),
					).toMatchObject({ kind: 'found', record: { state: { kind: 'completed' } } });
				}),
			);
			expect(alpha.effects).toHaveLength(2);
			await connection.client.close();
			await host.retire();
			host = await startNodeHost({ configPath, secrets });
			if (host.http === undefined) throw new Error('Missing replacement ingress');
			connection = await connectClient(host.http.endpoint, 'credential-a');
			expect(
				outcome(await connection.client.callTool(call('after-restart')), 'after-restart'),
			).toMatchObject({ ok: false, error: { kind: 'not-dispatched', reason: 'unavailable' } });
			await Promise.all(
				admitted.map(async (item) => {
					expect(await connection.client.callTool(call(item))).toEqual(
						responses[items.indexOf(item)],
					);
					expect(
						await host.composition.operations.lookup({
							version: 'tool-operation-v1',
							key: { authority: config.authority, principal: 'agent-a', item },
							verifiedContextRef: 'agent-a:v1',
						}),
					).toMatchObject({ kind: 'found', record: { state: { kind: 'completed' } } });
				}),
			);
			expect(alpha.effects).toHaveLength(2);
		} finally {
			await connection.client.close();
			await host.retire();
			await alpha.close();
			await beta.close();
		}
	});

	it('keeps a known effect non-replayable when redaction expands a below-limit upstream result beyond the copied per-call bound', async () => {
		const directory = await fixtureDirectory();
		// 500,000 raw bytes become 5,000,000 bytes of [REDACTED], above 4 MiB.
		const alpha = await startControlledProvider('alpha', { resultText: 'x'.repeat(500_000) });
		const beta = await startControlledProvider('beta');
		const config = fixtureConfig(directory, [alpha.url, beta.url]);
		const configPath = await writeFixtureConfig(config, directory);
		const host = await startNodeHost({ configPath, secrets: { resolve: async () => 'x' } });
		if (host.http === undefined) throw new Error('Missing HTTP ingress');
		const connection = await connectClient(host.http.endpoint, 'credential-a');
		try {
			const result = await connection.client.callTool(call('expanded'));
			expect(outcome(result, 'expanded')).toMatchObject({
				ok: false,
				error: { kind: 'ambiguous' },
			});
			expect(alpha.effects).toHaveLength(1);
			expect(
				await host.composition.operations.lookup({
					version: 'tool-operation-v1',
					key: { authority: config.authority, principal: 'agent-a', item: 'expanded' },
					verifiedContextRef: 'agent-a:v1',
				}),
			).toMatchObject({ kind: 'found', record: { state: { kind: 'armed' } } });
			expect(outcome(await connection.client.callTool(call('expanded')), 'expanded')).toMatchObject(
				{ ok: false, error: { kind: 'ambiguous' } },
			);
			expect(alpha.effects).toHaveLength(1);
		} finally {
			await connection.client.close();
			await host.retire();
			await alpha.close();
			await beta.close();
		}
	});
});
