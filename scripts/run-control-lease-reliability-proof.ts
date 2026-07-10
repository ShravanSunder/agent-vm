import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
	CONTROL_LEASE_RELIABILITY_SCENARIOS,
	type ControlLeaseReliabilityOperationId,
	type ControlLeaseReliabilityProject,
	type ControlLeaseReliabilityScenario,
} from './control-lease-reliability-scenarios.js';
import {
	reliabilityScenarioEvidenceSchema,
	validateReliabilityEvidenceManifest,
	type ReliabilityEvidenceManifest,
	type ReliabilityEvidencePackageIdentity,
	type ReliabilityEvidenceReceipt,
	type ReliabilityEvidenceValidationResult,
	type ReliabilityScenarioEvidence,
} from './reliability-evidence-manifest.js';

export interface ReliabilityScenarioExecutionInput {
	readonly args: readonly string[];
	readonly environment: Readonly<Record<string, string>>;
	readonly evidenceFilePath: string;
	readonly operationId: ControlLeaseReliabilityOperationId;
}

export interface ReliabilityScenarioExecutionCounts {
	readonly exitCode: number;
	readonly failedTests: number;
	readonly fileCount: number;
	readonly passedTests: number;
	readonly skippedTests: number;
	readonly todoTests: number;
	readonly totalTests: number;
}

export interface ReliabilityScenarioResult extends ReliabilityScenarioExecutionCounts {
	readonly evidence?: ReliabilityScenarioEvidence | undefined;
	readonly operationId: ControlLeaseReliabilityOperationId;
	readonly project: ControlLeaseReliabilityProject;
	readonly testFile: string;
}

export type ReliabilityScenarioExecutor = (input: ReliabilityScenarioExecutionInput) => Promise<
	ReliabilityScenarioExecutionCounts & {
		readonly evidenceInput?: unknown;
	}
>;

export interface ReliabilityScenarioRunBindings {
	readonly dirtyHash: string;
	readonly evidenceDirectory: string;
	readonly headSha: string;
	readonly runId: string;
}

interface CreateReliabilityAggregateManifestOptions {
	readonly createReceiptId?: () => string;
	readonly dirtyHash: string;
	readonly headSha: string;
	readonly nowMs: number;
	readonly packageIdentity?: ReliabilityEvidencePackageIdentity;
	readonly results: readonly ReliabilityScenarioResult[];
	readonly runId: string;
}

