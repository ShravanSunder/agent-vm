import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

interface VitestJsonAssertionResult {
	readonly fullName: string;
	readonly status: string;
	readonly tags: readonly string[];
}

interface VitestJsonTestResult {
	readonly assertionResults: readonly VitestJsonAssertionResult[];
	readonly name: string;
}

interface VitestJsonResults {
	readonly numPendingTests: number;
	readonly numTodoTests: number;
	readonly numTotalTests: number;
	readonly testResults: readonly VitestJsonTestResult[];
}

interface ValidateProofProjectResultsOptions {
	readonly projectName: string;
	readonly resultFilePath?: string;
	readonly results: VitestJsonResults;
	readonly selectedTags?: readonly string[];
}

interface RunVitestProjectOptions {
	readonly env: Readonly<Record<string, string>>;
	readonly filters: readonly string[];
	readonly outputFilePath: string;
	readonly projectName: string;
}

interface EvidenceValidationResult {
	readonly messages: readonly string[];
	readonly ok: boolean;
	readonly summary?: VitestEvidenceSummary | undefined;
}

interface VitestEvidenceObservabilityState {
	readonly marker: string;
	readonly projectName: string;
	readonly queryStart: string;
	readonly runId: string;
	readonly stateFilePath: string;
}

interface VitestEvidenceObservabilityEnvironment {
	readonly env: Readonly<Record<string, string>>;
	readonly state: VitestEvidenceObservabilityState;
}

