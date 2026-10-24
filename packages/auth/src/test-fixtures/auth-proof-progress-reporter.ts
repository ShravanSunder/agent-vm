import { appendFile } from 'node:fs/promises';

import type { Reporter } from 'vitest/reporters';
import { z } from 'zod';

import { requirePrivateRuntimePath } from '#auth/native-owner-cli/auth-target';

type ReportedTestCase = Parameters<NonNullable<Reporter['onTestCaseResult']>>[0];

/** The Vitest coordinator persists each result before another fork can block or be killed. */
export default class AuthProofProgressReporter implements Reporter {
	private readonly outputFile = requirePrivateRuntimePath(
		z.string().min(1).parse(process.env.AUTH_PROOF_CASE_EVENTS_FILE),
		false,
	);

	async onTestCaseReady(testCase: ReportedTestCase): Promise<void> {
		await this.record(testCase, 'started');
	}

	async onTestCaseResult(testCase: ReportedTestCase): Promise<void> {
		await this.record(testCase, 'completed');
	}

	private async record(testCase: ReportedTestCase, event: 'started' | 'completed'): Promise<void> {
		const record = {
			time: new Date().toISOString(),
			event,
			id: testCase.id,
			name: testCase.fullName,
			file: testCase.module.moduleId,
			status: event === 'started' ? 'pending' : testCase.result().state,
			durationMs: event === 'started' ? null : (testCase.diagnostic()?.duration ?? null),
		};
		await appendFile(await this.outputFile, `${JSON.stringify(record)}\n`, { mode: 0o600 });
	}
}
