import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { it } from 'vitest';
import { z } from 'zod';

import {
	readPrivateDeployFile,
	requireOutsideGitWorkTree,
} from '#worker-host/deployed-checks/deploy-configuration/private-file-access';
import { assertCallEffects } from '#worker-host/deployed-checks/deployed-check-suites/authorization-observations';
import {
	observations,
	portalRpc,
	requireRpcResult,
} from '#worker-host/deployed-checks/deployed-check-suites/deployed-portal-client';

it('row 13: AFTER LEAD REDEPLOY, replay still adds no effect', async () => {
	const configuration = await readPrivateDeployFile();
	const statePath = await requireOutsideGitWorkTree(
		path.join(configuration.evidenceDirectory, 'row-13-replay.json'),
	);
	if (((await stat(statePath)).mode & 0o777) !== 0o600)
		throw new Error('Replay state must have mode 0600.');
	const state = z
		.strictObject({
			runId: z.string(),
			callId: z.string(),
			params: z.record(z.string(), z.unknown()),
			source: z.literal('generated-by-row-13-concurrent-check'),
		})
		.parse(JSON.parse(await readFile(statePath, 'utf8')));
	if (state.runId !== configuration.runId) throw new Error('Replay state is from another run.');
	assertCallEffects(await observations(configuration), state.callId, 1);
	const results = await Promise.all(
		(['a', 'b'] as const).map(async (copy) =>
			requireRpcResult(await portalRpc(configuration, 'tools/call', state.params, { copy })),
		),
	);
	if (
		results.some(
			(result) => result.isError !== true || !JSON.stringify(result).includes('replayed'),
		)
	)
		throw new Error('Approval replay was not refused after redeploy.');
	assertCallEffects(await observations(configuration), state.callId, 1);
});