export interface VitestEvidenceSummary {
	readonly pendingTests: number;
	readonly projectName: string;
	readonly resultFilePath: string;
	readonly testFiles: number;
	readonly todoTests: number;
	readonly totalTests: number;
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localToolVmPackageEvidenceProjects = new Set([
	'e2e-hermes',
	'e2e-openclaw',
	'e2e-vm',
	'e2e-vm-managed-gateway',
	'e2e-vm-mediation',
	'e2e-worker',
]);

export function resolveVitestJsonOutputFilePath(
	rootDirectory: string,
	projectName: string,
	runId: string,
): string {
	return path.join(
		rootDirectory,
		'tmp',
		'vitest-results',
		`${projectName}-${runId}`,
		'results.json',
	);
}

export function createVitestEvidenceObservabilityEnvironment(options: {
	readonly now?: () => Date;
	readonly projectName: string;
	readonly runDirectory: string;
	readonly runId: string;
}): VitestEvidenceObservabilityEnvironment {
	const queryStart = (options.now ?? (() => new Date()))().toISOString();
	const marker = `agent-vm-${options.projectName}-${options.runId}`;
	const stateFilePath = path.join(options.runDirectory, 'observability-state.json');
	const state = {
		marker,
		projectName: options.projectName,
		queryStart,
		runId: options.runId,
		stateFilePath,
	} satisfies VitestEvidenceObservabilityState;
	return {
		env: {
			...(localToolVmPackageEvidenceProjects.has(options.projectName)
				? { AGENT_VM_E2E_USE_LOCAL_TOOL_VM_PACKAGES: '1' }
				: {}),
			AGENT_VM_OBSERVABILITY_MARKER: marker,
			AGENT_VM_OBSERVABILITY_QUERY_START: queryStart,
			AGENT_VM_OBSERVABILITY_RELEASE_CHANNEL: 'local',
			AGENT_VM_OBSERVABILITY_RUNTIME_FLAVOR: 'e2e',
			AGENT_VM_OBSERVABILITY_STATE_FILE: stateFilePath,
		},
		state,
	};
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function readNumberField(record: Readonly<Record<string, unknown>>, fieldName: string): number {
	const value = record[fieldName];
	if (typeof value !== 'number') {
		throw new Error(`Vitest JSON result field ${fieldName} must be a number.`);
	}
	return value;
}

function parseAssertionResult(value: unknown): VitestJsonAssertionResult {
	if (!isObjectRecord(value)) {
		throw new Error('Vitest JSON assertion result must be an object.');
	}
	const fullName = value.fullName;
	const status = value.status;
	const tags = value.tags;
	if (
		typeof fullName !== 'string' ||
		typeof status !== 'string' ||
		!Array.isArray(tags) ||
		!tags.every((tag) => typeof tag === 'string')
	) {
		throw new Error('Vitest JSON assertion result must include fullName, status, and tags.');
	}
	return { fullName, status, tags };
}

function parseTestResult(value: unknown): VitestJsonTestResult {
	if (!isObjectRecord(value)) {
		throw new Error('Vitest JSON test result must be an object.');
	}
	const name = value.name;
	const assertionResults = value.assertionResults;
	if (typeof name !== 'string' || !Array.isArray(assertionResults)) {
		throw new Error('Vitest JSON test result must include name and assertionResults.');
	}
	return {
		assertionResults: assertionResults.map(parseAssertionResult),
		name,
	};
}

export function parseVitestJsonResults(rawJson: string): VitestJsonResults {
	const parsed = JSON.parse(rawJson) as unknown;
	if (!isObjectRecord(parsed)) {
		throw new Error('Vitest JSON result must be an object.');
	}
	const testResults = parsed.testResults;
	if (!Array.isArray(testResults)) {
		throw new Error('Vitest JSON result must include testResults.');
	}
	return {
		numPendingTests: readNumberField(parsed, 'numPendingTests'),
		numTodoTests: readNumberField(parsed, 'numTodoTests'),
		numTotalTests: readNumberField(parsed, 'numTotalTests'),
		testResults: testResults.map(parseTestResult),
	};
}

export function validateProofProjectResults(
	options: ValidateProofProjectResultsOptions,
): EvidenceValidationResult {
	const { projectName, resultFilePath, results, selectedTags } = options;
	const selectedAssertions =
		selectedTags === undefined
			? undefined
			: results.testResults.flatMap((testResult) =>
					testResult.assertionResults.filter((assertionResult) =>
						selectedTags.every((selectedTag) => assertionResult.tags.includes(selectedTag)),
					),
				);
	const selectedPassedTests =
		selectedAssertions?.filter((assertionResult) => assertionResult.status === 'passed').length ??
		0;
	const selectedTodoTests =
		selectedAssertions?.filter((assertionResult) => assertionResult.status === 'todo').length ?? 0;
	const messages: string[] = [];
	if (selectedAssertions === undefined) {
		if (results.numTotalTests === 0) {
			messages.push(`${projectName}: expected at least one test, found zero.`);
		}
		if (results.numPendingTests > 0) {
			messages.push(
				`${projectName}: expected zero skipped tests, found ${String(results.numPendingTests)}.`,
			);
		}
		if (results.numTodoTests > 0) {
			messages.push(
				`${projectName}: expected zero todo tests, found ${String(results.numTodoTests)}.`,
			);
		}
	} else if (selectedAssertions.length === 0) {
		messages.push(`${projectName}: expected at least one tag-selected test, found zero.`);
	} else if (selectedPassedTests !== selectedAssertions.length) {
		messages.push(
			`${projectName}: expected all ${String(selectedAssertions.length)} tag-selected tests to pass, found ${String(selectedPassedTests)} passed.`,
		);
	}
	const summaryTotalTests = selectedAssertions?.length ?? results.numTotalTests;
	const summaryPendingTests =
		selectedAssertions === undefined
			? results.numPendingTests
			: Math.max(selectedAssertions.length - selectedPassedTests - selectedTodoTests, 0);
	const summaryTodoTests =
		selectedAssertions === undefined ? results.numTodoTests : selectedTodoTests;
	const summaryTestFiles =
		selectedTags === undefined
			? results.testResults.length
			: results.testResults.filter((testResult) =>
					testResult.assertionResults.some((assertionResult) =>
						selectedTags.every((selectedTag) => assertionResult.tags.includes(selectedTag)),
					),
				).length;

	return {
		messages,
		ok: messages.length === 0,
		summary:
			resultFilePath === undefined
				? undefined
				: {
						pendingTests: summaryPendingTests,
						projectName,
						resultFilePath,
						testFiles: summaryTestFiles,
						todoTests: summaryTodoTests,
						totalTests: summaryTotalTests,
					},
	};
}

export function formatVitestEvidenceSummary(summary: VitestEvidenceSummary): string {
	return `${summary.projectName}: ${String(summary.totalTests)} tests, ${String(summary.testFiles)} files, ${String(summary.pendingTests)} skipped, ${String(summary.todoTests)} todo, result=${summary.resultFilePath}`;
}

async function runVitestProject(options: RunVitestProjectOptions): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(
			'pnpm',
			[
				'vitest',
				'run',
				'--config',
				'vitest.config.ts',
				'--project',
				options.projectName,
				'--reporter=default',
				'--reporter=json',
				`--outputFile.json=${options.outputFilePath}`,
				...options.filters,
			],
			{
				cwd: repositoryRoot,
				env: { ...process.env, ...options.env },
				stdio: 'inherit',
			},
		);
		child.on('error', reject);
		child.on('exit', (code, signal) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(
				new Error(
					signal === null
						? `Vitest project ${options.projectName} exited with code ${String(code)}.`
						: `Vitest project ${options.projectName} exited with signal ${signal}.`,
				),
			);
		});
	});
}

