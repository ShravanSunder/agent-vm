import { access } from 'node:fs/promises';

import { hashCallArguments } from '@agent-collaboration/tool-access/contracts';
import { signApprovalToken } from '@agent-collaboration/tool-engine/mcp-gateway';
import { describe, expect, it } from 'vitest';

import { startNodeHost } from '#node-host/node-host-startup';
import {
	connectClient,
	decodedResult,
	fixtureConfig,
	fixtureDirectory,
	headerCanary,
	secretCanary,
	startControlledProvider,
	writeFixtureConfig,
} from '#node-host/test-fixtures/node-host-fixture';

const key = new Uint8Array(32).fill(23);
for (const mode of ['indirect', 'direct'] as const) {
	describe(`${mode} proxy approvals over real Node HTTP`, () => {
		it('binds approvals to the exact agent and arguments, consumes once across handlers and retains no unprotected records', async () => {
			const directory = await fixtureDirectory();
			const alpha = await startControlledProvider('alpha');
			const beta = await startControlledProvider('beta');
			const config = fixtureConfig(directory, [alpha.url, beta.url]);
			const configPath = await writeFixtureConfig(config, directory);
			const host = await startNodeHost({
				configPath,
				secrets: {
					resolve: async (secret): Promise<string> =>
						secret.source === 'environment' && secret.name === 'PROVIDER_SECRET'
							? secretCanary
							: headerCanary,
				},
				approvalKeysByAgent: new Map([['agent-a', key]]),
			});
			if (host.http === undefined) throw new Error('Missing HTTP listener');
			const endpoint = new URL(host.http.endpoint);
			if (mode === 'direct') endpoint.searchParams.set('tools', 'direct');
			const first = await connectClient(endpoint, 'credential-a');
			const second = await connectClient(endpoint, 'credential-a');
			const held = alpha.holdCalls();
			async function token(agentId = 'agent-a', value = 42, issue = 'first'): Promise<string> {
				const now = Date.now();
				return signApprovalToken({
					key,
					agentId,
					issuedAtMs: now,
					expiresAtMs: now + 60_000,
					jti: `one-use-${agentId}-${value}-${issue}`,
					calls: [
						{
							namespace: 'alpha',
							toolName: 'ask',
							argumentsHash: await hashCallArguments({ value }),
						},
					],
				});
			}
			function request(
				approval?: string,
				item = 'protected',
			): {
				readonly name: string;
				readonly arguments: Record<string, unknown>;
				readonly _meta?: Record<string, string>;
			} {
				return mode === 'indirect'
					? {
							name: 'mcp_portal_call',
							arguments: {
								calls: [
									{
										id: item,
										namespace: 'alpha',
										toolName: 'ask',
										arguments: { value: 42 },
									},
								],
								...(approval === undefined ? {} : { portalApprovalToken: approval }),
							},
						}
					: {
							name: 'alpha__ask__645775a667',
							arguments: { value: 42 },
							...(approval === undefined
								? {}
								: { _meta: { 'agent-vm/tool-portal-approval-token': approval } }),
						};
			}
			try {
				expect(decodedResult(await first.client.callTool(request())).ok).toBe(false);
				expect(decodedResult(await first.client.callTool(request(await token('agent-b')))).ok).toBe(
					false,
				);
				expect(
					decodedResult(await first.client.callTool(request(await token('agent-a', 43)))).ok,
				).toBe(false);
				expect(alpha.effects).toHaveLength(0);
				const approved = await token();
				const pending = first.client.callTool(request(approved));
				await held.entered;
				expect(decodedResult(await second.client.callTool(request(approved))).ok).toBe(false);
				expect(alpha.effects.map((effect) => effect.arguments)).toEqual([{ value: 42 }]);
				held.release();
				expect(decodedResult(await pending).ok).toBe(true);
				expect(decodedResult(await second.client.callTool(request(approved))).ok).toBe(false);
				expect(alpha.effects).toHaveLength(1);
				expect(
					decodedResult(
						await second.client.callTool(
							request(await token('agent-a', 42, 'independent'), 'independent-item'),
						),
					).ok,
				).toBe(true);
				expect(alpha.effects).toHaveLength(2);
				await expect(access(config.storeDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
			} finally {
				held.release();
				await Promise.all([first.client.close(), second.client.close()]);
				await host.retire();
				await Promise.all([alpha.close(), beta.close()]);
			}
		});
	});
}
