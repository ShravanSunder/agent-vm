import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import * as ts from 'typescript';

const allowedTestSuffixes = [
	'.unit.test.ts',
	'.unit.spec.ts',
	'.integration.test.ts',
	'.host.e2e.test.ts',
	'.vm.e2e.test.ts',
	'.hermes.e2e.test.ts',
	'.worker.e2e.test.ts',
	'.secrets.e2e.test.ts',
	'.llm.e2e.test.ts',
] as const;

const forbiddenTestSuffixes = ['.smoke.test.ts', '.llm.integration.test.ts'] as const;

const unitBoundaryImportPatterns: readonly RegExp[] = [
	/^import\s+.*\s+from\s+['"]execa['"]/mu,
	/^import\s+.*\s+from\s+['"]node:child_process['"]/mu,
];

const unitBoundaryCallPatterns: readonly RegExp[] = [
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

const integrationWallClockWaitPatterns: readonly RegExp[] = [
	/\bsetTimeout\s*\(/u,
	/\bsetInterval\s*\(/u,
	/\bawait\s+sleep\s*\(/u,
	/\bawait\s+delay\s*\(/u,
];

const e2eWallClockSleepPatterns: readonly RegExp[] = [
	/await\s+new\s+Promise[\s\S]*?setTimeout/u,
	/\bawait\s+sleep\s*\(/u,
	/\bawait\s+delay\s*\(/u,
];

const timerPromisesModuleSpecifiers = new Set(['node:timers/promises', 'timers/promises']);

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

export function isIntegrationTest(filePath: string): boolean {
	return filePath.endsWith('.integration.test.ts');
}

export function isE2eTest(filePath: string): boolean {
	return allowedTestSuffixes.some(
		(suffix) => suffix.endsWith('.e2e.test.ts') && filePath.endsWith(suffix),
	);
}

export function resolveTestFileProjectNames(filePath: string): readonly string[] {
	const projectNames: string[] = [];
	if (filePath.startsWith('packages/')) {
		if (isUnitTest(filePath)) {
			projectNames.push('unit');
		}
		if (filePath.endsWith('.integration.test.ts')) {
			projectNames.push('integration');
		}
		if (filePath.endsWith('.host.e2e.test.ts')) {
			projectNames.push('e2e-host');
		}
		if (
			filePath.endsWith('.vm.e2e.test.ts') &&
			!filePath.endsWith('/live-gondolin-http-mediation.vm.e2e.test.ts') &&
			!filePath.endsWith('/live-http-mediation.vm.e2e.test.ts')
		) {
			projectNames.push('e2e-vm');
		}
		if (
			filePath.endsWith('/live-gondolin-http-mediation.vm.e2e.test.ts') ||
			filePath.endsWith('/live-http-mediation.vm.e2e.test.ts')
		) {
			projectNames.push('e2e-vm-mediation');
		}
		if (filePath.endsWith('.hermes.e2e.test.ts')) {
			projectNames.push('e2e-hermes');
		}
		if (filePath.endsWith('.worker.e2e.test.ts')) {
			projectNames.push('e2e-worker');
		}
		if (filePath.endsWith('.secrets.e2e.test.ts')) {
			projectNames.push('e2e-secrets');
		}
		if (filePath.endsWith('.llm.e2e.test.ts')) {
			projectNames.push('e2e-llm');
		}
		return projectNames;
	}
	if (filePath.startsWith('scripts/') && filePath.endsWith('.unit.test.ts')) {
		return ['unit'];
	}
	return [];
}

function stripSingleAndDoubleQuotedStringContents(source: string): string {
	return source.replace(/(['"])(?:\\[\s\S]|(?!\1)[\s\S])*?\1/gu, '$1$1');
}

export function classifyUnitBoundaryViolation(filePath: string, source: string): string | null {
	if (!isUnitTest(filePath)) {
		return null;
	}
	for (const pattern of unitBoundaryImportPatterns) {
		if (pattern.test(source)) {
			return `${filePath}: unit tests must not cross real process/network boundaries`;
		}
	}
	const sourceWithoutQuotedStringContents = stripSingleAndDoubleQuotedStringContents(source);
	for (const pattern of unitBoundaryCallPatterns) {
		if (pattern.test(sourceWithoutQuotedStringContents)) {
			return `${filePath}: unit tests must not cross real process/network boundaries`;
		}
	}
	return null;
}

export function classifyWallClockWaitViolation(filePath: string, source: string): string | null {
	if (isUnitTest(filePath)) {
		for (const pattern of unitWallClockWaitPatterns) {
			if (pattern.test(source)) {
				return `${filePath}: unit tests must not wait on wall-clock time`;
			}
		}
	}
	if (isIntegrationTest(filePath)) {
		for (const pattern of integrationWallClockWaitPatterns) {
			if (pattern.test(source)) {
				return `${filePath}: integration tests must not wait on wall-clock time`;
			}
		}
	}
	if (isE2eTest(filePath)) {
		for (const pattern of e2eWallClockSleepPatterns) {
			if (pattern.test(source)) {
				return `${filePath}: e2e tests must wait on real process, filesystem, protocol, or VM events instead of wall-clock sleeps`;
			}
		}
	}
	return null;
}

export function classifyTimerPromisesImportViolation(
	filePath: string,
	source: string,
): string | null {
	if (
		(isUnitTest(filePath) || isIntegrationTest(filePath) || isE2eTest(filePath)) &&
		importsTimerPromises(source)
	) {
		return `${filePath}: tests must use named protocol wait helpers instead of importing node:timers/promises directly`;
	}
	return null;
}

function importsTimerPromises(source: string): boolean {
	const sourceFile = ts.createSourceFile(
		'test-taxonomy-source.ts',
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	let found = false;
	const isTimerPromisesSpecifier = (specifier: ts.StringLiteral): boolean =>
		timerPromisesModuleSpecifiers.has(specifier.text);
	const visit = (node: ts.Node): void => {
		if (found) {
			return;
		}
		if (
			ts.isImportDeclaration(node) &&
			ts.isStringLiteral(node.moduleSpecifier) &&
			isTimerPromisesSpecifier(node.moduleSpecifier)
		) {
			found = true;
			return;
		}
		if (
			ts.isExportDeclaration(node) &&
			node.moduleSpecifier !== undefined &&
			ts.isStringLiteral(node.moduleSpecifier) &&
			isTimerPromisesSpecifier(node.moduleSpecifier)
		) {
			found = true;
			return;
		}
		if (
			ts.isImportEqualsDeclaration(node) &&
			ts.isExternalModuleReference(node.moduleReference) &&
			ts.isStringLiteral(node.moduleReference.expression) &&
			isTimerPromisesSpecifier(node.moduleReference.expression)
		) {
			found = true;
			return;
		}
		if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword &&
			node.arguments.length === 1 &&
			ts.isStringLiteral(node.arguments[0]) &&
			isTimerPromisesSpecifier(node.arguments[0])
		) {
			found = true;
			return;
		}
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === 'require' &&
			node.arguments.length === 1 &&
			ts.isStringLiteral(node.arguments[0]) &&
			isTimerPromisesSpecifier(node.arguments[0])
		) {
			found = true;
			return;
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return found;
}

async function collectViolations(): Promise<readonly string[]> {
	const testFiles = await listTrackedTestFiles();
	const fileViolations = await Promise.all(
		testFiles.map(async (filePath): Promise<readonly string[]> => {
			const violations: string[] = [];
			if (!hasAllowedTestSuffix(filePath)) {
				violations.push(
					`${filePath}: test files must use .unit.test.ts, .integration.test.ts, .host.e2e.test.ts, .vm.e2e.test.ts, .hermes.e2e.test.ts, .worker.e2e.test.ts, .secrets.e2e.test.ts, or .llm.e2e.test.ts`,
				);
				return violations;
			}
			const projectNames = resolveTestFileProjectNames(filePath);
			if (projectNames.length === 0) {
				violations.push(`${filePath}: test file is not included by any Vitest project`);
				return violations;
			}
			if (projectNames.length > 1) {
				violations.push(
					`${filePath}: test file is included by multiple Vitest projects: ${projectNames.join(', ')}`,
				);
				return violations;
			}
			const rawSource = await readFile(filePath, 'utf8');
			const boundaryViolation = classifyUnitBoundaryViolation(filePath, rawSource);
			if (boundaryViolation !== null) {
				violations.push(boundaryViolation);
			}
			const timerPromisesImportViolation = classifyTimerPromisesImportViolation(
				filePath,
				rawSource,
			);
			if (timerPromisesImportViolation !== null) {
				violations.push(timerPromisesImportViolation);
			}
			const wallClockViolation = classifyWallClockWaitViolation(
				filePath,
				stripSingleAndDoubleQuotedStringContents(rawSource),
			);
			if (wallClockViolation !== null) {
				violations.push(wallClockViolation);
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
