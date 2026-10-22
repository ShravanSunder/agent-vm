import { organizationConfigurationSchema } from '@agent-collaboration/tool-host-core';
import { expect, it } from 'vitest';
import { z } from 'zod';

import {
	organizationConfigurations,
	organizationOne,
} from '#worker-host/test-fixtures/controlled-mcp-issuer';
import { startLocalWorkerHarness } from '#worker-host/test-fixtures/local-worker-harness';

it.each(['missing assignment', 'dangling profile'])(
	'real workerd refuses an admitted caller with %s before upstream discovery',
	async (mode) => {
		const harness = await startLocalWorkerHarness({
			configurations: (url) => {
				const configurations = z
					.record(z.string(), organizationConfigurationSchema)
					.parse(organizationConfigurations(url));
				const configuration = configurations[organizationOne];
				if (configuration === undefined) throw new Error('Missing controlled organization.');
				if (mode === 'missing assignment') delete configuration.portal.agents['agent-one'];
				else
					configuration.portal.agents['agent-one'] = { credentialVersion: 1, profile: 'missing' };
				return configurations;
			},
		});
		try {
			const response = await harness.rpc('tools/list');
			expect(response.status).toBe(401);
			expect(await response.json()).toEqual({ error: 'profile-unassigned' });
			expect(harness.fixture.initializations).toEqual([]);
			expect(harness.fixture.discoveryCredentials).toEqual([]);
			expect(harness.fixture.calls).toEqual([]);
		} finally {
			await harness.close();
		}
	},
);
