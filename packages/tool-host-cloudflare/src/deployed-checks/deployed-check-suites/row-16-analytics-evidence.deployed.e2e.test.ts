import path from 'node:path';

import { it } from 'vitest';

import { readPrivateDeployFile } from '#worker-host/deployed-checks/deploy-configuration/private-file-access';
import {
	assertAnalyticsShape,
	assertNoLogCanaries,
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
	assertAnalyticsShape(
		await readEvidenceJson(configuration.analyticsSqlFile, analyticsSqlResponseSchema),
		configuration,
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
		...configuration.organizations.flatMap((organization) => [
			organization.credential,
			organization.approvalKeyHex,
		]),
	]);
	// Sampling proves shape and arrival only. Exact counts and exclusion from analytics remain the local capture's job.
});
