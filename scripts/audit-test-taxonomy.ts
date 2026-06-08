import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const allowedTestSuffixes = [
	'.unit.test.ts',
	'.unit.spec.ts',
	'.integration.test.ts',
	'.llm.integration.test.ts',
	'.smoke.test.ts',
] as const;

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

function hasAllowedSuffix(filePath: string): boolean {
	return allowedTestSuffixes.some((suffix) => filePath.endsWith(suffix));
}

function isUnitTest(filePath: string): boolean {
	return filePath.endsWith('.unit.test.ts') || filePath.endsWith('.unit.spec.ts');
}

async function collectViolations(): Promise<readonly string[]> {
	const testFiles = await listTrackedTestFiles();
	const fileViolations = await Promise.all(
		testFiles.map(async (filePath): Promise<readonly string[]> => {
			const violations: string[] = [];
			if (!hasAllowedSuffix(filePath)) {
				violations.push(
					`${filePath}: test files must use .unit.test.ts, .integration.test.ts, .llm.integration.test.ts, or .smoke.test.ts`,
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

const violations = await collectViolations();
if (violations.length > 0) {
	process.stderr.write('Test taxonomy audit failed:\n');
	for (const violation of violations) {
		process.stderr.write(`- ${violation}\n`);
	}
	process.exit(1);
}

process.stdout.write('Test taxonomy audit passed.\n');