interface SpawnCaptureResult {
	readonly exitCode: number;
	readonly output: string;
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sha256(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function parseCapturedScenarioCounts(
	result: SpawnCaptureResult,
): ReliabilityScenarioExecutionCounts {
	const summaryMatch =
		/(?<totalTests>\d+) tests, (?<fileCount>\d+) files, (?<skippedTests>\d+) skipped, (?<todoTests>\d+) todo/u.exec(
			result.output,
		);
	if (summaryMatch?.groups !== undefined) {
		const totalTests = Number(summaryMatch.groups.totalTests);
		const skippedTests = Number(summaryMatch.groups.skippedTests);
		const todoTests = Number(summaryMatch.groups.todoTests);
		return {
			exitCode: result.exitCode,
			failedTests: result.exitCode === 0 ? 0 : 1,
			fileCount: Number(summaryMatch.groups.fileCount),
			passedTests: Math.max(0, totalTests - skippedTests - todoTests),
			skippedTests,
			todoTests,
			totalTests,
		};
	}

	const skippedMatch = /expected zero skipped tests, found (?<count>\d+)/u.exec(result.output);
	const todoMatch = /expected zero todo tests, found (?<count>\d+)/u.exec(result.output);
	const zeroTests = result.output.includes('expected at least one test, found zero');
	const skippedTests = Number(skippedMatch?.groups?.count ?? 0);
	const todoTests = Number(todoMatch?.groups?.count ?? 0);
	const failedTests = result.exitCode === 0 || zeroTests || skippedTests + todoTests > 0 ? 0 : 1;
	return {
		exitCode: result.exitCode,
		failedTests,
		fileCount: zeroTests ? 0 : 1,
		passedTests: 0,
		skippedTests,
		todoTests,
		totalTests: zeroTests ? 0 : failedTests + skippedTests + todoTests,
	};
}

async function spawnAndCapture(
	args: readonly string[],
	environment: Readonly<Record<string, string>> = {},
): Promise<SpawnCaptureResult> {
	return new Promise<SpawnCaptureResult>((resolve, reject) => {
		const child = spawn('pnpm', args, {
			cwd: repositoryRoot,
			env: { ...process.env, ...environment },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let output = '';
		child.stdout.on('data', (chunk: Buffer) => {
			output += chunk.toString('utf8');
			process.stdout.write(chunk);
		});
		child.stderr.on('data', (chunk: Buffer) => {
			output += chunk.toString('utf8');
			process.stderr.write(chunk);
		});
		child.on('error', reject);
		child.on('exit', (code, signal) => {
			if (signal !== null) {
				resolve({ exitCode: 1, output: `${output}\nscenario terminated` });
				return;
			}
			resolve({ exitCode: code ?? 1, output });
		});
	});
}

async function executeScenarioWithEvidenceProject(
	input: ReliabilityScenarioExecutionInput,
): Promise<
	ReliabilityScenarioExecutionCounts & {
		readonly evidenceInput?: unknown;
	}
> {
	const counts = parseCapturedScenarioCounts(await spawnAndCapture(input.args, input.environment));
	let evidenceInput: unknown;
	try {
		evidenceInput = JSON.parse(await readFile(input.evidenceFilePath, 'utf8')) as unknown;
	} catch {
		return counts;
	}
	return { ...counts, evidenceInput };
}

export async function runControlLeaseReliabilityScenarios(
	scenarios: readonly ControlLeaseReliabilityScenario[],
	bindings: ReliabilityScenarioRunBindings,
	executeScenario: ReliabilityScenarioExecutor = executeScenarioWithEvidenceProject,
): Promise<readonly ReliabilityScenarioResult[]> {
	const results: ReliabilityScenarioResult[] = [];
	for (const scenario of scenarios) {
		const evidenceFilePath = path.join(bindings.evidenceDirectory, `${scenario.operationId}.json`);
		// Reliability scenarios intentionally run serially to avoid competing for VM resources.
		// eslint-disable-next-line no-await-in-loop
		const counts = await executeScenario({
			args: ['tsx', 'scripts/run-vitest-evidence-project.ts', scenario.project, scenario.testFile],
			environment: {
				AGENT_VM_RELIABILITY_DIRTY_HASH: bindings.dirtyHash,
				AGENT_VM_RELIABILITY_EVIDENCE_FILE: evidenceFilePath,
				AGENT_VM_RELIABILITY_HEAD_SHA: bindings.headSha,
				AGENT_VM_RELIABILITY_OPERATION_ID: scenario.operationId,
				AGENT_VM_RELIABILITY_RUN_ID: bindings.runId,
			},
			evidenceFilePath,
			operationId: scenario.operationId,
		});
		const parsedEvidence = reliabilityScenarioEvidenceSchema.safeParse(counts.evidenceInput);
		const { evidenceInput: _evidenceInput, ...executionCounts } = counts;
		results.push({
			...scenario,
			...executionCounts,
			...(parsedEvidence.success ? { evidence: parsedEvidence.data } : {}),
		});
	}
	return results;
}

export function createReliabilityAggregateManifest(
	options: CreateReliabilityAggregateManifestOptions,
): ReliabilityEvidenceManifest {
	const packageIdentity = options.packageIdentity ?? {
		checksumSha256: sha256(`${options.headSha}:${options.dirtyHash}`),
		name: 'agent-vm-workspace',
		version: '0.0.1',
	};
	const createReceiptId = options.createReceiptId ?? randomUUID;
	const receipts: ReliabilityEvidenceReceipt[] = options.results.map((result) => ({
		artifacts: result.evidence?.artifacts ?? [
			{
				operationId: `${result.operationId}-result`,
				sha256: sha256(JSON.stringify(result)),
			},
		],
		dirtyHash: result.evidence?.dirtyHash ?? options.dirtyHash,
		exitCode: result.exitCode,
		failedTests: result.failedTests,
		fileCount: result.fileCount,
		generationIdentities: result.evidence?.generationIdentities,
		headSha: result.evidence?.headSha ?? options.headSha,
		operationId: result.evidence?.operationId ?? result.operationId,
		packageIdentities: result.evidence?.packageIdentities ?? [packageIdentity],
		passedTests: result.passedTests,
		processIdentities: result.evidence?.processIdentities,
		project: result.project,
		queryIdentities: result.evidence?.queryIdentities,
		receiptId: createReceiptId(),
		runId: result.evidence?.runId ?? options.runId,
		runtimeIdentities: result.evidence?.runtimeIdentities,
		schemaVersion: 1,
		skippedTests: result.skippedTests,
		todoTests: result.todoTests,
		totalTests: result.totalTests,
	}));
	return {
		createdAtMs: options.nowMs,
		dirtyHash: options.dirtyHash,
		headSha: options.headSha,
		receipts,
		runId: options.runId,
		schemaVersion: 1,
	};
}

export function validateControlLeaseReliabilityAggregate(
	manifest: ReliabilityEvidenceManifest,
	scenarios: readonly ControlLeaseReliabilityScenario[],
): ReliabilityEvidenceValidationResult {
	return validateReliabilityEvidenceManifest(
		manifest,
		scenarios.map(({ operationId, project, requiresQueryIdentity }) => ({
			operationId,
			project,
			requireGenerationIdentity: true,
			requireProcessIdentity: true,
			requireQueryIdentity: requiresQueryIdentity,
			requireRuntimeIdentity: true,
		})),
	);
}

async function readGitIdentity(args: readonly string[]): Promise<string> {
	const result = await spawnAndCapture(['exec', 'git', ...args]);
	if (result.exitCode !== 0) {
		throw new Error('Unable to read repository identity.');
	}
	return result.output.trim();
}

async function main(): Promise<void> {
	const runId = randomUUID();
	const headSha = await readGitIdentity(['rev-parse', 'HEAD']);
	const dirtyHash = sha256(await readGitIdentity(['status', '--short']));
	const outputDirectory = path.join(repositoryRoot, 'tmp', 'control-lease-reliability', runId);
	const evidenceDirectory = path.join(outputDirectory, 'scenario-evidence');
	await mkdir(evidenceDirectory, { recursive: true });
	const packageJsonInput = JSON.parse(
		await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'),
	) as unknown;
	if (
		typeof packageJsonInput !== 'object' ||
		packageJsonInput === null ||
		!('name' in packageJsonInput) ||
		typeof packageJsonInput.name !== 'string' ||
		!('version' in packageJsonInput) ||
		typeof packageJsonInput.version !== 'string'
	) {
		throw new Error('Root package identity is invalid.');
	}
	const results = await runControlLeaseReliabilityScenarios(CONTROL_LEASE_RELIABILITY_SCENARIOS, {
		dirtyHash,
		evidenceDirectory,
		headSha,
		runId,
	});
	const manifest = createReliabilityAggregateManifest({
		dirtyHash,
		headSha,
		nowMs: Date.now(),
		packageIdentity: {
			checksumSha256: sha256(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8')),
			name: packageJsonInput.name,
			version: packageJsonInput.version,
		},
		results,
		runId,
	});
	await writeFile(
		path.join(outputDirectory, 'manifest.json'),
		`${JSON.stringify(manifest, null, '\t')}\n`,
		'utf8',
	);
	const validation = validateControlLeaseReliabilityAggregate(
		manifest,
		CONTROL_LEASE_RELIABILITY_SCENARIOS,
	);
	if (!validation.ok) {
		for (const finding of validation.findings) {
			process.stderr.write(`${finding}\n`);
		}
		process.exitCode = 1;
		return;
	}
	process.stdout.write(`Control/lease reliability proof passed for run ${runId}.\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	await main();
}
