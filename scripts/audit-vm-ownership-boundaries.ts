import { readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as ts from 'typescript';

export interface VmOwnershipBoundaryAuditSource {
	readonly content: string;
	readonly filePath: string;
}

export interface VmOwnershipBoundaryAuditFinding {
	readonly filePath: string;
	readonly line: number;
	readonly reason: string;
}

const AUDIT_SOURCE_ROOTS = ['packages/agent-vm/src', 'packages/gondolin-adapter/src'] as const;
const STOCK_GONDOLIN_PACKAGE_NAME = '@earendil-works/gondolin';
const STOCK_GONDOLIN_VERSION = '0.12.0';
const STOCK_GONDOLIN_REPOSITORY_METADATA_PATHS = [
	'package.json',
	'pnpm-lock.yaml',
	'pnpm-workspace.yaml',
	'packages/gondolin-adapter/package.json',
] as const;

const LEASE_MANAGER_FILE_PATH = 'packages/agent-vm/src/controller/leases/lease-manager.ts';
const LEGACY_LEASE_MANAGER_AUTHORITY_STORE_NAMES = new Set([
	'activeUses',
	'currentLeaseRegistry',
	'endedUseTombstones',
	'releasingLeaseIds',
]);
const LEGACY_CURRENT_LEASE_REGISTRY_MODULE = './tool-vm-current-lease-registry.js';
const LEGACY_CURRENT_LEASE_REGISTRY_FACTORY = 'createToolVmCurrentLeaseRegistry';

const CONTROLLER_MANAGED_TERMINATION_FILE_PATH =
	'packages/agent-vm/src/shared/controller-managed-vm-termination.ts';
const TOOL_VM_LIFECYCLE_FILE_PATH = 'packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts';
const DELETED_VM_LIFECYCLE_MODULES = new Set([
	'exact-vm-lifecycle.js',
	'vm-creation-ownership.js',
	'vm-destruction-receipt.js',
]);

function isDeletedVmLifecycleSymbol(symbolName: string): boolean {
	return (
		DELETED_VM_LIFECYCLE_SYMBOLS.has(symbolName) ||
		/^(?:Managed)?Vm.*(?:DestroyReceipt|DestroyTarget|OwnershipReservation)/u.test(symbolName)
	);
}
const DELETED_VM_LIFECYCLE_SYMBOLS = new Set([
	'VmCreationOwnership',
	'VmDestroyReceiptV1',
	'VmDestroyTargetV1',
	'assertVmDestructionComplete',
	'cleanupOrphanedGatewayIfPresent',
	'cleanupOrphanedToolVmsIfPresent',
	'destroyDetached',
	'GatewayOrphanCleanupOptions',
	'getDestroyTarget',
	'killOrphanedGatewayProcess',
	'killOrphanedManagedVmProcess',
	'killOrphanedToolVmProcess',
	'ownershipReservation',
	'preflightOrphanedGatewayCleanupIfPresent',
]);

// This is deliberately a narrow inventory of receiver expressions known to hold
// ManagedVm values in orchestration code. It avoids treating every socket,
// server, file, database, and portal handle named `close` as VM destruction.
const KNOWN_MANAGED_VM_CLOSE_RECEIVERS = new Set([
	'activeGateway.vm',
	'currentLease.vm',
	'gateway.vm',
	'lease.vm',
	'managedVm',
	'options.vm',
	'pendingCleanup.vm',
	'cleanupContext.vm',
	'toolVm',
	'vm',
]);

function normalizeFilePath(filePath: string): string {
	return filePath.replaceAll('\\', '/');
}

function isProductionTypeScriptFile(filePath: string): boolean {
	const normalizedPath = normalizeFilePath(filePath);
	return (
		normalizedPath.endsWith('.ts') &&
		!normalizedPath.endsWith('.test.ts') &&
		!normalizedPath.endsWith('.spec.ts') &&
		!normalizedPath.includes('/integration-tests/')
	);
}

function compareAuditFindings(
	left: VmOwnershipBoundaryAuditFinding,
	right: VmOwnershipBoundaryAuditFinding,
): number {
	const filePathOrder = left.filePath.localeCompare(right.filePath);
	if (filePathOrder !== 0) {
		return filePathOrder;
	}
	const lineOrder = left.line - right.line;
	return lineOrder === 0 ? left.reason.localeCompare(right.reason) : lineOrder;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error;
}

function insertDependencyFinding(
	findings: VmOwnershipBoundaryAuditFinding[],
	source: VmOwnershipBoundaryAuditSource,
	reason: string,
	line = 1,
): void {
	findings.push({ filePath: normalizeFilePath(source.filePath), line, reason });
}

function parseJsonObject(content: string): Readonly<Record<string, unknown>> | undefined {
	try {
		const parsed: unknown = JSON.parse(content);
		return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
			? (parsed as Readonly<Record<string, unknown>>)
			: undefined;
	} catch {
		return undefined;
	}
}

function gondolinResolutionProtocol(
	content: string,
): 'file:' | 'link:' | 'local:' | 'workspace:' | undefined {
	const lines = content.split('\n');
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
		const line = lines[lineIndex] ?? '';
		if (!line.includes(STOCK_GONDOLIN_PACKAGE_NAME)) {
			continue;
		}
		const dependencyBlock = lines.slice(lineIndex, lineIndex + 4).join('\n');
		for (const protocol of ['file:', 'link:', 'local:', 'workspace:'] as const) {
			if (dependencyBlock.includes(protocol)) {
				return protocol;
			}
		}
	}
	return undefined;
}

