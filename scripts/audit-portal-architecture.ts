import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import ts from 'typescript';

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
	'gateway-runtime',
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
	'@agent-vm/worker-gateway',
	'@agent-vm/gateway-lifecycle',
	'@agent-vm/gondolin-vm-adapter',
	'@agent-vm/managed-vm',
];

const harnessProcessBoundaryImports = new Set(['node:child_process', 'child_process', 'execa']);
const harnessWallClockImports = new Set(['node:timers/promises', 'timers/promises']);

const gatewayRuntimeForbiddenVmImportPrefixes = [
	'@agent-vm/gondolin-vm-adapter',
	'@agent-vm/managed-vm',
	'@gondolin',
] as const;

const managedToolPortalAuthoredConfigOwnerFiles = new Set([
	'packages/agent-vm/src/cli/init-command.ts',
	'packages/agent-vm/src/gateway/mcp-portal-effective-config.ts',
	'packages/agent-vm/src/operations/config-validation.ts',
	'packages/agent-vm/src/operations/mcp-portal-live-validation.ts',
]);

const gatewayRuntimeToolPortalServiceCustodyOwnerFile =
	'packages/gateway-runtime/src/managed-tool-portal-composition.ts';

const retiredToolPortalInProcessRuntimeNames = [
	'createManagedToolPortalInProcessRuntime',
	'createToolPortalInProcessEntryPoint',
] as const;

const toolPortalSemanticRouterHelperNames = [
	'mergePortalDescribe',
	'mergePortalList',
	'mergePortalSearch',
	'mergeToolPortalDescribe',
	'mergeToolPortalList',
	'mergeToolPortalSearch',
	'routePortalCall',
	'routeToolPortalCall',
] as const;

