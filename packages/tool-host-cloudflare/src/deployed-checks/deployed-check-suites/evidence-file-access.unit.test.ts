import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';

import { privateDeployFixture } from '#worker-host/deployed-checks/deploy-configuration/test-fixtures/private-deploy-fixture';
import { readCurrentRunLogs } from '#worker-host/deployed-checks/deployed-check-suites/evidence-file-access';

it('reads raw tail JSONL only for the current URL run ID and request time window', async () => {
	const directory = await mkdtemp(path.join(tmpdir(), '2026-10-tail-evidence-'));
	const configuration = privateDeployFixture(directory);
	const current = {
		outcome: 'ok',
		eventTimestamp: 100,
		event: { request: { url: `https://portal.invalid/mcp?runId=${configuration.runId}` } },
		logs: [{ timestamp: 100, message: ['controlled'] }],
	};
	try {
		await writeFile(
			configuration.logFile,
			`${JSON.stringify({ ...current, eventTimestamp: 50 })}\n${JSON.stringify(current)}\n`,
			{ mode: 0o600 },
		);
		expect(await readCurrentRunLogs(configuration, configuration.runId, 90, 110)).toEqual([
			current,
		]);
		await expect(readCurrentRunLogs(configuration, 'another-run', 90, 110)).rejects.toThrow(
			'No logs',
		);
		await expect(readCurrentRunLogs(configuration, configuration.runId, 200, 300)).rejects.toThrow(
			'No logs',
		);
		await writeFile(configuration.logFile, '');
		await expect(readCurrentRunLogs(configuration, configuration.runId, 90, 110)).rejects.toThrow();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
