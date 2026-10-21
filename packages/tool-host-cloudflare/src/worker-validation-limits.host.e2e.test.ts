import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';
import { z } from 'zod';

import { startLegacyProxyReference } from '#worker-host/test-fixtures/legacy-proxy-reference';
import { startLocalWorkerHarness } from '#worker-host/test-fixtures/local-worker-harness';

import { startNodeHost } from '../../tool-host-node/src/node-host-startup.js';
import { fixtureConfig } from '../../tool-host-node/src/test-fixtures/node-host-fixture.js';

// Independent contract values, deliberately not imported from the limit implementation.
const replyLimit = 16 * 1024 * 1024;
function bytes(text: string): number {
	return new TextEncoder().encode(text).byteLength;
}
function expectedWorkerBytes(result: Record<string, unknown>, id: string): number {
	return bytes(
		JSON.stringify({
			jsonrpc: '2.0',
			id,
			result: {
				...result,
				resultType: 'complete',
				_meta: {
					'io.modelcontextprotocol/serverInfo': {
						name: 'tool-host-cloudflare',
						version: '0.0.153',
					},
				},
			},
		}),
	);
}
function validationCalls(): Record<string, unknown> {
	return {
		calls: Array.from({ length: 50 }, (_, index) => ({
			id: String(index),
			namespace: 'same-server',
			toolName: 'read',
			arguments: { value: 'invalid' },
		})),
	};
}
function callResult(text: string): Record<string, unknown> {
	return z.object({ result: z.record(z.string(), z.unknown()) }).parse(JSON.parse(text)).result;
}
function surfaceOf(result: Record<string, unknown>): Record<string, unknown> {
	const { _meta, resultType, ...surface } = result;
	expect(resultType).toBe('complete');
	expect(_meta).toBeDefined();
	return surface;
}
function items(
	result: Record<string, unknown>,
): readonly { readonly error: { readonly code: string } }[] {
	const text = z.object({ content: z.tuple([z.object({ text: z.string() })]) }).parse(result)
		.content[0].text;
	return z
		.object({ items: z.array(z.object({ error: z.object({ code: z.string() }) })) })
		.parse(JSON.parse(text)).items;
}

it.each([51, 8000])(
	'refuses raw%s malformed calls before effects or an oversized reply',
	async (count) => {
		const harness = await startLocalWorkerHarness();
		try {
			const input = { calls: Array.from({ length: count }, () => ({})) };
			expect(bytes(JSON.stringify(input))).toBe(count * 3 + 11);
			const response = await harness.rpc('tools/call', {
				name: 'mcp_portal_call',
				arguments: input,
			});
			const text = await response.text();
			expect(response.status).toBe(200);
			expect(bytes(text)).toBeLessThanOrEqual(replyLimit);
			expect(text).toContain('too_many_calls');
			expect(text).not.toContain('invalid_portal_input');
			expect(harness.fixture.calls).toHaveLength(0);
			expect(
				z.array(z.unknown()).parse(await (await harness.worker.fetch('/__points')).json()),
			).toHaveLength(0);
			process.stdout.write(
				`${JSON.stringify({ rawMalformed: { count, argumentBytes: bytes(JSON.stringify(input)), wireBytes: bytes(text), effects: 0 } })}\n`,
			);
		} finally {
			await harness.close();
		}
	},
);

