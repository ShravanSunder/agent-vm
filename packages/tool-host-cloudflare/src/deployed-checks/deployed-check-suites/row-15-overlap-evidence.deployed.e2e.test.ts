import path from 'node:path';

import { it } from 'vitest';

import { readPrivateDeployFile } from '#worker-host/deployed-checks/deploy-configuration/private-file-access';
import {
	readCurrentRunLogs,
	readEvidenceJson,
} from '#worker-host/deployed-checks/deployed-check-suites/evidence-file-access';
import {
	assertBoundedLargeReply,
	assertSameIsolateOverlap,
} from '#worker-host/deployed-checks/deployed-check-suites/limit-observations';
import { overlapRunSchema } from '#worker-host/deployed-checks/deployed-check-suites/models/deployed-evidence';

it('row 15 evidence: only overlapping requests in one isolate can pass', async () => {
	const configuration = await readPrivateDeployFile();
	const artifact = await readEvidenceJson(
		path.join(configuration.evidenceDirectory, 'row-15-overlap.json'),
		overlapRunSchema,
	);
	if (artifact.runId !== configuration.runId)
		throw new Error('Overlap artifact belongs to a different run.');
	for (const response of artifact.responses) assertBoundedLargeReply(response);
	assertSameIsolateOverlap(
		await readCurrentRunLogs(
			configuration,
			artifact.overlapRunId,
			artifact.startedAt,
			artifact.endedAt,
		),
		artifact.overlapRunId,
	);
});
