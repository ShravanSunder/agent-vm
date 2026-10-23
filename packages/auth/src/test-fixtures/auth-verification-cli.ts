import { execFile } from 'node:child_process';
import { readFile, mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { hostname, loadavg, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

import { z } from 'zod';

import { requirePrivateRuntimePath } from '#auth/native-owner-cli/auth-target';

const localVerificationTargetSchema = z.strictObject({
	kind: z.literal('local-workerd'),
	sourceRevision: z.string().regex(/^[a-f0-9]{40}$/u),
	executionHost: z.string().min(1),
	maxLoad1: z.number().positive().max(12),
});

/** S1 owns the local T3 agent/bootstrap journeys. Hosted journeys are added only with their later delivery grants. */
export async function runAuthVerification(args: readonly string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: [...args],
		allowPositionals: true,
		options: { help: { type: 'boolean' }, 'target-file': { type: 'string' } },
	});
	if (values.help === true) {
		process.stdout
			.write(`Usage: mise exec -- pnpm exec tsx scripts/verify-auth/verify-auth.ts agent|bootstrap --target-file FILE
Runs the permanent real-workerd/D1/Better-Auth/Gateway host journey, with direct D1/DO and upstream-effect assertions.
S1 target JSON: {"kind":"local-workerd","sourceRevision":"<40-character checkout HEAD>","executionHost":"<target hostname>","maxLoad1":12}
FILE must be an owned mode0600 regular file outside every Git checkout. Target values and credentials are not printed.
Requires Node24.7.0, built workspace dependencies and the pinned installed workerd toolchain. Missing prerequisites and zero passing selected observations fail.
Evidence is retained in an owned OS-temp directory. Unselected journeys are reported separately; hosted identity/CPU and stronger human-intent checks remain unverified.\n`);
		return 0;
	}
	try {
		const journey = z.enum(['agent', 'bootstrap']).parse(positionals[0]);
		if (positionals.length !== 1) throw new Error('Expected exactly one verification journey');
		const targetPath = await requirePrivateRuntimePath(
			z.string().min(1).parse(values['target-file']),
			true,
		);
		const target = localVerificationTargetSchema.parse(
			JSON.parse(await readFile(targetPath, 'utf8')),
		);
		if (
			process.version !== 'v24.7.0' ||
			hostname() !== target.executionHost ||
			(loadavg()[0] ?? Infinity) >= target.maxLoad1
		)
			throw new Error('Verification target prerequisites do not match or load admission is closed');
		const root = fileURLToPath(new URL('../../../../', import.meta.url));
		const execute = promisify(execFile);
		const head = await execute('git', ['rev-parse', 'HEAD'], { cwd: root });
		if (head.stdout.trim() !== target.sourceRevision)
			throw new Error('Verification target source revision does not match checkout');
		const evidence = await mkdtemp(path.join(tmpdir(), '2026-10-verify-auth-'));
		const reportPath = path.join(evidence, 'vitest.json');
		const requireAuth = createRequire(new URL('../../package.json', import.meta.url));
		const vitest = path.join(
			path.dirname(requireAuth.resolve('vitest/package.json')),
			'vitest.mjs',
		);
		const selectedFiles = [
			'packages/auth/src/agent-issuer.host.e2e.test.ts',
			...(journey === 'agent'
				? ['packages/auth/src/agent-registration-faults.host.e2e.test.ts']
				: []),
		];
		try {
			await execute(
				process.execPath,
				[
					vitest,
					'run',
					'--project',
					'e2e-host',
					...selectedFiles,
					'--testNamePattern',
					`${journey}:`,
					'--reporter=json',
					`--outputFile=${reportPath}`,
				],
				{
					cwd: root,
					env: { ...process.env, AUTH_TEST_TARGET: targetPath },
					timeout: 600_000,
					maxBuffer: 8 * 1024 * 1024,
				},
			);
		} catch {
			process.stderr.write(`Real-target journey failed; private evidence: ${evidence}\n`);
			return 1;
		}
		const report = z
			.object({
				numPassedTests: z.number().positive(),
				numFailedTests: z.literal(0),
				numPendingTests: z.number().nonnegative(),
				success: z.literal(true),
			})
			.parse(JSON.parse(await readFile(reportPath, 'utf8')));
		process.stdout.write(
			JSON.stringify({
				journey,
				layer: 'host-e2e',
				passed: report.numPassedTests,
				failed: report.numFailedTests,
				unselected: report.numPendingTests,
				evidence,
			}) + '\n',
		);
		return 0;
	} catch {
		process.stderr.write(
			'Auth verification refused missing, invalid or mismatched target/prerequisites; no observation counted.\n',
		);
		return 1;
	}
}