function repositoryGondolinVersion(source: VmOwnershipBoundaryAuditSource): string | undefined {
	if (normalizeFilePath(source.filePath) !== 'packages/gondolin-adapter/package.json') {
		return undefined;
	}
	const parsed = parseJsonObject(source.content);
	const dependencies = parsed?.dependencies;
	if (typeof dependencies !== 'object' || dependencies === null || Array.isArray(dependencies)) {
		return undefined;
	}
	const version = (dependencies as Readonly<Record<string, unknown>>)[STOCK_GONDOLIN_PACKAGE_NAME];
	return typeof version === 'string' ? version : undefined;
}

function installedGondolinVersion(source: VmOwnershipBoundaryAuditSource): string | undefined {
	const normalizedPath = normalizeFilePath(source.filePath);
	if (
		!normalizedPath.startsWith('node_modules/.pnpm/@earendil-works+gondolin@') ||
		!normalizedPath.endsWith('/node_modules/@earendil-works/gondolin/package.json')
	) {
		return undefined;
	}
	const parsed = parseJsonObject(source.content);
	return parsed?.name === STOCK_GONDOLIN_PACKAGE_NAME && typeof parsed.version === 'string'
		? parsed.version
		: undefined;
}

export function auditStockGondolinDependencyBoundary(
	sources: readonly VmOwnershipBoundaryAuditSource[],
	options: { readonly requireCompleteGraph?: boolean } = {},
): readonly VmOwnershipBoundaryAuditFinding[] {
	const findings: VmOwnershipBoundaryAuditFinding[] = [];
	let exactRepositoryVersionFound = false;
	let exactLockIdentityFound = false;
	let exactInstalledVersionFound = false;
	for (const source of sources) {
		const normalizedPath = normalizeFilePath(source.filePath);
		if (
			normalizedPath.startsWith('patches/') &&
			normalizedPath.endsWith('.patch') &&
			normalizedPath.toLowerCase().includes('gondolin')
		) {
			insertDependencyFinding(findings, source, 'Gondolin dependency patch artifact is present');
		}
		if (source.content.includes('patchedDependencies')) {
			insertDependencyFinding(findings, source, 'pnpm patchedDependencies is forbidden');
		}
		if (
			(source.content.includes(`${STOCK_GONDOLIN_PACKAGE_NAME}@patch:`) ||
				normalizedPath.includes('@patch:') ||
				normalizedPath.includes('_patch_hash=')) &&
			(source.content.includes(STOCK_GONDOLIN_PACKAGE_NAME) ||
				normalizedPath.includes('@earendil-works+gondolin'))
		) {
			insertDependencyFinding(
				findings,
				source,
				'Gondolin dependency uses a forbidden patch identity',
			);
		}
		const resolutionProtocol = gondolinResolutionProtocol(`${normalizedPath}\n${source.content}`);
		if (resolutionProtocol !== undefined) {
			insertDependencyFinding(
				findings,
				source,
				`Gondolin dependency uses forbidden '${resolutionProtocol}' resolution`,
			);
		}
		const repositoryVersion = repositoryGondolinVersion(source);
		if (repositoryVersion !== undefined) {
			exactRepositoryVersionFound = repositoryVersion === STOCK_GONDOLIN_VERSION;
			if (!exactRepositoryVersionFound && resolutionProtocol === undefined) {
				insertDependencyFinding(
					findings,
					source,
					`Gondolin repository dependency must be exact '${STOCK_GONDOLIN_VERSION}', found '${repositoryVersion}'`,
				);
			}
		}
		if (
			normalizedPath.endsWith('pnpm-lock.yaml') &&
			source.content.includes(`'${STOCK_GONDOLIN_PACKAGE_NAME}@${STOCK_GONDOLIN_VERSION}':`)
		) {
			exactLockIdentityFound = true;
		}
		const installedVersion = installedGondolinVersion(source);
		if (installedVersion !== undefined) {
			exactInstalledVersionFound = installedVersion === STOCK_GONDOLIN_VERSION;
			if (!exactInstalledVersionFound) {
				insertDependencyFinding(
					findings,
					source,
					`Installed Gondolin must be '${STOCK_GONDOLIN_VERSION}', found '${installedVersion}'`,
				);
			}
		}
	}
	if (options.requireCompleteGraph === true) {
		const graphSource = { content: '', filePath: '<gondolin-dependency-graph>' };
		if (!exactRepositoryVersionFound) {
			insertDependencyFinding(
				findings,
				graphSource,
				`Exact repository Gondolin dependency '${STOCK_GONDOLIN_VERSION}' is missing`,
			);
		}
		if (!exactLockIdentityFound) {
			insertDependencyFinding(
				findings,
				graphSource,
				`Exact lockfile Gondolin identity '${STOCK_GONDOLIN_VERSION}' is missing`,
			);
		}
		if (!exactInstalledVersionFound) {
			insertDependencyFinding(
				findings,
				graphSource,
				`Exact installed Gondolin package '${STOCK_GONDOLIN_VERSION}' is missing`,
			);
		}
	}
	findings.sort(compareAuditFindings);
	return findings;
}

