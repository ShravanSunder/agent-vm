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
	'control-protocol-contracts',
	'controller-execution-contracts',
	'gateway-control-contracts',
	'mcp-portal',
	'tool-portal',
	'worker-control-contracts',
]);

const controlContractPackageNames = new Set([
	'control-protocol-contracts',
	'gateway-control-contracts',
	'worker-control-contracts',
]);

const forbiddenBucketFolders = ['schemas', 'validation', 'mapping', 'test-support'] as const;

const runtimePortalImportPrefixes = [
	'@agent-vm/mcp-portal',
	'@agent-vm/tool-portal',
	'@agent-vm/control-protocol-contracts',
	'@agent-vm/controller-execution-contracts',
	'@agent-vm/gateway-control-contracts',
	'@agent-vm/worker-control-contracts',
	'@agent-vm/agent-vm',
	'@agent-vm/openclaw-agent-vm-plugin',
	'@agent-vm/openclaw-gateway',
	'@agent-vm/worker-gateway',
	'@agent-vm/gateway-lifecycle',
	'@agent-vm/gondolin-vm-adapter',
	'@agent-vm/managed-vm',
];

const harnessProcessBoundaryImports = new Set(['node:child_process', 'child_process', 'execa']);
const harnessWallClockImports = new Set(['node:timers/promises', 'timers/promises']);

const managedControlSourcePrefixes = [
	'packages/agent-vm/src/controller/',
	'packages/agent-vm-worker/src/',
	'packages/openclaw-agent-vm-plugin/src/',
	'packages/openclaw-gateway/src/',
	'packages/worker-gateway/src/',
] as const;

const managedControlDocumentationPrefixes = [
	'docs/architecture/',
	'docs/getting-started/',
	'docs/reference/',
	'docs/subsystems/',
] as const;

const managedControlResiduePatterns = [
	{
		label: 'controller.vm.host:18800',
		pattern: 'controller.vm.host:18800',
	},
	{
		label: 'CONTROLLER_BASE_URL',
		pattern: 'CONTROLLER_BASE_URL',
	},
	{
		label: 'gateway-control-link',
		pattern: 'gateway-control-link',
	},
	{
		label: 'controller-lease-client',
		pattern: 'controller-lease-client',
	},
	{
		label: 'websocketBypass',
		pattern: 'websocketBypass',
	},
] as const;

const managedControlDocumentationResiduePatterns = [
	...managedControlResiduePatterns,
	{
		label: 'push-branches',
		message:
			'managed control-plane cutover docs must not teach push-branches API as a current Worker control path',
		pattern: 'push-branches',
	},
	{
		label: 'controller lease request',
		message:
			'managed control-plane cutover docs must not teach controller lease request as a current VM-facing control path',
		pattern: 'controller lease request',
	},
	{
		label: 'controller lease API',
		message:
			'managed control-plane cutover docs must not teach controller lease API as a current VM-facing control path',
		pattern: 'controller lease API',
	},
	{
		label: 'GET lease',
		message:
			'managed control-plane cutover docs must not teach GET lease as a current VM-facing control path',
		pattern: 'GET lease',
	},
	{
		label: 'POST renew',
		message:
			'managed control-plane cutover docs must not teach POST renew as a current VM-facing control path',
		pattern: 'POST renew',
	},
] as const;

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

