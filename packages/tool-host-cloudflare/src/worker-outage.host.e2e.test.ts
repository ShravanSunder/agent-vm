import { expect, it } from 'vitest';
import { z } from 'zod';

import {
	organizationConfigurations,
	organizationOne,
} from '#worker-host/test-fixtures/controlled-mcp-issuer';
import {
	startLocalWorkerHarness,
	rpcResult,
	portalRead,
} from '#worker-host/test-fixtures/local-worker-harness';
import { organizationConfigurationSchema } from '#worker-host/worker-configuration';

it('keeps healthy tools during a startup outage, retries the failed server, and retains a complete catalog after a failed60s refresh', async () => {
	const now = Date.now();
	const harness = await startLocalWorkerHarness({
		fixedClock: now,
		setup: (fixture) => fixture.setUnavailablePath('/down', true),
		configurations: (url) => {
			const configurations = z
				.record(z.string(), organizationConfigurationSchema)
				.parse(organizationConfigurations(url));
			const config = configurations[organizationOne];
			const provider = config?.mcp.providers.fixture;
			const profile = config?.portal.profiles.one;
			const policy = profile?.namespaces['same-server'];
			if (
				config === undefined ||
				provider === undefined ||
				profile === undefined ||
				policy === undefined ||
				provider.transport.kind !== 'streamable-http'
			)
				throw new Error('Missing outage fixture.');
			config.mcp.providers.down = {
				...provider,
				namespace: 'down-server',
				transport: { ...provider.transport, url: `${url}/down` },
			};
			profile.namespaces['down-server'] = policy;
			return configurations;
		},
	});
	try {
		await rpcResult(await harness.rpc('server/discover'));
		await rpcResult(await harness.rpc('tools/call', portalRead('healthy-during-outage')));
		expect(harness.fixture.calls).toHaveLength(1);
		const incomplete = await harness.rpc('tools/list', {}, { path: '/mcp?tools=direct' });
		expect(incomplete.status).toBe(503);
		expect(await incomplete.text()).toContain('down-server');
		harness.fixture.setUnavailablePath('/down', false);
		const complete = await rpcResult(
			await harness.rpc('tools/list', {}, { path: '/mcp?tools=direct' }),
		);
		expect(z.object({ tools: z.array(z.unknown()) }).parse(complete).tools).toHaveLength(8);
		const lists = harness.fixture.discoveryCredentials.length;
		await rpcResult(await harness.rpc('tools/list', {}, { path: '/mcp?tools=direct' }));
		expect(harness.fixture.discoveryCredentials).toHaveLength(lists);
		harness.fixture.setUnavailablePath('/down', true);
		const clock = await harness.worker.fetch(`/__clock?now=${String(now + 60_001)}`);
		await clock.body?.cancel();
		const retained = await rpcResult(
			await harness.rpc('tools/list', {}, { path: '/mcp?tools=direct' }),
		);
		expect(retained.tools).toEqual(complete.tools);
		await rpcResult(await harness.rpc('tools/call', portalRead('healthy-after-failed-refresh')));
		expect(harness.fixture.calls).toHaveLength(2);
		harness.fixture.setUnavailablePath('/down', false);
		expect(
			(await rpcResult(await harness.rpc('tools/list', {}, { path: '/mcp?tools=direct' }))).tools,
		).toEqual(complete.tools);
	} finally {
		await harness.close();
	}
});