async function readOptionalAuditSource(
	repositoryRoot: string,
	relativePath: string,
): Promise<VmOwnershipBoundaryAuditSource | undefined> {
	try {
		return {
			content: await readFile(path.join(repositoryRoot, relativePath), 'utf8'),
			filePath: normalizeFilePath(relativePath),
		};
	} catch (error) {
		if (isErrnoException(error) && error.code === 'ENOENT') {
			return undefined;
		}
		throw error;
	}
}

export async function readStockGondolinDependencyAuditSources(
	repositoryRoot: string,
): Promise<readonly VmOwnershipBoundaryAuditSource[]> {
	const repositoryMetadata = await Promise.all(
		STOCK_GONDOLIN_REPOSITORY_METADATA_PATHS.map(
			async (relativePath) => await readOptionalAuditSource(repositoryRoot, relativePath),
		),
	);
	const patchSources: VmOwnershipBoundaryAuditSource[] = [];
	try {
		const patchEntries = await readdir(path.join(repositoryRoot, 'patches'), {
			withFileTypes: true,
		});
		for (const entry of patchEntries) {
			if (
				entry.isFile() &&
				entry.name.endsWith('.patch') &&
				entry.name.toLowerCase().includes('gondolin')
			) {
				patchSources.push({ content: '', filePath: `patches/${entry.name}` });
			}
		}
	} catch (error) {
		if (!isErrnoException(error) || error.code !== 'ENOENT') {
			throw error;
		}
	}
	const installedSources: VmOwnershipBoundaryAuditSource[] = [];
	try {
		const installedPackageDirectory = await realpath(
			path.join(
				repositoryRoot,
				'packages',
				'gondolin-adapter',
				'node_modules',
				'@earendil-works',
				'gondolin',
			),
		);
		const installedPackageJsonPath = path.join(installedPackageDirectory, 'package.json');
		installedSources.push({
			content: await readFile(installedPackageJsonPath, 'utf8'),
			filePath: normalizeFilePath(path.relative(repositoryRoot, installedPackageJsonPath)),
		});
	} catch (error) {
		if (!isErrnoException(error) || error.code !== 'ENOENT') {
			throw error;
		}
	}
	return [
		...repositoryMetadata.filter(
			(source): source is VmOwnershipBoundaryAuditSource => source !== undefined,
		),
		...patchSources,
		...installedSources,
	];
}

