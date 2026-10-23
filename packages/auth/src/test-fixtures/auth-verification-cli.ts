import { execFile } from 'node:child_process';
import { readFile, mkdtemp, writeFile, readdir, appendFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { hostname, loadavg, tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as waitForLoadSampleInterval } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

import { z } from 'zod';

import { requirePrivateRuntimePath } from '#auth/native-owner-cli/auth-target';
import {
	prepareProofBundles,
	proofDigest,
	proofBundleManifestSchema,
	proofSourceIdentities,
	type ProofBundleManifest,
} from '#auth/test-fixtures/proof-bundle-artifacts';

const localVerificationTargetSchema = z.strictObject({
	kind: z.literal('local-workerd'),
	sourceRevision: z.string().regex(/^[a-f0-9]{40}$/u),
	executionHost: z.string().min(1),
	maxLoad1: z.number().positive().max(12),
});

export async function waitForAuthBuildLoadAdmission(props: {
	readonly maxLoad1: number;
	readonly readLoad1: () => number;
	readonly now: () => number;
	readonly waitInterval: (milliseconds: number) => Promise<void>;
	readonly recordSample: (sample: {
		readonly elapsedMs: number;
		readonly load1: number;
	}) => Promise<void>;
}): Promise<void> {
	const startedAt = props.now();
	async function checkNextLoadSample(): Promise<void> {
		const sample = { elapsedMs: props.now() - startedAt, load1: props.readLoad1() };
		await props.recordSample(sample);
		if (sample.load1 < props.maxLoad1 && sample.elapsedMs <= 600_000) return;
		if (sample.elapsedMs >= 600_000)
			throw new Error('Load admission closed before Worker artifact bundling after bounded wait');
		await props.waitInterval(30_000);
		await checkNextLoadSample();
	}
	await checkNextLoadSample();
}

export interface OfferedAuthTest {
	readonly name: string;
	readonly file: string;
}

export function selectAuthObservations(props: {
	readonly inventory: readonly OfferedAuthTest[];
	readonly selectedFiles: readonly string[];
	readonly journey: 'agent' | 'bootstrap';
	readonly root: string;
}): readonly OfferedAuthTest[] {
	const offered = props.inventory.filter((test) => test.name.includes(`${props.journey}:`));
	if (
		offered.length === 0 ||
		offered.some((test) => !props.selectedFiles.includes(path.relative(props.root, test.file)))
	)
		throw new Error('Offered journey inventory is empty or omitted by the runner');
	return offered;
}

export function requireMatchingAuthObservations(props: {
	readonly selected: readonly OfferedAuthTest[];
	readonly actual: readonly OfferedAuthTest[];
	readonly passedCount: number;
	readonly root: string;
}): void {
	function names(tests: readonly OfferedAuthTest[]): readonly string[] {
		return tests.map((test) => `${path.relative(props.root, test.file)}:${test.name}`).toSorted();
	}
	if (
		props.selected.length === 0 ||
		props.passedCount !== props.selected.length ||
		JSON.stringify(names(props.selected)) !== JSON.stringify(names(props.actual))
	)
		throw new Error('Executed observations differ from offered selection');
}

interface PreparedAuthVerification {
	readonly root: string;
	readonly evidence: string;
	readonly targetPath: string;
	readonly target: z.infer<typeof localVerificationTargetSchema>;
	readonly artifacts: ProofBundleManifest;
	readonly manifestFile: string;
	readonly vitest: string;
	readonly inventory: readonly OfferedAuthTest[];
	readonly tuple: Readonly<Record<string, unknown>>;
	readonly checkFrozenSource: () => Promise<void>;
}

function authJourneyFiles(journey: 'agent' | 'bootstrap'): readonly string[] {
	return [
		'packages/auth/src/agent-issuer.host.e2e.test.ts',
		...(journey === 'agent'
			? [
					'packages/auth/src/agent-registration-faults.host.e2e.test.ts',
					'packages/auth/src/management-boundaries.host.e2e.test.ts',
					'packages/auth/src/agent-token-races.host.e2e.test.ts',
					'packages/auth/src/person-live-management.host.e2e.test.ts',
					'packages/auth/src/owner-authority-boundaries.host.e2e.test.ts',
					'packages/auth/src/native-code-protocol.host.e2e.test.ts',
				]
			: []),
	];
}

/** Build once and retain a complete declaration before any journey observations start. */
export async function prepareAuthVerification(
	targetFile: string,
	onEvidence?: (directory: string) => void,
): Promise<PreparedAuthVerification> {
	const targetPath = await requirePrivateRuntimePath(targetFile, true);
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
	async function checkFrozenSource(): Promise<void> {
		const head = await execute('git', ['rev-parse', 'HEAD'], { cwd: root });
		const status = await execute('git', ['status', '--porcelain', '--untracked-files=all'], {
			cwd: root,
		});
		if (head.stdout.trim() !== target.sourceRevision || status.stdout !== '')
			throw new Error('Verification source is not the declared clean frozen revision');
	}
	await checkFrozenSource();
	const evidence = await mkdtemp(path.join(tmpdir(), '2026-10-verify-auth-'));
	onEvidence?.(evidence);
	async function runPinnedCommand(
		command: string,
		argumentsList: readonly string[],
		logName: string,
	): Promise<void> {
		if ((loadavg()[0] ?? Infinity) >= target.maxLoad1) throw new Error('Load admission closed');
		try {
			const output = await execute(command, [...argumentsList], {
				cwd: root,
				timeout: 600_000,
				maxBuffer: 16 * 1024 * 1024,
			});
			await writeFile(path.join(evidence, logName), output.stdout + output.stderr, {
				mode: 0o600,
			});
		} catch (error) {
			const output = z
				.object({ stdout: z.string().optional(), stderr: z.string().optional() })
				.safeParse(error);
			await writeFile(
				path.join(evidence, logName),
				output.success
					? (output.data.stdout ?? '') + (output.data.stderr ?? '')
					: 'Command did not complete',
				{ mode: 0o600 },
			);
			throw new Error(`Prerequisite command failed; private evidence: ${evidence}`, {
				cause: error,
			});
		}
	}
	const pnpmVersion = await execute('pnpm', ['--version'], { cwd: root });
	if (pnpmVersion.stdout.trim() !== '10.33.0') throw new Error('Pinned pnpm version differs');
	await runPinnedCommand('pnpm', ['install', '--frozen-lockfile'], 'install.log');
	await runPinnedCommand('pnpm', ['build'], 'build.log');
	await checkFrozenSource();
	await waitForAuthBuildLoadAdmission({
		maxLoad1: target.maxLoad1,
		readLoad1: () => loadavg()[0] ?? Infinity,
		now: Date.now,
		waitInterval: async (milliseconds) => {
			await waitForLoadSampleInterval(milliseconds);
		},
		recordSample: async (sample) => {
			await appendFile(
				path.join(evidence, 'post-build-load.jsonl'),
				JSON.stringify(sample) + '\n',
				{ mode: 0o600 },
			);
		},
	});
	const artifacts = await prepareProofBundles(root, evidence);
	const manifestFile = path.join(evidence, 'bundle-manifest.json');
	await writeFile(manifestFile, JSON.stringify(artifacts), { mode: 0o600, flag: 'wx' });
	const requireAuth = createRequire(new URL('../../package.json', import.meta.url));
	const vitest = path.join(path.dirname(requireAuth.resolve('vitest/package.json')), 'vitest.mjs');
	const inventoryFile = path.join(evidence, 'offered-inventory.json');
	await runPinnedCommand(
		process.execPath,
		[vitest, 'list', '--project', 'e2e-host', 'packages/auth', `--json=${inventoryFile}`],
		'inventory.log',
	);
	const inventory = z
		.array(z.object({ name: z.string(), file: z.string(), projectName: z.literal('e2e-host') }))
		.parse(JSON.parse(await readFile(inventoryFile, 'utf8')));
	const tuple = {
		sourceRevision: target.sourceRevision,
		artifacts,
		lockfile: proofDigest(await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8')),
		configuration: artifacts.configurationSource,
		client: artifacts.clientSource,
		inventory,
		selections: {
			agent: selectAuthObservations({
				inventory,
				selectedFiles: authJourneyFiles('agent'),
				journey: 'agent',
				root,
			}),
			bootstrap: selectAuthObservations({
				inventory,
				selectedFiles: authJourneyFiles('bootstrap'),
				journey: 'bootstrap',
				root,
			}),
		},
		executionHost: hostname(),
		node: process.version,
		pnpm: pnpmVersion.stdout.trim(),
		maxLoad1: target.maxLoad1,
		admittedLoad1: loadavg()[0],
	};
	await writeFile(path.join(evidence, 'declared-target.json'), JSON.stringify(tuple), {
		mode: 0o600,
	});
	return {
		root,
		evidence,
		targetPath,
		target,
		artifacts,
		manifestFile,
		vitest,
		inventory,
		tuple,
		checkFrozenSource,
	};
}

/** Execute another selected journey against the exact same prepared artifact/configuration declaration. */
export async function runPreparedAuthVerification(
	prepared: PreparedAuthVerification,
	journey: 'agent' | 'bootstrap',
): Promise<number> {
	const {
		root,
		evidence,
		targetPath,
		target,
		artifacts,
		manifestFile,
		vitest,
		inventory,
		tuple,
		checkFrozenSource,
	} = prepared;
	await checkFrozenSource();
	if (process.version !== 'v24.7.0' || hostname() !== target.executionHost)
		throw new Error('Prepared execution host/toolchain changed');
	const execute = promisify(execFile);
	const selectedFiles = authJourneyFiles(journey);
	const selected = selectAuthObservations({ inventory, selectedFiles, journey, root });
	const reportPath = path.join(evidence, journey + '-vitest.json');
	if ((loadavg()[0] ?? Infinity) >= target.maxLoad1) throw new Error('Load admission closed');
	try {
		const runtimeOutput = await execute(
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
				env: {
					...process.env,
					AUTH_TEST_TARGET: targetPath,
					AUTH_PROOF_MANIFEST_FILE: manifestFile,
				},
				timeout: 600_000,
				maxBuffer: 8 * 1024 * 1024,
			},
		);
		await writeFile(
			path.join(evidence, journey + '-runtime.log'),
			runtimeOutput.stdout + runtimeOutput.stderr,
			{ mode: 0o600 },
		);
	} catch (error) {
		const output = z
			.object({ stdout: z.string().optional(), stderr: z.string().optional() })
			.safeParse(error);
		await writeFile(
			path.join(evidence, journey + '-runtime.log'),
			output.success
				? (output.data.stdout ?? '') + (output.data.stderr ?? '')
				: 'Runtime did not complete',
			{ mode: 0o600 },
		);
		process.stderr.write(`Real-target journey failed; private evidence: ${evidence}\n`);
		return 1;
	}
	const report = z
		.object({
			numPassedTests: z.number().positive(),
			numFailedTests: z.literal(0),
			numPendingTests: z.number().nonnegative(),
			success: z.literal(true),
			testResults: z.array(
				z.object({
					name: z.string(),
					assertionResults: z.array(
						z.object({
							ancestorTitles: z.array(z.string()),
							title: z.string(),
							status: z.string(),
						}),
					),
				}),
			),
		})
		.parse(JSON.parse(await readFile(reportPath, 'utf8')));
	await checkFrozenSource();
	if (
		JSON.stringify(await proofSourceIdentities(root)) !==
		JSON.stringify({
			configurationSource: artifacts.configurationSource,
			clientSource: artifacts.clientSource,
		})
	)
		throw new Error('Executed fixture sources changed');
	await Promise.all(
		(['auth', 'gateway'] as const).map(async (name) => {
			if (proofDigest(await readFile(artifacts[name].file, 'utf8')) !== artifacts[name].sha256)
				throw new Error('Executed artifact changed');
		}),
	);
	const actual = report.testResults.flatMap((file) =>
		file.assertionResults
			.filter((test) => test.status === 'passed')
			.map((test) => ({
				file: file.name,
				name: [...test.ancestorTitles, test.title].join(' > '),
			})),
	);
	requireMatchingAuthObservations({ selected, actual, passedCount: report.numPassedTests, root });
	const receipts = (await readdir(evidence)).filter((file) =>
		/^harness-[a-f0-9-]+\.json$/u.test(file),
	);
	if (receipts.length === 0) throw new Error('No actual harness target receipt');
	const receiptContents = await Promise.all(
		receipts.map((file) => readFile(path.join(evidence, file), 'utf8')),
	);
	for (const contents of receiptContents) {
		const receipt = z
			.object({
				identity: proofBundleManifestSchema,
				ready: z.literal(true),
				configuration: z.object({
					signIn: z.object({
						issuer: z.url(),
						agentAudience: z.literal('https://portal-test.invalid/mcp'),
						managementAudience: z.literal('https://portal-test.invalid/management'),
						ownerCliClientId: z.literal('owner-cli-local'),
						ownerCliRedirectUri: z.literal('http://127.0.0.1/callback'),
						managementHumanCheck: z.literal('remembered-login'),
						accessTokenSeconds: z.literal(300),
					}),
					gateway: z.object({
						SIGN_IN_ISSUER: z.string(),
						SIGN_IN_JWKS_URL: z.string(),
						TOOL_PORTAL_AUDIENCE: z.string(),
						MANAGEMENT_AUDIENCE: z.string(),
						ORGANIZATION_CONFIGURATIONS: z.string(),
					}),
				}),
				client: z.object({
					issuer: z.url(),
					ownerCliClientId: z.literal('owner-cli-local'),
					ownerCliRedirectUri: z.literal('http://127.0.0.1/callback'),
					managementAudience: z.literal('https://portal-test.invalid/management'),
					entry: z.literal('scripts/verify-auth/owner-cli.ts'),
				}),
			})
			.parse(JSON.parse(contents));
		const config = receipt.configuration;
		if (
			JSON.stringify(receipt.identity) !== JSON.stringify(artifacts) ||
			new URL(config.signIn.issuer).hostname !== '127.0.0.1' ||
			receipt.client.issuer !== config.signIn.issuer ||
			config.gateway.SIGN_IN_ISSUER !== config.signIn.issuer ||
			config.gateway.SIGN_IN_JWKS_URL !== `${config.signIn.issuer}/api/auth/jwks` ||
			config.gateway.TOOL_PORTAL_AUDIENCE !== config.signIn.agentAudience ||
			config.gateway.MANAGEMENT_AUDIENCE !== config.signIn.managementAudience
		)
			throw new Error('Actual configuration/client/artifacts differ from declared fixture');
	}
	await writeFile(
		path.join(evidence, journey + '-compared-target.json'),
		JSON.stringify({ ...tuple, receipts, comparison: 'matched' }),
		{ mode: 0o600 },
	);
	process.stdout.write(
		JSON.stringify({
			journey,
			layer: 'host-e2e',
			passed: report.numPassedTests,
			failed: report.numFailedTests,
			offered: inventory.length,
			selected: selected.length,
			unselected: inventory.length - selected.length,
			reporterSkippedWithinFiles: report.numPendingTests,
			targetComparison: 'matched',
			evidence,
		}) + '\n',
	);
	return 0;
}

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
Requires a clean frozen checkout, Node24.7.0 and pnpm10.33.0; installs its frozen lockfile, builds workspace dependencies and freezes executable Worker bytes before running. Missing prerequisites and zero passing selected observations fail.
Evidence is retained in an owned OS-temp directory. Unselected journeys are reported separately; hosted identity/CPU and stronger human-intent checks remain unverified.\n`);
		return 0;
	}
	let evidenceDirectory: string | undefined;
	try {
		const journey = z.enum(['agent', 'bootstrap']).parse(positionals[0]);
		if (positionals.length !== 1) throw new Error('Expected exactly one verification journey');
		const prepared = await prepareAuthVerification(
			z.string().min(1).parse(values['target-file']),
			(directory) => {
				evidenceDirectory = directory;
			},
		);
		return await runPreparedAuthVerification(prepared, journey);
	} catch {
		if (evidenceDirectory !== undefined)
			process.stderr.write(`Private prerequisite/comparison evidence: ${evidenceDirectory}\n`);
		process.stderr.write(
			'Auth verification refused missing, invalid or mismatched target/prerequisites; no observation counted.\n',
		);
		return 1;
	}
}
