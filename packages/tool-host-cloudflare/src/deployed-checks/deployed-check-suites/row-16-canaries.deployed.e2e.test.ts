import { it } from 'vitest';

import { readPrivateDeployFile } from '#worker-host/deployed-checks/deploy-configuration/private-file-access';
import { assertOwnCredential } from '#worker-host/deployed-checks/deployed-check-suites/authorization-observations';
import {
	admitTestAgents,
	agentToken,
	observations,
	portalCall,
	portalRpc,
} from '#worker-host/deployed-checks/deployed-check-suites/deployed-portal-client';
import { writeRunArtifact } from '#worker-host/deployed-checks/deployed-check-suites/evidence-file-access';

it('row 16: send argument, result, credential and token canaries before collecting deployed evidence', async () => {
	const configuration = await readPrivateDeployFile();
	await admitTestAgents(configuration);
	const callId = `canary-${crypto.randomUUID()}`;
	const argumentCanary = `argument-${crypto.randomUUID()}`;
	const resultCanary = `result-${crypto.randomUUID()}`;
	const token = await agentToken(configuration);
	const startedAt = Date.now();
	const response = await portalRpc(
		configuration,
		'tools/call',
		portalCall(configuration, callId, 'read', { argumentCanary, value: resultCanary }),
		{ token },
	);
	if (
		response.status !== 200 ||
		response.result.isError === true ||
		!JSON.stringify(response.result).includes(resultCanary)
	)
		throw new Error('Canary control did not reach the result path.');
	assertOwnCredential(
		await observations(configuration),
		callId,
		configuration.organizations[0].credential,
		configuration.organizations[0].label,
	);
	await writeRunArtifact(configuration, 'row-16-canaries.json', {
		runId: configuration.runId,
		callId,
		argumentCanary,
		resultCanary,
		token,
		startedAt,
		endedAt: Date.now(),
	});
});