function containingFunctionDeclaration(node: ts.Node): ts.FunctionDeclaration | undefined {
	let ancestor: ts.Node | undefined = node.parent;
	while (ancestor !== undefined) {
		if (ts.isFunctionDeclaration(ancestor)) {
			return ancestor;
		}
		ancestor = ancestor.parent;
	}
	return undefined;
}

function isInsideControllerManagedTerminationPrimitive(
	closeCall: ts.CallExpression,
	normalizedPath: string,
): boolean {
	return (
		normalizedPath === CONTROLLER_MANAGED_TERMINATION_FILE_PATH &&
		containingFunctionDeclaration(closeCall)?.name?.text === 'terminateLiveManagedVm'
	);
}

function isInsideUnstartedVmConstructionCleanup(
	closeCall: ts.CallExpression,
	normalizedPath: string,
): boolean {
	return (
		normalizedPath === TOOL_VM_LIFECYCLE_FILE_PATH &&
		containingFunctionDeclaration(closeCall)?.name?.text === 'createUnstartedToolVm'
	);
}

function directStatementInBlock(
	node: ts.Node,
): { readonly block: ts.Block; readonly statement: ts.Statement } | undefined {
	let statement: ts.Node | undefined = node;
	while (statement !== undefined && !ts.isStatement(statement)) {
		statement = statement.parent;
	}
	if (statement === undefined || !ts.isBlock(statement.parent)) {
		return undefined;
	}
	return { block: statement.parent, statement };
}

function branchAlwaysThrows(statement: ts.Statement): boolean {
	return (
		ts.isThrowStatement(statement) ||
		(ts.isBlock(statement) && statement.statements.some((child) => ts.isThrowStatement(child)))
	);
}

function hostPidReceiverFromCall(
	expression: ts.Expression,
	sourceFile: ts.SourceFile,
): string | undefined {
	if (
		!ts.isCallExpression(expression) ||
		!ts.isPropertyAccessExpression(expression.expression) ||
		expression.expression.name.text !== 'getHostPid' ||
		expression.arguments.length !== 0
	) {
		return undefined;
	}
	return expression.expression.expression.getText(sourceFile).replaceAll(/\s+/gu, '');
}

function priorVariableHostPidReceiver(options: {
	readonly identifier: ts.Identifier;
	readonly precedingStatements: readonly ts.Statement[];
	readonly sourceFile: ts.SourceFile;
}): string | undefined {
	for (const statement of options.precedingStatements.toReversed()) {
		if (!ts.isVariableStatement(statement)) {
			continue;
		}
		for (const declaration of statement.declarationList.declarations) {
			if (
				ts.isIdentifier(declaration.name) &&
				declaration.name.text === options.identifier.text &&
				declaration.initializer !== undefined
			) {
				return hostPidReceiverFromCall(declaration.initializer, options.sourceFile);
			}
		}
	}
	return undefined;
}

function nullComparisonHostPidReceiver(options: {
	readonly condition: ts.Expression;
	readonly precedingStatements: readonly ts.Statement[];
	readonly sourceFile: ts.SourceFile;
	readonly tokenKind:
		| ts.SyntaxKind.EqualsEqualsEqualsToken
		| ts.SyntaxKind.ExclamationEqualsEqualsToken;
}): string | undefined {
	if (
		!ts.isBinaryExpression(options.condition) ||
		options.condition.operatorToken.kind !== options.tokenKind ||
		options.condition.right.kind !== ts.SyntaxKind.NullKeyword
	) {
		return undefined;
	}
	return ts.isIdentifier(options.condition.left)
		? priorVariableHostPidReceiver({
				identifier: options.condition.left,
				precedingStatements: options.precedingStatements,
				sourceFile: options.sourceFile,
			})
		: hostPidReceiverFromCall(options.condition.left, options.sourceFile);
}