function requireSimpleTagName(tagExpression: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(tagExpression)) {
		throw new Error(
			`Vitest evidence projects support only simple positive tag filters, received: ${tagExpression}`,
		);
	}
	return tagExpression;
}

export function resolveSimpleVitestTagSelection(
	filters: readonly string[],
): readonly string[] | undefined {
	const selectedTags: string[] = [];
	for (let filterIndex = 0; filterIndex < filters.length; filterIndex += 1) {
		const filter = filters[filterIndex];
		if (filter === '--tags-filter' || filter === '--tagsFilter') {
			const tagExpression = filters[filterIndex + 1];
			if (tagExpression === undefined) {
				throw new Error(`${filter} requires a tag expression.`);
			}
			selectedTags.push(requireSimpleTagName(tagExpression));
			filterIndex += 1;
			continue;
		}
		const tagExpression =
			filter?.startsWith('--tags-filter=') === true
				? filter.slice('--tags-filter='.length)
				: filter?.startsWith('--tagsFilter=') === true
					? filter.slice('--tagsFilter='.length)
					: undefined;
		if (tagExpression !== undefined) {
			selectedTags.push(requireSimpleTagName(tagExpression));
		}
	}
	return selectedTags.length === 0 ? undefined : [...new Set(selectedTags)];
}

export async function runEvidenceProject(
	projectName: string,
	filters: readonly string[] = [],
): Promise<EvidenceValidationResult> {
	const outputDirectory = path.resolve(repositoryRoot, 'tmp', 'vitest-results');
	await mkdir(outputDirectory, { recursive: true });
	const runDirectory = await mkdtemp(path.join(outputDirectory, `${projectName}-${process.pid}-`));
	const runId = path.basename(runDirectory).slice(`${projectName}-`.length);
	const outputFilePath = resolveVitestJsonOutputFilePath(repositoryRoot, projectName, runId);
	await mkdir(path.dirname(outputFilePath), { recursive: true });
	const observability = createVitestEvidenceObservabilityEnvironment({
		projectName,
		runDirectory,
		runId,
	});
	await writeFile(
		observability.state.stateFilePath,
		`${JSON.stringify(observability.state, null, '\t')}\n`,
		'utf8',
	);
	const selectedTags = resolveSimpleVitestTagSelection(filters);

	await runVitestProject({
		env: observability.env,
		filters,
		outputFilePath,
		projectName,
	});

	const results = parseVitestJsonResults(await readFile(outputFilePath, 'utf8'));
	return validateProofProjectResults({
		projectName,
		resultFilePath: outputFilePath,
		results,
		...(selectedTags === undefined ? {} : { selectedTags }),
	});
}

export function normalizeVitestFilters(filters: readonly string[]): readonly string[] {
	return filters[0] === '--' ? filters.slice(1) : filters;
}

async function main(): Promise<void> {
	const projectName = process.argv[2];
	if (typeof projectName !== 'string' || projectName.length === 0) {
		process.stderr.write(
			'Usage: tsx scripts/run-vitest-evidence-project.ts <project-name> [test-filter...]\n',
		);
		process.exit(1);
	}

	const result = await runEvidenceProject(
		projectName,
		normalizeVitestFilters(process.argv.slice(3)),
	);
	if (!result.ok) {
		process.stderr.write('Vitest evidence project failed:\n');
		for (const message of result.messages) {
			process.stderr.write(`- ${message}\n`);
		}
		process.exit(1);
	}
	if (result.summary !== undefined) {
		process.stdout.write(`${formatVitestEvidenceSummary(result.summary)}\n`);
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	await main();
}
