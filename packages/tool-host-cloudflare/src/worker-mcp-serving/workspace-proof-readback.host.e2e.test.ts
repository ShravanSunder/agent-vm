import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { expect, it } from 'vitest';

import { startWorkerdSocketGuard } from '#worker-host/test-fixtures/workerd-socket-guard';

async function bundledEntry(file: string): Promise<string> {
	const result = await build({
		entryPoints: [file],
		bundle: true,
		write: false,
		format: 'esm',
		platform: 'browser',
		conditions: ['workerd', 'worker', 'browser'],
		external: ['cloudflare:workers'],
	});
	const script = result.outputFiles[0]?.text;
	if (script === undefined) throw new Error('Missing Worker proof module.');
	return script;
}

it('reads workspace storage only through the proof composition, never production', async () => {
	const guard = startWorkerdSocketGuard();
	let runtime: Miniflare | undefined;
	try {
		const [proof, seed, production] = await Promise.all([
			bundledEntry(
				'packages/tool-host-cloudflare/src/test-fixtures/workspace-gateway-proof-entrypoint.ts',
			),
			bundledEntry('packages/tool-host-cloudflare/src/test-fixtures/object-proof-entrypoint.ts'),
			bundledEntry('packages/tool-host-cloudflare/src/index.ts'),
		]);
		runtime = new Miniflare(
			convertV4MiniflareOptions({
				workers: [
					{
						name: 'proof',
						script: proof,
						modules: true,
						compatibilityDate: '2026-08-15',
						durableObjects: { WORKSPACES: { className: 'WorkspaceAuthority', useSQLite: true } },
					},
					{
						name: 'seed',
						script: seed,
						modules: true,
						compatibilityDate: '2026-08-15',
						durableObjects: {
							WORKSPACES: { className: 'WorkspaceAuthority', scriptName: 'proof', useSQLite: true },
						},
					},
					{
						name: 'production',
						script: production,
						modules: true,
						compatibilityDate: '2026-08-15',
						durableObjects: { WORKSPACES: { className: 'WorkspaceAuthority', useSQLite: true } },
					},
				],
			}),
		);
		const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
		const clientId = 'same-agent';
		const address = `https://proof.invalid/__auth-proof?workspace=${workspaceId}&client=${clientId}`;
		const worker = await runtime.getWorker('proof');
		const writer = await runtime.getWorker('seed');
		expect(await (await worker.fetch(address)).json()).toEqual({});
		const seedResponse = await writer.fetch('https://seed.invalid/', {
			method: 'POST',
			body: JSON.stringify({
				kind: 'admission',
				organizationId: workspaceId,
				agentId: clientId,
				state: 'listed',
				persona: 'reader',
			}),
		});
		expect(seedResponse.status).toBe(200);
		await seedResponse.body?.cancel();
		expect(await (await worker.fetch(address)).json()).toEqual({
			[`member:${clientId}`]: { state: 'member', persona: 'reader' },
		});
		const absent = await worker.fetch(
			address.replace(workspaceId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
		);
		expect(await absent.json()).toEqual({});
		const refusal = await worker.fetch(address, { method: 'POST', body: '{}' });
		expect(refusal.status).toBe(405);
		await refusal.body?.cancel();
		const real = await runtime.getWorker('production');
		const unavailable = await real.fetch(address);
		expect(unavailable.status).toBe(404);
		await unavailable.body?.cancel();
		const delegated = await worker.fetch('https://proof.invalid/mcp');
		expect(delegated.status).toBe(404);
		await delegated.body?.cancel();
		guard.check();
	} finally {
		try {
			await runtime?.dispose();
		} finally {
			await guard.stop();
		}
	}
});