function hasLexicalRunnerAbsenceProof(
	closeCall: ts.CallExpression,
	receiver: string,
	sourceFile: ts.SourceFile,
): boolean {
	let ancestor: ts.Node | undefined = closeCall.parent;
	while (ancestor !== undefined) {
		if (ts.isIfStatement(ancestor)) {
			const directNullReceiver = nullComparisonHostPidReceiver({
				condition: ancestor.expression,
				precedingStatements: [],
				sourceFile,
				tokenKind: ts.SyntaxKind.EqualsEqualsEqualsToken,
			});
			if (
				directNullReceiver === receiver &&
				ancestor.thenStatement.getStart() <= closeCall.getStart()
			) {
				return true;
			}
		}
		ancestor = ancestor.parent;
	}

	const directStatement = directStatementInBlock(closeCall);
	if (directStatement === undefined) {
		return false;
	}
	const closeIndex = directStatement.block.statements.indexOf(directStatement.statement);
	const precedingStatements = directStatement.block.statements.slice(0, closeIndex);
	for (const statement of precedingStatements.toReversed()) {
		if (!ts.isIfStatement(statement) || !branchAlwaysThrows(statement.thenStatement)) {
			continue;
		}
		const guardedReceiver = nullComparisonHostPidReceiver({
			condition: statement.expression,
			precedingStatements,
			sourceFile,
			tokenKind: ts.SyntaxKind.ExclamationEqualsEqualsToken,
		});
		if (guardedReceiver === receiver) {
			return true;
		}
	}
	return false;
}

function managedVmCloseReceiver(
	callExpression: ts.CallExpression,
	sourceFile: ts.SourceFile,
): string | undefined {
	if (
		!ts.isPropertyAccessExpression(callExpression.expression) ||
		callExpression.expression.name.text !== 'close' ||
		callExpression.arguments.length !== 0
	) {
		return undefined;
	}
	const receiver = callExpression.expression.expression.getText(sourceFile).replaceAll(/\s+/gu, '');
	return KNOWN_MANAGED_VM_CLOSE_RECEIVERS.has(receiver) ? receiver : undefined;
}

