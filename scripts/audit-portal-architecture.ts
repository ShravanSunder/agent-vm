import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface PortalArchitectureSourceFile {
	readonly filePath: string;
	readonly sourceText: string;
}

export interface CollectPortalArchitectureViolationsProps {
	readonly files: readonly PortalArchitectureSourceFile[];
}

const portalPackageNames = new Set([
	'agent-portal-sdk',
	'controller-execution-contracts',
	'mcp-portal',
	'tool-portal',
]);

const forbiddenBucketFolders = ['schemas', 'validation', 'mapping', 'test-support'] as const;

const runtimePortalImportPrefixes = [
	'@agent-vm/mcp-portal',
	'@agent-vm/tool-portal',
	'@agent-vm/controller-execution-contracts',
	'@agent-vm/agent-vm',
	'@agent-vm/openclaw-agent-vm-plugin',
	'@agent-vm/openclaw-mcp-portal-plugin',
	'@agent-vm/openclaw-gateway',
	'@agent-vm/worker-gateway',
	'@agent-vm/gateway-interface',
	'@agent-vm/gondolin-adapter',
];

const harnessProcessBoundaryImports = new Set(['node:child_process', 'child_process', 'execa']);
const harnessWallClockImports = new Set(['node:timers/promises', 'timers/promises']);

function normalizedFilePath(filePath: string): string {
	return filePath.split(path.sep).join('/');
}

function portalPackageName(filePath: string): string | null {
	const match = /^packages\/([^/]+)\//u.exec(filePath);
	if (match?.[1] === undefined || !portalPackageNames.has(match[1])) {
		return null;
	}
	return match[1];
}

function isPortalSourceFile(filePath: string): boolean {
	return (
		portalPackageName(filePath) !== null && filePath.includes('/src/') && filePath.endsWith('.ts')
	);
}

function sourceFileNameWithoutTestSuffix(filePath: string): string {
	const fileName = path.posix.basename(filePath, '.ts');
	return fileName
		.replace(/\.unit\.test$/u, '')
		.replace(/\.unit\.spec$/u, '')
		.replace(/\.integration\.test$/u, '')
		.replace(/\.host\.e2e\.test$/u, '')
		.replace(/\.vm\.e2e\.test$/u, '')
		.replace(/\.openclaw\.e2e\.test$/u, '')
		.replace(/\.worker\.e2e\.test$/u, '')
		.replace(/\.secrets\.e2e\.test$/u, '')
		.replace(/\.llm\.e2e\.test$/u, '');
}

function isTestSourceFile(filePath: string): boolean {
	return (
		filePath.endsWith('.unit.test.ts') ||
		filePath.endsWith('.unit.spec.ts') ||
		filePath.endsWith('.integration.test.ts') ||
		filePath.endsWith('.host.e2e.test.ts') ||
		filePath.endsWith('.vm.e2e.test.ts') ||
		filePath.endsWith('.openclaw.e2e.test.ts') ||
		filePath.endsWith('.worker.e2e.test.ts') ||
		filePath.endsWith('.secrets.e2e.test.ts') ||
		filePath.endsWith('.llm.e2e.test.ts')
	);
}

function importedModuleSpecifiers(sourceText: string): readonly string[] {
	const specifiers = new Set<string>();
	const importPattern =
		/(?:from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\))/gu;
	for (const match of sourceText.matchAll(importPattern)) {
		const specifier = match[1] ?? match[2] ?? match[3];
		if (specifier !== undefined) {
			specifiers.add(specifier);
		}
	}
	return [...specifiers].toSorted();
}

function collectStructureViolations(filePath: string): readonly string[] {
	if (!isPortalSourceFile(filePath)) {
		return [];
	}
	const violations: string[] = [];
	for (const folderName of forbiddenBucketFolders) {
		if (filePath.includes(`/src/${folderName}/`)) {
			violations.push(`${filePath}: new portal work must not use src/${folderName}`);
		}
	}
	if (/\/src\/models\//u.test(filePath)) {
		violations.push(`${filePath}: new portal work must not use package-wide src/models`);
	}
	const fileName = sourceFileNameWithoutTestSuffix(filePath);
	if (fileName !== 'index' && !fileName.includes('-')) {
		violations.push(`${filePath}: new portal files must use descriptive multi-word names`);
	}
	return violations;
}