it('budgets 50 validation failures at16MiB minus/plus1 and leaves the real Node proxy unchanged', async () => {
	const harness = await startLocalWorkerHarness();
	const directory = await mkdtemp(path.join(tmpdir(), '2026-10-s6-validation-budget-'));
	const input = validationCalls();
	const setEnum = (length: number): void =>
		harness.fixture.setCatalog([
			{
				name: 'read',
				inputSchema: {
					type: 'object',
					properties: { value: { type: 'string', enum: ['e'.repeat(length)] } },
					required: ['value'],
					additionalProperties: false,
				},
			},
		]);
	const oldResultFor = async (
		argumentsValue: Record<string, unknown>,
	): Promise<Record<string, unknown>> => {
		const reference = await startLegacyProxyReference(harness.fixture.url, 'indirect');
		try {
			return z
				.record(z.string(), z.unknown())
				.parse(
					await reference.client.callTool({ name: 'mcp_portal_call', arguments: argumentsValue }),
				);
		} finally {
			await reference.close();
		}
	};
	const oldResultAt = async (length: number): Promise<Record<string, unknown>> => {
		setEnum(length);
		return oldResultFor(input);
	};

	let node: Awaited<ReturnType<typeof startNodeHost>> | undefined;
	try {
		// Calibrate using two actual original-proxy responses. No production size helper is the oracle.
		const small = await oldResultAt(256);
		const next = await oldResultAt(257);
		expect(items(small).map((item) => item.error.code)).toEqual(
			Array.from({ length: 50 }, () => 'input_validation'),
		);
		const base = expectedWorkerBytes(small, 'proof');
		const slope = expectedWorkerBytes(next, 'proof') - base;
		expect(slope).toBeGreaterThan(0);
		const enumLength = 256 + Math.floor((replyLimit - 1 - base) / slope);
		const expected = await oldResultAt(enumLength);
		const padding = replyLimit - 1 - expectedWorkerBytes(expected, 'proof');
		expect(padding).toBeGreaterThanOrEqual(0);
		expect(padding).toBeLessThan(slope);
		const underId = 'proof' + 'p'.repeat(padding);
		expect(expectedWorkerBytes(expected, underId)).toBe(replyLimit - 1);
		expect(expectedWorkerBytes(expected, underId + 'pp')).toBe(replyLimit + 1);
		const under = await (
			await harness.rpc(
				'tools/call',
				{ name: 'mcp_portal_call', arguments: input },
				{ id: underId },
			)
		).text();
		expect(bytes(under)).toBe(replyLimit - 1);
		expect(surfaceOf(callResult(under))).toEqual(expected);
		expect(items(callResult(under))).toHaveLength(50);
		const exact = await (
			await harness.rpc(
				'tools/call',
				{ name: 'mcp_portal_call', arguments: input },
				{ id: underId + 'p' },
			)
		).text();
		expect(bytes(exact)).toBe(replyLimit);
		expect(surfaceOf(callResult(exact))).toEqual(expected);
		const over = await (
			await harness.rpc(
				'tools/call',
				{ name: 'mcp_portal_call', arguments: input },
				{ id: underId + 'pp' },
			)
		).text();
		expect(bytes(over)).toBeLessThanOrEqual(replyLimit);
		const boundedItems = items(callResult(over));
		expect(boundedItems).toHaveLength(50);
		expect(boundedItems.filter((item) => item.error.code === 'too_large_result')).toHaveLength(1);
		expect(boundedItems.filter((item) => item.error.code === 'input_validation')).toHaveLength(49);
		expect(harness.fixture.calls).toHaveLength(0);

		const config = fixtureConfig(directory, [
			`${harness.fixture.url}/mcp`,
			`${harness.fixture.url}/mcp`,
		]);
		const provider = config.mcp.providers.alpha;
		const profile = config.profiles['profile-a'];
		const policy = profile?.profile.namespaces.alpha;
		if (provider === undefined || profile === undefined || policy === undefined)
			throw new Error('Missing Node comparison configuration.');
		provider.namespace = 'same-server';
		delete profile.profile.namespaces.alpha;
		profile.profile.namespaces['same-server'] = policy;
		const configPath = path.join(directory, 'node.json');
		await writeFile(configPath, JSON.stringify(config));
		node = await startNodeHost({
			configPath,
			secrets: { resolve: async () => 'one-secret-canary' },
		});
		if (node.http === undefined) throw new Error('Missing actual Node proxy listener.');
		const nodeCall = async (
			argumentsValue: Record<string, unknown>,
			id: string,
		): Promise<{ readonly status: number; readonly text: string }> => {
			if (node?.http === undefined) throw new Error('Missing Node proxy.');
			const response = await fetch(node.http.endpoint, {
				method: 'POST',
				headers: {
					authorization: 'Bearer credential-a',
					'content-type': 'application/json',
					'MCP-Protocol-Version': '2026-07-28',
					'Mcp-Method': 'tools/call',
					'Mcp-Name': 'mcp_portal_call',
				},
				body: JSON.stringify({
					jsonrpc: '2.0',
					id,
					method: 'tools/call',
					params: {
						name: 'mcp_portal_call',
						arguments: argumentsValue,
						_meta: {
							'io.modelcontextprotocol/protocolVersion': '2026-07-28',
							'io.modelcontextprotocol/clientCapabilities': {},
						},
					},
				}),
			});
			return { status: response.status, text: await response.text() };
		};
		const nodeResponse = await nodeCall(input, underId + 'p'.repeat(64));
		const nodeText = nodeResponse.text;
		expect(nodeResponse.status).toBe(200);
		expect(bytes(nodeText)).toBeGreaterThan(replyLimit);
		expect(surfaceOf(callResult(nodeText))).toEqual(expected);
		expect(items(callResult(nodeText)).map((item) => item.error.code)).toEqual(
			Array.from({ length: 50 }, () => 'input_validation'),
		);
		expect(harness.fixture.calls).toHaveLength(0);
		// The raw array cap is Worker-only: the actual Node route retains old malformed-batch bytes.
		const rawMalformed = { calls: Array.from({ length: 8000 }, () => ({})) };
		const oldMalformed = await oldResultFor(rawMalformed);
		const nodeMalformed = await nodeCall(rawMalformed, 'node-malformed');
		expect(nodeMalformed.status).toBe(200);
		expect(bytes(nodeMalformed.text)).toBeGreaterThan(replyLimit);
		expect(surfaceOf(callResult(nodeMalformed.text))).toEqual(oldMalformed);
		expect(nodeMalformed.text).not.toContain('too_many_calls');
		// A scalar validation issue can also exceed the budget with only 50 raw entries.
		const scalarInput = (length: number): Record<string, unknown> => ({
			calls: Array.from({ length: 50 }, () => ({})),
			['\\'.repeat(length)]: 0,
		});
		const scalarSmall = await oldResultFor(scalarInput(1));
		const scalarNext = await oldResultFor(scalarInput(2));
		const scalarBase = expectedWorkerBytes(scalarSmall, 'proof');
		const scalarSlope = expectedWorkerBytes(scalarNext, 'proof') - scalarBase;
		expect(scalarSlope).toBeGreaterThan(0);
		const keyLength = 1 + Math.ceil((replyLimit + 1 - scalarBase) / scalarSlope);
		const scalarArguments = scalarInput(keyLength);
		expect(bytes(JSON.stringify(scalarArguments))).toBeLessThan(4 * 1024 * 1024 - 4096);
		const scalarExpected = await oldResultFor(scalarArguments);
		expect(expectedWorkerBytes(scalarExpected, 'proof')).toBeGreaterThan(replyLimit);
		const scalarResponse = await harness.rpc('tools/call', {
			name: 'mcp_portal_call',
			arguments: scalarArguments,
		});
		const scalarText = await scalarResponse.text();
		expect(scalarResponse.status).toBe(200);
		expect(bytes(scalarText)).toBeLessThanOrEqual(replyLimit);
		expect(scalarText).toContain('too_large_result');
		expect(scalarText).not.toContain('invalid_portal_input');
		const nodeScalar = await nodeCall(scalarArguments, 'node-scalar');
		expect(nodeScalar.status).toBe(200);
		expect(bytes(nodeScalar.text)).toBeGreaterThan(replyLimit);
		expect(surfaceOf(callResult(nodeScalar.text))).toEqual(scalarExpected);
		expect(harness.fixture.calls).toHaveLength(0);

		process.stdout.write(
			`${JSON.stringify({ validationBudget: { calls: 50, enumLength, under: bytes(under), exact: bytes(exact), proposedOver: replyLimit + 1, boundedOver: bytes(over), unchangedNode: bytes(nodeText), scalarBefore: expectedWorkerBytes(scalarExpected, 'proof'), scalarAfter: bytes(scalarText), unchangedNodeMalformed: bytes(nodeMalformed.text), unchangedNodeScalar: bytes(nodeScalar.text) }, upstreamEffects: 0 })}\n`,
		);
	} finally {
		await node?.retire();
		await harness.close();
		await rm(directory, { recursive: true, force: true });
	}
});
