import path from 'node:path';

import { it } from 'vitest';

import { readPrivateDeployFile } from '#worker-host/deployed-checks/deploy-configuration/private-file-access';
import {
	assertAnalyticsShape,
	assertNoLogCanaries,
	expectedWorkspaceRecordsSchema,
} from '#worker-host/deployed-checks/deployed-check-suites/analytics-observations';
import {
	readCurrentRunLogs,
	readEvidenceJson,
} from '#worker-host/deployed-checks/deployed-check-suites/evidence-file-access';
import {
	canaryRunSchema,
	analyticsSqlResponseSchema,
} from '#worker-host/deployed-checks/deployed-check-suites/models/deployed-evidence';

it('row 16 evidence: sampled Analytics rows have the expected shape and current-run logs exclude canaries', async () => {
	const configuration = await readPrivateDeployFile();
	const artifact = await readEvidenceJson(
		path.join(configuration.evidenceDirectory, 'row-16-canaries.json'),
		canaryRunSchema,
	);
	if (artifact.runId !== configuration.runId)
		throw new Error('Canary artifact belongs to a different run.');
	// W5 supplies this explicit inventory beside the sampled SQL evidence.
	const workspaces = await readEvidenceJson(
		path.join(path.dirname(configuration.analyticsSqlFile), 'expected-workspaces.json'),
		expectedWorkspaceRecordsSchema,
	).catch(() => {
		throw new Error('Expected workspace evidence is missing or invalid: expected-workspaces.json.');
	});
	assertAnalyticsShape(
		await readEvidenceJson(configuration.analyticsSqlFile, analyticsSqlResponseSchema),
		{
			runId: configuration.runId,
			workspaces,
			agentIds: [configuration.agentId, configuration.otherAgentId],
		},
	);
	const records = await readCurrentRunLogs(
		configuration,
		configuration.runId,
		artifact.startedAt,
		artifact.endedAt,
	);
	assertNoLogCanaries(records, [
		artifact.argumentCanary,
		artifact.resultCanary,
		artifact.token,
		configuration.admissionSecret,
		configuration.access.clientSecret,
		...configuration.workspaces.flatMap((workspace) => [
			workspace.credential,
			workspace.approvalKeyHex,
		]),
	]);
	// Sampling proves shape and arrival only. Exact counts and exclusion from analytics remain the local capture's job.
});