function importStartsWithAny(specifier: string, prefixes: readonly string[]): boolean {
	return prefixes.some((prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`));
}

function collectDependencyViolations(file: PortalArchitectureSourceFile): readonly string[] {
	const filePath = normalizedFilePath(file.filePath);
	if (isTestSourceFile(filePath)) {
		return [];
	}
	const packageName = portalPackageName(filePath);
	if (packageName === null) {
		return [];
	}
	const imports = importedModuleSpecifiers(file.sourceText);
	const violations: string[] = [];
	if (
		packageName === 'agent-portal-sdk' &&
		imports.some((specifier) => importStartsWithAny(specifier, runtimePortalImportPrefixes))
	) {
		violations.push(`${filePath}: agent-portal-sdk must not import runtime portal packages`);
	}
	if (
		packageName === 'controller-execution-contracts' &&
		imports.some((specifier) => importStartsWithAny(specifier, runtimePortalImportPrefixes))
	) {
		violations.push(
			`${filePath}: controller-execution-contracts must not import runtime portal packages`,
		);
	}
	if (
		packageName === 'tool-portal' &&
		imports.some(
			(specifier) =>
				importStartsWithAny(specifier, ['@agent-vm/mcp-portal']) &&
				specifier !== '@agent-vm/mcp-portal/mcp-provider-backend',
		)
	) {
		violations.push(
			`${filePath}: Tool Portal may import only @agent-vm/mcp-portal/mcp-provider-backend from MCP Portal`,
		);
	}
	if (
		packageName === 'mcp-portal' &&
		imports.some((specifier) =>
			importStartsWithAny(specifier, [
				'@agent-vm/tool-portal',
				'@agent-vm/controller-execution-contracts',
			]),
		)
	) {
		violations.push(
			`${filePath}: MCP Portal must not import Tool Portal or controller execution contracts`,
		);
	}
	return violations;
}

function collectHarnessViolations(file: PortalArchitectureSourceFile): readonly string[] {
	const filePath = normalizedFilePath(file.filePath);
	if (!filePath.startsWith('tests/harness/agent-portal/') || !filePath.endsWith('.ts')) {
		return [];
	}
	const imports = importedModuleSpecifiers(file.sourceText);
	const violations: string[] = [];
	if (imports.some((specifier) => harnessWallClockImports.has(specifier))) {
		violations.push(
			`${filePath}: shared agent portal harnesses must not import wall-clock timer helpers`,
		);
	}
	if (imports.some((specifier) => harnessProcessBoundaryImports.has(specifier))) {
		violations.push(
			`${filePath}: shared agent portal harnesses must not import process boundary helpers`,
		);
	}
	return violations;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exportImportPathFromValue(value: unknown): string | null {
	if (typeof value === 'string') {
		return value;
	}
	if (isRecord(value) && typeof value.import === 'string') {
		return value.import;
	}
	return null;
}

function sourceEntryForDistImport(importPath: string): string | null {
	if (!importPath.startsWith('./dist/') || !importPath.endsWith('.js')) {
		return null;
	}
	return `src/${importPath.slice('./dist/'.length, -'.js'.length)}.ts`;
}

function collectExportEntryViolations(
	files: readonly PortalArchitectureSourceFile[],
): readonly string[] {
	const filesByPath = new Map(files.map((file) => [normalizedFilePath(file.filePath), file]));
	const violations: string[] = [];
	for (const file of files) {
		const filePath = normalizedFilePath(file.filePath);
		const packageName = portalPackageName(filePath);
		if (packageName === null || !filePath.endsWith('/package.json')) {
			continue;
		}
		let parsedPackageJson: unknown;
		try {
			parsedPackageJson = JSON.parse(file.sourceText);
		} catch {
			continue;
		}
		if (!isRecord(parsedPackageJson) || !isRecord(parsedPackageJson.exports)) {
			continue;
		}
		const packageRoot = `packages/${packageName}`;
		const tsdownConfig = filesByPath.get(`${packageRoot}/tsdown.config.ts`);
		if (tsdownConfig === undefined) {
			continue;
		}
		for (const [exportName, exportValue] of Object.entries(parsedPackageJson.exports)) {
			const importPath = exportImportPathFromValue(exportValue);
			if (importPath === null) {
				continue;
			}
			const expectedSourceEntry = sourceEntryForDistImport(importPath);
			if (expectedSourceEntry === null || tsdownConfig.sourceText.includes(expectedSourceEntry)) {
				continue;
			}
			const importPathLabel = importPath.startsWith('./') ? importPath.slice(2) : importPath;
			violations.push(
				`${filePath}: export ${exportName} points at ${importPathLabel} but ${packageRoot}/tsdown.config.ts does not include ${expectedSourceEntry}`,
			);
		}
	}
	return violations;
}

export function collectPortalArchitectureViolations(
	props: CollectPortalArchitectureViolationsProps,
): readonly string[] {
	return [
		...props.files.flatMap((file) => collectStructureViolations(normalizedFilePath(file.filePath))),
		...props.files.flatMap(collectDependencyViolations),
		...props.files.flatMap(collectHarnessViolations),
		...collectExportEntryViolations(props.files),
	].toSorted();
}

async function collectFilesUnderDirectory(directoryPath: string): Promise<readonly string[]> {
	const entries = await readdir(directoryPath, { withFileTypes: true });
	const files = await Promise.all(
		entries.map(async (entry): Promise<readonly string[]> => {
			const entryPath = path.join(directoryPath, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === 'node_modules' || entry.name === 'dist') {
					return [];
				}
				return await collectFilesUnderDirectory(entryPath);
			}
			if (
				entry.isFile() &&
				(entry.name.endsWith('.ts') ||
					entry.name === 'package.json' ||
					entry.name === 'tsdown.config.ts')
			) {
				return [entryPath];
			}
			return [];
		}),
	);
	return files.flat();
}

async function loadRepositorySourceFiles(
	repositoryRoot: string,
): Promise<readonly PortalArchitectureSourceFile[]> {
	const sourceRoots = ['packages', 'scripts', 'tests/harness/agent-portal'];
	const files: PortalArchitectureSourceFile[] = [];
	for (const sourceRoot of sourceRoots) {
		const sourceRootPath = path.join(repositoryRoot, sourceRoot);
		try {
			const filePaths = await collectFilesUnderDirectory(sourceRootPath);
			for (const filePath of filePaths) {
				files.push({
					filePath: normalizedFilePath(path.relative(repositoryRoot, filePath)),
					sourceText: await readFile(filePath, 'utf8'),
				});
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw error;
			}
		}
	}
	return files;
}

async function main(): Promise<void> {
	const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
	const violations = collectPortalArchitectureViolations({
		files: await loadRepositorySourceFiles(repositoryRoot),
	});
	if (violations.length === 0) {
		process.stdout.write('portal architecture audit: passed\n');
		return;
	}
	for (const violation of violations) {
		process.stderr.write(`${violation}\n`);
	}
	process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	await main();
}