function auditSource(
	source: VmOwnershipBoundaryAuditSource,
): readonly VmOwnershipBoundaryAuditFinding[] {
	const normalizedPath = normalizeFilePath(source.filePath);
	if (!isProductionTypeScriptFile(normalizedPath)) {
		return [];
	}
	const sourceFile = ts.createSourceFile(
		normalizedPath,
		source.content,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const findings: VmOwnershipBoundaryAuditFinding[] = [];
	const insertFinding = (node: ts.Node, reason: string): void => {
		const finding = {
			filePath: normalizedPath,
			line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
			reason,
		};
		if (
			!findings.some(
				(existing) =>
					existing.filePath === finding.filePath &&
					existing.line === finding.line &&
					existing.reason === finding.reason,
			)
		) {
			findings.push(finding);
		}
	};
	const visit = (node: ts.Node): void => {
		if (ts.isIdentifier(node)) {
			if (isDeletedVmLifecycleSymbol(node.text)) {
				insertFinding(node, `deleted VM lifecycle symbol '${node.text}' is referenced`);
			}
		}
		if (
			ts.isImportDeclaration(node) &&
			ts.isStringLiteral(node.moduleSpecifier) &&
			DELETED_VM_LIFECYCLE_MODULES.has(node.moduleSpecifier.text.split('/').at(-1) ?? '')
		) {
			insertFinding(
				node.moduleSpecifier,
				`deleted VM lifecycle module '${node.moduleSpecifier.text}' is imported`,
			);
		}
		if (ts.isCallExpression(node)) {
			const receiver = managedVmCloseReceiver(node, sourceFile);
			if (
				receiver !== undefined &&
				!isInsideControllerManagedTerminationPrimitive(node, normalizedPath) &&
				!isInsideUnstartedVmConstructionCleanup(node, normalizedPath) &&
				!hasLexicalRunnerAbsenceProof(node, receiver, sourceFile)
			) {
				insertFinding(
					node,
					`ManagedVm close '${receiver}.close()' has no lexical runner-absence proof`,
				);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return findings;
}

export function auditVmOwnershipBoundaries(
	sources: readonly VmOwnershipBoundaryAuditSource[],
): readonly VmOwnershipBoundaryAuditFinding[] {
	const findings: VmOwnershipBoundaryAuditFinding[] = [];
	for (const source of sources) {
		findings.push(...auditSource(source));
	}
	findings.sort(compareAuditFindings);
	return findings;
}

export function auditLeaseManagerSoleAuthorityOwnership(
	sources: readonly VmOwnershipBoundaryAuditSource[],
): readonly VmOwnershipBoundaryAuditFinding[] {
	const findings: VmOwnershipBoundaryAuditFinding[] = [];
	for (const source of sources) {
		const normalizedPath = normalizeFilePath(source.filePath);
		if (normalizedPath !== LEASE_MANAGER_FILE_PATH) {
			continue;
		}
		const sourceFile = ts.createSourceFile(
			normalizedPath,
			source.content,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TS,
		);
		const insertFinding = (node: ts.Node, reason: string): void => {
			findings.push({
				filePath: normalizedPath,
				line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
				reason,
			});
		};
		const visit = (node: ts.Node): void => {
			if (
				ts.isImportDeclaration(node) &&
				ts.isStringLiteral(node.moduleSpecifier) &&
				node.moduleSpecifier.text === LEGACY_CURRENT_LEASE_REGISTRY_MODULE
			) {
				insertFinding(node, 'LeaseManager imports the legacy Tool VM current-lease registry');
			}
			if (
				ts.isCallExpression(node) &&
				ts.isIdentifier(node.expression) &&
				node.expression.text === LEGACY_CURRENT_LEASE_REGISTRY_FACTORY
			) {
				insertFinding(
					node,
					`LeaseManager calls legacy mutable authority factory '${LEGACY_CURRENT_LEASE_REGISTRY_FACTORY}'`,
				);
			}
			if (
				ts.isVariableDeclaration(node) &&
				ts.isIdentifier(node.name) &&
				LEGACY_LEASE_MANAGER_AUTHORITY_STORE_NAMES.has(node.name.text)
			) {
				insertFinding(
					node.name,
					`LeaseManager declares legacy mutable authority store '${node.name.text}'`,
				);
			}
			ts.forEachChild(node, visit);
		};
		visit(sourceFile);
	}
	findings.sort(compareAuditFindings);
	return findings;
}

async function listProductionTypeScriptFiles(directoryPath: string): Promise<readonly string[]> {
	const entries = await readdir(directoryPath, { withFileTypes: true });
	const nestedFiles = await Promise.all(
		entries.map(async (entry): Promise<readonly string[]> => {
			const entryPath = path.join(directoryPath, entry.name);
			if (entry.isDirectory()) {
				return entry.name === 'integration-tests'
					? []
					: await listProductionTypeScriptFiles(entryPath);
			}
			return entry.isFile() && isProductionTypeScriptFile(entryPath) ? [entryPath] : [];
		}),
	);
	return nestedFiles.flat();
}

export async function readVmOwnershipBoundaryAuditSources(
	repositoryRoot: string,
): Promise<readonly VmOwnershipBoundaryAuditSource[]> {
	const sourceFiles = (
		await Promise.all(
			AUDIT_SOURCE_ROOTS.map(
				async (sourceRoot) =>
					await listProductionTypeScriptFiles(path.join(repositoryRoot, sourceRoot)),
			),
		)
	).flat();
	return await Promise.all(
		sourceFiles.map(
			async (absoluteFilePath): Promise<VmOwnershipBoundaryAuditSource> => ({
				content: await readFile(absoluteFilePath, 'utf8'),
				filePath: normalizeFilePath(path.relative(repositoryRoot, absoluteFilePath)),
			}),
		),
	);
}

async function runAuditCli(): Promise<void> {
	const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
	const sources = await readVmOwnershipBoundaryAuditSources(repositoryRoot);
	const findings = [
		...auditStockGondolinDependencyBoundary(
			await readStockGondolinDependencyAuditSources(repositoryRoot),
			{ requireCompleteGraph: true },
		),
		...auditVmOwnershipBoundaries(sources),
		...auditLeaseManagerSoleAuthorityOwnership(sources),
	].toSorted(compareAuditFindings);
	if (findings.length === 0) {
		process.stdout.write('VM ownership boundary audit passed.\n');
		return;
	}
	process.stderr.write(
		`${findings
			.map((finding) => `${finding.filePath}:${finding.line} ${finding.reason}`)
			.join('\n')}\n`,
	);
	process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	await runAuditCli();
}
