import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { it } from 'vitest';

import {
	readPrivateDeployFile,
	requireOutsideGitWorkTree,
} from '#worker-host/deployed-checks/deploy-configuration/private-file-access';
import { assertOneApprovalUse } from '#worker-host/deployed-checks/deployed-check-suites/authorization-observations';
import {
	admitTestAgents,
	approvedCall,
	observations,
	portalRpc,
	requireRpcResult,
} from '#worker-host/deployed-checks/deployed-check-suites/deployed-portal-client';

it('row 13: one approval sent concurrently to copies a and b has exactly one effect', async () => {
	const configuration = await readPrivateDeployFile();
	await admitTestAgents(configuration);
	const callId = `approval-${crypto.randomUUID()}`;
	const params = await approvedCall(configuration, callId);
	const directory = await requireOutsideGitWorkTree(configuration.evidenceDirectory);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const statePath = await requireOutsideGitWorkTree(path.join(directory, 'row-13-replay.json'));
	const results = await Promise.all(
		(['a', 'b'] as const).map(async (copy) =>
			requireRpcResult(await portalRpc(configuration, 'tools/call', params, { copy })),
		),
	);
	assertOneApprovalUse(await observations(configuration), callId, results);
	await writeFile(
		statePath,
		JSON.stringify({
			runId: configuration.runId,
			callId,
			params,
			source: 'generated-by-row-13-concurrent-check',
		}),
		{ mode: 0o600, flag: 'wx' },
	);
});
