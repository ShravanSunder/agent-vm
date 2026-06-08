import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const allowedTestSuffixes = [
	'.unit.test.ts',
	'.unit.spec.ts',
	'.integration.test.ts',
	'.vm.e2e.test.ts',
	'.openclaw.e2e.test.ts',
	'.worker.e2e.test.ts',
	'.secrets.e2e.test.ts',
	'.llm.e2e.test.ts',
] as const;

const forbiddenTestSuffixes = ['.smoke.test.ts', '.llm.integration.test.ts'] as const;

const unitBoundaryPatterns: readonly RegExp[] = [
	/^import\s+.*\s+from\s+['"]execa['"]/mu,
	/^import\s+.*\s+from\s+['"]node:child_process['"]/mu,
	/\bexecFileSync\s*\(/u,
	/\bspawnSync\s*\(/u,
	/\bexecFile\s*\(/u,
	/\bspawn\s*\(/u,
	/\.listen\s*\(/u,
];

const unitWallClockWaitPatterns: readonly RegExp[] = [
	/await\s+new\s+Promise[^\n]*setTimeout/u,
	/\bawait\s+sleep\s*\(/u,
	/\bawait\s+delay\s*\(/u,
];

async function collectTestFiles(rootPath: string): Promise<readonly string[]> {
	const entries = await readdir(rootPath, { withFileTypes: true });
	const files = await Promise.all(
		entries.map(async (entry): Promise<readonly string[]> => {
			const entryPath = path.join(rootPath, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === 'node_modules') {
					return [];
				}
				return await collectTestFiles(entryPath);
			}
			if (entry.isFile() && (entry.name.endsWith('.test.ts') || entry.name.endsWith('.spec.ts'))) {
				return [entryPath];
			}
			return [];
		}),
	);
	return files.flat().map((filePath) => filePath.split(path.sep).join('/'));
}

async function listTrackedTestFiles(): Promise<readonly string[]> {
	const [packageTests, scriptTests] = await Promise.all([
		collectTestFiles('packages'),
		collectTestFiles('scripts'),
	]);
	const testFiles = [...packageTests, ...scriptTests];
	// oxlint-disable-next-line no-array-sort -- deterministic audit output is easier to read.
	return testFiles.sort((leftPath, rightPath) => leftPath.localeCompare(rightPath));
}

export function hasAllowedTestSuffix(filePath: string): boolean {
	if (forbiddenTestSuffixes.some((suffix) => filePath.endsWith(suffix))) {
		return false;
	}
	return allowedTestSuffixes.some((suffix) => filePath.endsWith(suffix));
}

export function isUnitTest(filePath: string): boolean {
	return filePath.endsWith('.unit.test.ts') || filePath.endsWith('.unit.spec.ts');
}

async function collectViolations(): Promise<readonly string[]> {
	const testFiles = await listTrackedTestFiles();
	const fileViolations = await Promise.all(
		testFiles.map(async (filePath): Promise<readonly string[]> => {
			const violations: string[] = [];
			if (!hasAllowedTestSuffix(filePath)) {
				violations.push(
					`${filePath}: test files must use .unit.test.ts, .integration.test.ts, .vm.e2e.test.ts, .openclaw.e2e.test.ts, .worker.e2e.test.ts, .secrets.e2e.test.ts, or .llm.e2e.test.ts`,
				);
				return violations;
			}
			if (!isUnitTest(filePath)) {
				return violations;
			}

			const source = await readFile(filePath, 'utf8');
			for (const pattern of unitBoundaryPatterns) {
				if (pattern.test(source)) {
					violations.push(`${filePath}: unit tests must not cross real process/network boundaries`);
					break;
				}
			}
			for (const pattern of unitWallClockWaitPatterns) {
				if (pattern.test(source)) {
					violations.push(`${filePath}: unit tests must not wait on wall-clock time`);
					break;
				}
			}
			return violations;
		}),
	);
	return fileViolations.flat();
}

async function main(): Promise<void> {
	const violations = await collectViolations();
	if (violations.length > 0) {
		process.stderr.write('Test taxonomy audit failed:\n');
		for (const violation of violations) {
			process.stderr.write(`- ${violation}\n`);
		}
		process.exit(1);
	}

	process.stdout.write('Test taxonomy audit passed.\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	await main();
}
