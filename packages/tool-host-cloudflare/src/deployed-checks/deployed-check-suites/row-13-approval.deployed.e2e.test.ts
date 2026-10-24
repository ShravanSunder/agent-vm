import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { importJWK, jwtVerify } from 'jose';
import { it } from 'vitest';

import {
	readPrivateDeployFile,
	requireOutsideGitWorkTree,
} from '#worker-host/deployed-checks/deploy-configuration/private-file-access';
import { assertOneApprovalUse } from '#worker-host/deployed-checks/deployed-check-suites/authorization-observations';
import {
	agentToken,
	approvedCall,
	observations,
	portalRpc,
	requireRpcResult,
} from '#worker-host/deployed-checks/deployed-check-suites/deployed-portal-client';
import { writeRunArtifact } from '#worker-host/deployed-checks/deployed-check-suites/evidence-file-access';

it('row 13: one approval sent concurrently to copies a and b has exactly one effect', async () => {
	const configuration = await readPrivateDeployFile();
	const callId = `approval-${crypto.randomUUID()}`;
	const params = await approvedCall(configuration, { callId });
	const directory = await requireOutsideGitWorkTree(configuration.evidenceDirectory);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const statePath = await requireOutsideGitWorkTree(path.join(directory, 'row-13-replay.json'));
	const token = await agentToken(configuration);
	const { d: _privateScalar, ...publicJwk } = configuration.privateSigningJwk;
	const audience = `${configuration.portalA.origin}/workspaces/${configuration.workspaces[0].workspaceId}/mcp`;
	const verified = await jwtVerify(token, await importJWK(publicJwk, 'ES256'), {
		issuer: configuration.helper.origin,
		audience,
	});
	if (
		verified.payload.workspace_id !== configuration.workspaces[0].workspaceId ||
		verified.payload.organization_id !== configuration.workspaces[0].organizationId
	)
		throw new Error('Cross-copy token has the wrong workspace claims.');
	const responses = await Promise.all(
		(['a', 'b'] as const).map(async (copy) =>
			portalRpc(configuration, 'tools/call', params, { copy, token }),
		),
	);
	const results = await Promise.all(responses.map(async (response) => requireRpcResult(response)));
	assertOneApprovalUse(await observations(configuration), callId, results);
	await writeRunArtifact(configuration, 'row-13-transports.json', {
		runId: configuration.runId,
		workspaceId: configuration.workspaces[0].workspaceId,
		logicalOrigin: configuration.portalA.origin,
		verifiedAudience: verified.payload.aud,
		transports: (
			[
				{ copy: 'a', origin: configuration.portalA.origin },
				{ copy: 'b', origin: configuration.portalB.origin },
			] as const
		).map((copy, index) => ({
			copy: copy.copy,
			origin: copy.origin,
			status: responses[index]?.status,
		})),
	});
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