const managedControlSourcePrefixes = [
	'packages/agent-vm/src/controller/',
	'packages/agent-vm-worker/src/',
	'packages/gateway-runtime/src/',
	'packages/hermes-gateway/src/',
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
		.replace(/\.hermes\.e2e\.test$/u, '')
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
		filePath.endsWith('.hermes.e2e.test.ts') ||
		filePath.endsWith('.worker.e2e.test.ts') ||
		filePath.endsWith('.secrets.e2e.test.ts') ||
		filePath.endsWith('.llm.e2e.test.ts') ||
		filePath.endsWith('-test-fixture.ts')
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

function collectAgentPortalSdkGatewayRuntimeImportViolations(
	file: PortalArchitectureSourceFile,
): readonly string[] {
	const filePath = normalizedFilePath(file.filePath);
	if (
		isTestSourceFile(filePath) ||
		!filePath.startsWith('packages/agent-portal-sdk/src/') ||
		!filePath.endsWith('.ts')
	) {
		return [];
	}
	return importedModuleSpecifiers(file.sourceText)
		.filter((specifier) => importStartsWithAny(specifier, ['@agent-vm/gateway-runtime']))
		.map(
			(specifier) => `${filePath}: Agent Portal SDK must not import Gateway runtime (${specifier})`,
		);
}

function collectAgentPortalSdkPackageDependencyViolations(
	file: PortalArchitectureSourceFile,
): readonly string[] {
	const filePath = normalizedFilePath(file.filePath);
	if (filePath !== 'packages/agent-portal-sdk/package.json') {
		return [];
	}
	let parsedPackageJson: unknown;
	try {
		parsedPackageJson = JSON.parse(file.sourceText);
	} catch {
		return [];
	}
	if (!isRecord(parsedPackageJson)) {
		return [];
	}
	const violations: string[] = [];
	for (const dependencyField of ['dependencies', 'devDependencies'] as const) {
		const dependencies = parsedPackageJson[dependencyField];
		if (isRecord(dependencies) && Object.hasOwn(dependencies, '@agent-vm/gateway-runtime')) {
			violations.push(
				`${filePath}: Agent Portal SDK must not declare @agent-vm/gateway-runtime in ${dependencyField}`,
			);
		}
	}
	return violations;
}

function moduleSpecifierText(moduleSpecifier: ts.Expression | undefined): string | null {
	return moduleSpecifier !== undefined && ts.isStringLiteralLike(moduleSpecifier)
		? moduleSpecifier.text
		: null;
}

function hasExportModifier(node: ts.Node): boolean {
	return (
		ts.canHaveModifiers(node) &&
		(ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ??
			false)
	);
}

function hasToolPortalServiceFactoryCustody(file: PortalArchitectureSourceFile): boolean {
	const sourceFile = ts.createSourceFile(
		file.filePath,
		file.sourceText,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const toolPortalNamespaceImports = new Set<string>();
	let hasCustody = false;

	for (const statement of sourceFile.statements) {
		if (ts.isImportDeclaration(statement)) {
			const importClause = statement.importClause;
			if (importClause?.name?.text === 'createToolPortalService') {
				hasCustody = true;
			}
			const namedBindings = importClause?.namedBindings;
			if (namedBindings !== undefined && ts.isNamedImports(namedBindings)) {
				hasCustody ||= namedBindings.elements.some(
					(importSpecifier) =>
						(importSpecifier.propertyName ?? importSpecifier.name).text ===
						'createToolPortalService',
				);
			}
			const importedModuleSpecifier = moduleSpecifierText(statement.moduleSpecifier);
			if (
				namedBindings !== undefined &&
				ts.isNamespaceImport(namedBindings) &&
				importedModuleSpecifier !== null &&
				importStartsWithAny(importedModuleSpecifier, ['@agent-vm/tool-portal'])
			) {
				toolPortalNamespaceImports.add(namedBindings.name.text);
			}
		}
		if (ts.isExportDeclaration(statement)) {
			const exportedModuleSpecifier = moduleSpecifierText(statement.moduleSpecifier);
			if (
				exportedModuleSpecifier !== null &&
				importStartsWithAny(exportedModuleSpecifier, ['@agent-vm/tool-portal']) &&
				(statement.exportClause === undefined || ts.isNamespaceExport(statement.exportClause))
			) {
				hasCustody = true;
			}
			if (statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
				hasCustody ||= statement.exportClause.elements.some(
					(exportSpecifier) =>
						(exportSpecifier.propertyName ?? exportSpecifier.name).text ===
						'createToolPortalService',
				);
			}
		}
	}

	function visitNode(node: ts.Node): void {
		if (hasCustody) {
			return;
		}
		if (ts.isCallExpression(node)) {
			if (ts.isIdentifier(node.expression) && node.expression.text === 'createToolPortalService') {
				hasCustody = true;
				return;
			}
			if (
				ts.isPropertyAccessExpression(node.expression) &&
				ts.isIdentifier(node.expression.expression) &&
				toolPortalNamespaceImports.has(node.expression.expression.text) &&
				node.expression.name.text === 'createToolPortalService'
			) {
				hasCustody = true;
				return;
			}
		}
		if (
			ts.isExportAssignment(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === 'createToolPortalService'
		) {
			hasCustody = true;
			return;
		}
		if (
			hasExportModifier(node) &&
			(ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
			node.name?.text === 'createToolPortalService'
		) {
			hasCustody = true;
			return;
		}
		if (
			hasExportModifier(node) &&
			ts.isVariableStatement(node) &&
			node.declarationList.declarations.some(
				(declaration) =>
					ts.isIdentifier(declaration.name) && declaration.name.text === 'createToolPortalService',
			)
		) {
			hasCustody = true;
			return;
		}
		ts.forEachChild(node, visitNode);
	}

	visitNode(sourceFile);
	return hasCustody;
}

function collectToolPortalServiceCustodyViolations(
	file: PortalArchitectureSourceFile,
): readonly string[] {
	const filePath = normalizedFilePath(file.filePath);
	if (
		isTestSourceFile(filePath) ||
		!filePath.startsWith('packages/') ||
		!filePath.includes('/src/') ||
		!filePath.endsWith('.ts') ||
		filePath === 'packages/tool-portal/src/tool-portal-service.ts' ||
		!file.sourceText.includes('createToolPortalService')
	) {
		return [];
	}
	if (filePath.startsWith('packages/gateway-runtime/src/')) {
		if (
			filePath === gatewayRuntimeToolPortalServiceCustodyOwnerFile ||
			!hasToolPortalServiceFactoryCustody(file)
		) {
			return [];
		}
		return [
			`${filePath}: only ${gatewayRuntimeToolPortalServiceCustodyOwnerFile} may import, construct, or export createToolPortalService`,
		];
	}
	return [`${filePath}: only Gateway runtime may construct ToolPortalService`];
}

function collectGatewayRuntimeVmImportViolations(
	file: PortalArchitectureSourceFile,
): readonly string[] {
	const filePath = normalizedFilePath(file.filePath);
	if (
		isTestSourceFile(filePath) ||
		!filePath.startsWith('packages/gateway-runtime/src/') ||
		!filePath.endsWith('.ts')
	) {
		return [];
	}
	return importedModuleSpecifiers(file.sourceText)
		.filter((specifier) => importStartsWithAny(specifier, gatewayRuntimeForbiddenVmImportPrefixes))
		.map(
			(specifier) =>
				`${filePath}: Gateway runtime must not import managed VM or Gondolin packages (${specifier})`,
		);
}

function collectManagedToolPortalConfigOwnershipViolations(
	file: PortalArchitectureSourceFile,
): readonly string[] {
	const filePath = normalizedFilePath(file.filePath);
	if (
		!managedToolPortalAuthoredConfigOwnerFiles.has(filePath) ||
		!file.sourceText.includes('mcp-portal.config.jsonc')
	) {
		return [];
	}
	return [
		`${filePath}: managed Tool Portal paths must not consume or scaffold standalone mcp-portal.config.jsonc`,
	];
}

function collectRetiredToolPortalInProcessRuntimeViolations(
	file: PortalArchitectureSourceFile,
): readonly string[] {
	const filePath = normalizedFilePath(file.filePath);
	if (filePath.startsWith('packages/tool-portal/src/in-process-entrypoint/')) {
		return [`${filePath}: retired in-process Tool Portal runtime source and tests must not return`];
	}
	if (filePath === 'packages/tool-portal/package.json') {
		let parsedPackageJson: unknown;
		try {
			parsedPackageJson = JSON.parse(file.sourceText);
		} catch {
			return [];
		}
		return isRecord(parsedPackageJson) &&
			isRecord(parsedPackageJson.exports) &&
			Object.hasOwn(parsedPackageJson.exports, './in-process-entrypoint')
			? [`${filePath}: Tool Portal must not publish the retired ./in-process-entrypoint subpath`]
			: [];
	}
	if (
		filePath === 'packages/tool-portal/src/index.ts' &&
		(file.sourceText.includes('in-process-entrypoint') ||
			retiredToolPortalInProcessRuntimeNames.some((name) => file.sourceText.includes(name)))
	) {
		return [`${filePath}: Tool Portal root must not export the retired in-process runtime`];
	}
	if (
		filePath === 'packages/tool-portal/tsdown.config.ts' &&
		file.sourceText.includes('in-process-entrypoint')
	) {
		return [`${filePath}: Tool Portal must not build the retired in-process runtime entrypoint`];
	}
	if (
		filePath.startsWith('packages/tool-portal/src/') &&
		!isTestSourceFile(filePath) &&
		retiredToolPortalInProcessRuntimeNames.some((name) => file.sourceText.includes(name))
	) {
		return [`${filePath}: Tool Portal must not restore retired in-process runtime declarations`];
	}
	return [];
}

function declaresNamedFunctionOrVariable(sourceText: string, name: string): boolean {
	const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
	return new RegExp(`(?:function\\s+|(?:const|let|var)\\s+)${escapedName}\\b`, 'u').test(
		sourceText,
	);
}

function collectToolPortalSemanticRouterViolations(
	file: PortalArchitectureSourceFile,
): readonly string[] {
	const filePath = normalizedFilePath(file.filePath);
	if (
		isTestSourceFile(filePath) ||
		!filePath.startsWith('packages/') ||
		!filePath.includes('/src/') ||
		!filePath.endsWith('.ts') ||
		filePath === 'packages/tool-portal/src/tool-portal-result-router.ts'
	) {
		return [];
	}
	return toolPortalSemanticRouterHelperNames
		.filter((helperName) => declaresNamedFunctionOrVariable(file.sourceText, helperName))
		.map(
			(helperName) =>
				`${filePath}: Tool Portal semantic router helper ${helperName} must be declared only in packages/tool-portal/src/tool-portal-result-router.ts`,
		);
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

function collectPortalPackageOutputViolations(
	file: PortalArchitectureSourceFile,
): readonly string[] {
	const filePath = normalizedFilePath(file.filePath);
	if (filePath === 'packages/agent-portal-sdk/tsdown.config.ts') {
		return /\bhash\s*:\s*false\b/u.test(file.sourceText)
			? [
					`${filePath}: Agent Portal SDK must retain content-hashed internal chunks so multi-entry declaration names cannot collide`,
				]
			: [];
	}
	const packageLabelByConfigPath: Readonly<Record<string, string>> = {
		'packages/gateway-runtime/tsdown.config.ts': 'Gateway runtime',
		'packages/tool-portal/tsdown.config.ts': 'Tool Portal',
	};
	const packageLabel = packageLabelByConfigPath[filePath];
	if (packageLabel === undefined) {
		return [];
	}
	if (/\bhash\s*:\s*false\b/u.test(file.sourceText)) {
		return [];
	}
	return [
		`${filePath}: ${packageLabel} builds must disable hashed chunk names so frozen declaration filenames stay stable`,
	];
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
	if (!isManagedSource && !isShippableDocs && !isManualTemplate) {
		return [];
	}
	const residuePatterns =
		isShippableDocs || isManualTemplate
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

function collectManagedFrameworkChildTopologyViolations(
	file: PortalArchitectureSourceFile,
): readonly string[] {
	const filePath = normalizedFilePath(file.filePath);
	if (
		filePath === 'packages/gateway-runtime/src/runtime/managed-framework-child-supervisor.ts' ||
		filePath ===
			'packages/gateway-runtime/src/runtime/managed-framework-child-supervisor.unit.test.ts'
	) {
		return [
			`${filePath}: Gateway runtime must not own or test a managed framework child supervisor`,
		];
	}
	if (isTestSourceFile(filePath)) {
		return [];
	}
	if (
		filePath.startsWith('packages/gateway-runtime/src/') &&
		(file.sourceText.includes('ManagedFrameworkChild') ||
			file.sourceText.includes('managed-framework-child-supervisor'))
	) {
		return [
			`${filePath}: Gateway runtime must not expose managed framework child declarations or exports`,
		];
	}
	if (
		filePath.startsWith('packages/gateway-lifecycle/src/') &&
		(file.sourceText.includes('ManagedFrameworkChildRecipe') ||
			file.sourceText.includes("'managed-framework-runtime'") ||
			file.sourceText.includes('childRecipe'))
	) {
		return [
			`${filePath}: Gateway lifecycle must not declare a framework child recipe or runtime-parent variant`,
		];
	}
	if (filePath === 'packages/gateway-runtime/package.json') {
		const violations: string[] = [];
		try {
			const parsedManifest: unknown = JSON.parse(file.sourceText);
			if (
				isRecord(parsedManifest) &&
				isRecord(parsedManifest.dependencies) &&
				Object.hasOwn(parsedManifest.dependencies, '@agent-vm/gateway-lifecycle')
			) {
				violations.push(
					`${filePath}: Gateway runtime must not depend on gateway-lifecycle for framework child ownership`,
				);
			}
		} catch {
			return [];
		}
		if (file.sourceText.includes('managed-framework runtime')) {
			violations.push(
				`${filePath}: Gateway runtime package metadata must not describe framework child ownership`,
			);
		}
		return violations;
	}
	if (
		filePath === 'packages/gateway-lifecycle/package.json' &&
		file.sourceText.includes('runtime-contracts')
	) {
		return [
			`${filePath}: Gateway lifecycle must not publish the rejected child runtime-contracts entry`,
		];
	}
	if (
		filePath === 'packages/gateway-lifecycle/tsdown.config.ts' &&
		file.sourceText.includes('runtime-contracts')
	) {
		return [
			`${filePath}: Gateway lifecycle must not build the rejected child runtime-contracts entry`,
		];
	}
	return [];
}

export function collectPortalArchitectureViolations(
	props: CollectPortalArchitectureViolationsProps,
): readonly string[] {
	const violations = [
		...props.files.flatMap((file) => collectStructureViolations(normalizedFilePath(file.filePath))),
		...props.files.flatMap(collectDependencyViolations),
		...props.files.flatMap(collectAgentPortalSdkGatewayRuntimeImportViolations),
		...props.files.flatMap(collectAgentPortalSdkPackageDependencyViolations),
		...props.files.flatMap(collectToolPortalServiceCustodyViolations),
		...props.files.flatMap(collectGatewayRuntimeVmImportViolations),
		...props.files.flatMap(collectManagedToolPortalConfigOwnershipViolations),
		...props.files.flatMap(collectRetiredToolPortalInProcessRuntimeViolations),
		...props.files.flatMap(collectToolPortalSemanticRouterViolations),
		...props.files.flatMap(collectHarnessViolations),
		...collectExportEntryViolations(props.files),
		...props.files.flatMap(collectPortalPackageOutputViolations),
		...props.files.flatMap(collectManagedControlResidueViolations),
		...props.files.flatMap(collectGatewayLifecyclePublicRawControlViolations),
		...props.files.flatMap(collectManagedFrameworkChildTopologyViolations),
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
	const files = await loadRepositorySourceFiles(repositoryRoot);
	const managedFrameworkChildTopologyOnly = process.argv.includes(
		'--managed-framework-child-topology',
	);
	const violations = managedFrameworkChildTopologyOnly
		? sortedStrings(files.flatMap(collectManagedFrameworkChildTopologyViolations))
		: collectPortalArchitectureViolations({ files });
	if (violations.length === 0) {
		process.stdout.write(
			managedFrameworkChildTopologyOnly
				? 'managed framework child topology audit: passed\n'
				: 'portal architecture audit: passed\n',
		);
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
