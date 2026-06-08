import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

interface VitestJsonAssertionResult {
	readonly fullName: string;
	readonly status: string;
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

interface EvidenceValidationResult {
	readonly messages: readonly string[];
	readonly ok: boolean;
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
	if (typeof fullName !== 'string' || typeof status !== 'string') {
		throw new Error('Vitest JSON assertion result must include fullName and status.');
	}
	return { fullName, status };
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
	projectName: string,
	results: VitestJsonResults,
): EvidenceValidationResult {
	const messages: string[] = [];
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

	return { messages, ok: messages.length === 0 };
}

async function runVitestProject(
	projectName: string,
	outputFilePath: string,
	filters: readonly string[],
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(
			'pnpm',
			[
				'vitest',
				'run',
				'--config',
				'vitest.config.ts',
				'--project',
				projectName,
				'--reporter=default',
				'--reporter=json',
				`--outputFile.json=${outputFilePath}`,
				...filters,
			],
			{ cwd: repositoryRoot, stdio: 'inherit' },
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
						? `Vitest project ${projectName} exited with code ${String(code)}.`
						: `Vitest project ${projectName} exited with signal ${signal}.`,
				),
			);
		});
	});
}

export async function runEvidenceProject(
	projectName: string,
	filters: readonly string[] = [],
): Promise<EvidenceValidationResult> {
	const outputDirectory = path.resolve(repositoryRoot, 'tmp', 'vitest-results');
	await mkdir(outputDirectory, { recursive: true });
	const outputFilePath = path.join(outputDirectory, `${projectName}.json`);

	await runVitestProject(projectName, outputFilePath, filters);

	const results = parseVitestJsonResults(await readFile(outputFilePath, 'utf8'));
	return validateProofProjectResults(projectName, results);
}

async function main(): Promise<void> {
	const projectName = process.argv[2];
	if (typeof projectName !== 'string' || projectName.length === 0) {
		process.stderr.write(
			'Usage: tsx scripts/run-vitest-evidence-project.ts <project-name> [test-filter...]\n',
		);
		process.exit(1);
	}

	const result = await runEvidenceProject(projectName, process.argv.slice(3));
	if (!result.ok) {
		process.stderr.write('Vitest evidence project failed:\n');
		for (const message of result.messages) {
			process.stderr.write(`- ${message}\n`);
		}
		process.exit(1);
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	await main();
}