function sortedStrings(values: Iterable<string>): readonly string[] {
	const sortedValues = Array.from(values);
	// oxlint-disable-next-line unicorn/no-array-sort -- this helper sorts a fresh local array; type-aware lint treats toSorted as an error type here.
	return sortedValues.sort((leftValue, rightValue) => leftValue.localeCompare(rightValue));
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
	return sortedStrings(specifiers);
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
	const imports = importedModuleSpecifiers(file.sourceText);
	if (filePath.startsWith('packages/openclaw-agent-vm-plugin/src/')) {
		const violations: string[] = [];
		if (imports.some((specifier) => importStartsWithAny(specifier, ['@agent-vm/mcp-portal']))) {
			violations.push(
				`${filePath}: OpenClaw plugin must consume MCP providers through Tool Portal, not import MCP Portal directly`,
			);
		}
		return violations;
	}
	const packageName = portalPackageName(filePath);
	if (packageName === null) {
		return [];
	}
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
		imports.some((specifier) => importStartsWithAny(specifier, ['@agent-vm/mcp-portal/core']))
	) {
		violations.push(
			`${filePath}: Tool Portal must consume MCP Portal through @agent-vm/mcp-portal/mcp-provider-backend, not core internals`,
		);
	}
	if (controlContractPackageNames.has(packageName)) {
		const allowedContractImports =
			packageName === 'control-protocol-contracts' ? [] : ['@agent-vm/control-protocol-contracts'];
		const forbiddenImports = imports.filter(
			(specifier) =>
				importStartsWithAny(specifier, runtimePortalImportPrefixes) &&
				!importStartsWithAny(specifier, allowedContractImports),
		);
		for (const forbiddenImport of forbiddenImports) {
			violations.push(
				`${filePath}: ${packageName} must not import runtime portal packages (${forbiddenImport})`,
			);
		}
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

function hasErrorCode(value: unknown, code: string): boolean {
	return isRecord(value) && value.code === code;
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

function collectOpenClawPluginToolSurfaceViolations(
	file: PortalArchitectureSourceFile,
): readonly string[] {
	const filePath = normalizedFilePath(file.filePath);
	if (filePath === 'packages/openclaw-agent-vm-plugin/openclaw.plugin.json') {
		let parsedManifest: unknown;
		try {
			parsedManifest = JSON.parse(file.sourceText);
		} catch {
			return [];
		}
		if (
			isRecord(parsedManifest) &&
			isRecord(parsedManifest.contracts) &&
			Array.isArray(parsedManifest.contracts.tools) &&
			parsedManifest.contracts.tools.includes('zone_git_push')
		) {
			return [
				`${filePath}: managed OpenClaw must not expose zone_git_push as a direct plugin tool`,
			];
		}
		return [];
	}
	if (filePath === 'packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.ts') {
		const directZoneGitRegistration =
			file.sourceText.includes('registerZoneGitTool') ||
			(/registerTool\s*\(/u.test(file.sourceText) &&
				file.sourceText.includes("name: 'zone_git_push'"));
		if (directZoneGitRegistration) {
			return [
				`${filePath}: managed OpenClaw must not register zone_git_push as a direct model-visible tool`,
			];
		}
	}
	return [];
}

function collectManagedControlResidueViolations(
	file: PortalArchitectureSourceFile,
): readonly string[] {
	const filePath = normalizedFilePath(file.filePath);
	if (isTestSourceFile(filePath)) {
		return [];
	}
	const isManagedSource =
		filePath.endsWith('.ts') &&
		managedControlSourcePrefixes.some((prefix) => filePath.startsWith(prefix));
	const isShippableDocs =
		filePath.endsWith('.md') &&
		managedControlDocumentationPrefixes.some((prefix) => filePath.startsWith(prefix));
	const isManualTemplate = filePath === 'packages/agent-vm/src/cli/manual-templates.ts';
	const isShippedOpenClawPluginMetadata =
		filePath === 'packages/openclaw-agent-vm-plugin/openclaw.plugin.json';
	if (
		!isManagedSource &&
		!isShippableDocs &&
		!isManualTemplate &&
		!isShippedOpenClawPluginMetadata
	) {
		return [];
	}
	const residuePatterns =
		isShippableDocs || isManualTemplate || isShippedOpenClawPluginMetadata
			? managedControlDocumentationResiduePatterns
			: managedControlResiduePatterns;
	const violations: string[] = [];
	for (const residue of residuePatterns) {
		if (file.sourceText.includes(residue.pattern)) {
			violations.push(
				'message' in residue
					? `${filePath}: ${residue.message}`
					: `${filePath}: managed control-plane cutover must not use ${residue.label}`,
			);
		}
	}
	return violations;
}

function collectGatewayLifecyclePublicRawControlViolations(
	file: PortalArchitectureSourceFile,
): readonly string[] {
	const filePath = normalizedFilePath(file.filePath);
	if (filePath !== 'packages/gateway-lifecycle/src/index.ts') {
		return [];
	}
	const violations: string[] = [];
	for (const exportedName of [
		'fetchControllerWithPolicy',
		'gatewayInternalControllerRequestOperations',
		'FetchControllerWithPolicyOptions',
		'GatewayInternalControllerRequestOperation',
	]) {
		if (file.sourceText.includes(exportedName)) {
			violations.push(
				`${filePath}: gateway-lifecycle must not publicly export raw controller helper ${exportedName}`,
			);
		}
	}
	return violations;
}

export function collectPortalArchitectureViolations(
	props: CollectPortalArchitectureViolationsProps,
): readonly string[] {
	const violations = [
		...props.files.flatMap((file) => collectStructureViolations(normalizedFilePath(file.filePath))),
		...props.files.flatMap(collectDependencyViolations),
		...props.files.flatMap(collectHarnessViolations),
		...collectExportEntryViolations(props.files),
		...props.files.flatMap(collectOpenClawPluginToolSurfaceViolations),
		...props.files.flatMap(collectManagedControlResidueViolations),
		...props.files.flatMap(collectGatewayLifecyclePublicRawControlViolations),
	];
	return sortedStrings(violations);
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
					entry.name.endsWith('.md') ||
					entry.name === 'package.json' ||
					entry.name === 'openclaw.plugin.json' ||
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
	const sourceRoots = [
		'docs/architecture',
		'docs/getting-started',
		'docs/reference',
		'docs/subsystems',
		'packages',
		'scripts',
		'tests/harness/agent-portal',
	];
	const filesByRoot = await Promise.all(
		sourceRoots.map(async (sourceRoot): Promise<readonly PortalArchitectureSourceFile[]> => {
			const sourceRootPath = path.join(repositoryRoot, sourceRoot);
			try {
				const filePaths = await collectFilesUnderDirectory(sourceRootPath);
				return await Promise.all(
					filePaths.map(
						async (filePath): Promise<PortalArchitectureSourceFile> => ({
							filePath: normalizedFilePath(path.relative(repositoryRoot, filePath)),
							sourceText: await readFile(filePath, 'utf8'),
						}),
					),
				);
			} catch (error) {
				if (!hasErrorCode(error, 'ENOENT')) {
					throw error;
				}
				return [];
			}
		}),
	);
	return filesByRoot.flat();
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
