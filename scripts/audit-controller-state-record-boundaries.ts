import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';

export interface ControllerStateRecordBoundaryAuditSource {
	readonly content: string;
	readonly filePath: string;
}

export interface ControllerStateRecordBoundaryAuditFinding {
	readonly filePath: string;
	readonly line: number;
	readonly reason: string;
}

const LEGACY_CONTROLLER_RECORD_EVIDENCE_SCANNER_PATH =
	'packages/agent-vm/src/controller/durable-state/legacy-controller-record-evidence.ts';

const GENERIC_STATE_DIRECTORY_NAME_PATTERN =
	/\b[\w$]*(?:StateDir|stateDir|StateDirectory|stateDirectory)[\w$]*\b/u;
const FORBIDDEN_RECORD_ALIAS_NAME_PATTERN =
	/(?:legacy|fallback|migration|migrate|compatibility|compat)[\w$]*(?:(?:controller|gatewayRuntime|managedGatewayRuntime|workerRuntime|toolVmRuntime|approval)[\w$]*record|stateDir|stateDirectory)|(?:(?:controller|gatewayRuntime|managedGatewayRuntime|workerRuntime|toolVmRuntime|approval)[\w$]*record|stateDir|stateDirectory)[\w$]*(?:legacy|fallback|migration|migrate|compatibility|compat)/iu;
const RECORD_MODULE_PATH_PATTERN =
	/(?:^|\/)(?:[^/]*record[^/]*|controller-approval-ledger)[.](?:cts|mts|ts|tsx)$/u;
const RECORD_CALL_NAME_PATTERN =
	/(?:GatewayRuntimeRecord|WorkerRuntimeRecord|ToolVmRuntimeRecord|RuntimeRecord|ControllerApprovalLedger|CrashDurableRecordStore)/u;
const RECORD_READ_CALL_NAME_PATTERN =
	/(?:load|read)[\w$]*(?:GatewayRuntimeRecord|WorkerRuntimeRecord|ToolVmRuntimeRecord|Approval)/u;

function normalizeFilePath(filePath: string): string {
	return filePath.replaceAll('\\', '/');
}

function isProductionTypeScriptFile(filePath: string): boolean {
	return (
		filePath.startsWith('packages/') &&
		filePath.includes('/src/') &&
		/\.(?:cts|mts|ts|tsx)$/u.test(filePath) &&
		!/[.](?:spec|test)[.](?:cts|mts|ts|tsx)$/u.test(filePath) &&
		!filePath.includes('/integration-tests/') &&
		!filePath.includes('/fixtures/') &&
		!filePath.endsWith('-test-fixture.ts')
	);
}

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
	return (
		ts.isFunctionDeclaration(node) ||
		ts.isFunctionExpression(node) ||
		ts.isArrowFunction(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isConstructorDeclaration(node) ||
		ts.isGetAccessorDeclaration(node) ||
		ts.isSetAccessorDeclaration(node)
	);
}

function nodeContainsIdentifierMatching(node: ts.Node, pattern: RegExp): boolean {
	let matches = false;
	const visit = (candidate: ts.Node): void => {
		if (matches) {
			return;
		}
		if (ts.isIdentifier(candidate) && pattern.test(candidate.text)) {
			matches = true;
			return;
		}
		ts.forEachChild(candidate, visit);
	};
	visit(node);
	return matches;
}

function functionAcceptsGenericStateDirectory(node: ts.FunctionLikeDeclaration): boolean {
	return node.parameters.some((parameter) =>
		nodeContainsIdentifierMatching(parameter, /^(?:stateDir|stateDirectory)$/u),
	);
}

function callName(node: ts.CallExpression, sourceFile: ts.SourceFile): string {
	return node.expression.getText(sourceFile);
}

function callPassesGatewayStateDirectory(
	node: ts.CallExpression,
	sourceFile: ts.SourceFile,
): boolean {
	if (!RECORD_CALL_NAME_PATTERN.test(callName(node, sourceFile))) {
		return false;
	}
	return node.arguments.some((argument) =>
		/(?:^|\.)gateway[?]?\.stateDir\b/u.test(argument.getText(sourceFile)),
	);
}

function callPassesGenericStateDirectory(
	node: ts.CallExpression,
	sourceFile: ts.SourceFile,
): boolean {
	if (!RECORD_CALL_NAME_PATTERN.test(callName(node, sourceFile))) {
		return false;
	}
	return node.arguments.some((argument) =>
		GENERIC_STATE_DIRECTORY_NAME_PATTERN.test(argument.getText(sourceFile)),
	);
}

function stringLiteralValues(nodes: readonly ts.Node[]): ReadonlySet<string> {
	const values = new Set<string>();
	for (const node of nodes) {
		if (ts.isStringLiteralLike(node)) {
			values.add(node.text);
		}
	}
	return values;
}

function legacyLayoutReason(
	node: ts.CallExpression,
	sourceFile: ts.SourceFile,
): string | undefined {
	const calledExpression = callName(node, sourceFile);
	if (calledExpression !== 'join' && !calledExpression.endsWith('.join')) {
		return undefined;
	}
	const [rootArgument, ...pathArguments] = node.arguments;
	if (
		rootArgument === undefined ||
		!GENERIC_STATE_DIRECTORY_NAME_PATTERN.test(rootArgument.getText(sourceFile))
	) {
		return undefined;
	}
	const pathSegments = stringLiteralValues(pathArguments);
	if (
		pathSegments.has('tasks') &&
		pathSegments.has('state') &&
		pathSegments.has('gateway-runtime.json')
	) {
		return 'legacy Worker task runtime record layout is forbidden outside the legacy evidence scanner';
	}
	if (pathSegments.has('gateway-runtime.json')) {
		return 'legacy managed Gateway runtime record layout is forbidden outside the legacy evidence scanner';
	}
	if (pathSegments.has('approvals')) {
		return 'legacy approval record layout is forbidden outside the legacy evidence scanner';
	}
	if (pathSegments.has('tool-leases')) {
		return 'legacy Tool-lease record layout is forbidden outside the legacy evidence scanner';
	}
	return undefined;
}

function containsRecordReadCall(node: ts.Node, sourceFile: ts.SourceFile): boolean {
	let containsRead = false;
	const visit = (candidate: ts.Node): void => {
		if (containsRead) {
			return;
		}
		if (
			ts.isCallExpression(candidate) &&
			RECORD_READ_CALL_NAME_PATTERN.test(callName(candidate, sourceFile))
		) {
			containsRead = true;
			return;
		}
		ts.forEachChild(candidate, visit);
	};
	visit(node);
	return containsRead;
}

function isDualRecordReadFallback(node: ts.BinaryExpression, sourceFile: ts.SourceFile): boolean {
	return (
		(node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
			node.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
		containsRecordReadCall(node.left, sourceFile) &&
		containsRecordReadCall(node.right, sourceFile)
	);
}

function isForbiddenRecordAliasDeclaration(node: ts.Identifier): boolean {
	const parent = node.parent;
	return (
		((ts.isVariableDeclaration(parent) ||
			ts.isFunctionDeclaration(parent) ||
			ts.isParameter(parent) ||
			ts.isPropertyDeclaration(parent) ||
			ts.isPropertySignature(parent) ||
			ts.isMethodDeclaration(parent) ||
			ts.isTypeAliasDeclaration(parent) ||
			ts.isInterfaceDeclaration(parent) ||
			ts.isClassDeclaration(parent) ||
			ts.isBindingElement(parent)) &&
			parent.name === node) ||
		(ts.isImportSpecifier(parent) && parent.name === node)
	);
}

function compareFindings(
	left: ControllerStateRecordBoundaryAuditFinding,
	right: ControllerStateRecordBoundaryAuditFinding,
): number {
	return (
		left.filePath.localeCompare(right.filePath) ||
		left.line - right.line ||
		left.reason.localeCompare(right.reason)
	);
}

function auditSource(
	source: ControllerStateRecordBoundaryAuditSource,
): readonly ControllerStateRecordBoundaryAuditFinding[] {
	const filePath = normalizeFilePath(source.filePath);
	if (
		!isProductionTypeScriptFile(filePath) ||
		filePath === LEGACY_CONTROLLER_RECORD_EVIDENCE_SCANNER_PATH
	) {
		return [];
	}
	const sourceFile = ts.createSourceFile(
		filePath,
		source.content,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const findings: ControllerStateRecordBoundaryAuditFinding[] = [];
	const findingKeys = new Set<string>();
	const insertFinding = (node: ts.Node, reason: string): void => {
		const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
		const findingKey = `${String(line)}\0${reason}`;
		if (findingKeys.has(findingKey)) {
			return;
		}
		findingKeys.add(findingKey);
		findings.push({ filePath, line, reason });
	};
	const visit = (node: ts.Node): void => {
		if (
			RECORD_MODULE_PATH_PATTERN.test(filePath) &&
			isFunctionLike(node) &&
			functionAcceptsGenericStateDirectory(node)
		) {
			insertFinding(
				node,
				'record module API must accept a typed controller-state record target, not generic stateDir/stateDirectory',
			);
		}
		if (ts.isCallExpression(node)) {
			if (callPassesGatewayStateDirectory(node, sourceFile)) {
				insertFinding(node, 'record call site must not pass Gateway-owned .gateway.stateDir');
			} else if (callPassesGenericStateDirectory(node, sourceFile)) {
				insertFinding(
					node,
					'record call site must pass a typed controller-state target, not generic stateDir/stateDirectory data',
				);
			}
			if (FORBIDDEN_RECORD_ALIAS_NAME_PATTERN.test(callName(node, sourceFile))) {
				insertFinding(
					node,
					'controller-state record fallback, migration, or compatibility alias is forbidden',
				);
			}
			const layoutReason = legacyLayoutReason(node, sourceFile);
			if (layoutReason !== undefined) {
				insertFinding(node, layoutReason);
			}
		}
		if (
			ts.isIdentifier(node) &&
			isForbiddenRecordAliasDeclaration(node) &&
			FORBIDDEN_RECORD_ALIAS_NAME_PATTERN.test(node.text)
		) {
			insertFinding(
				node,
				'controller-state record fallback, migration, or compatibility alias is forbidden',
			);
		}
		if (ts.isBinaryExpression(node) && isDualRecordReadFallback(node, sourceFile)) {
			insertFinding(node, 'controller-state record dual-read fallback is forbidden');
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return findings;
}

export function auditControllerStateRecordBoundaries(
	sources: readonly ControllerStateRecordBoundaryAuditSource[],
): readonly ControllerStateRecordBoundaryAuditFinding[] {
	return sources.flatMap(auditSource).toSorted(compareFindings);
}

async function listProductionTypeScriptFiles(directoryPath: string): Promise<readonly string[]> {
	const entries = await readdir(directoryPath, { withFileTypes: true });
	const nestedFiles = await Promise.all(
		entries.map(async (entry): Promise<readonly string[]> => {
			const entryPath = path.join(directoryPath, entry.name);
			if (entry.isDirectory()) {
				return entry.name === 'dist' || entry.name === 'node_modules'
					? []
					: await listProductionTypeScriptFiles(entryPath);
			}
			return entry.isFile() && /\.(?:cts|mts|ts|tsx)$/u.test(entry.name) ? [entryPath] : [];
		}),
	);
	return nestedFiles.flat();
}

export async function readControllerStateRecordBoundaryAuditSources(
	repositoryRoot: string,
): Promise<readonly ControllerStateRecordBoundaryAuditSource[]> {
	const absoluteFilePaths = await listProductionTypeScriptFiles(
		path.join(repositoryRoot, 'packages'),
	);
	return await Promise.all(
		absoluteFilePaths.map(
			async (absoluteFilePath): Promise<ControllerStateRecordBoundaryAuditSource> => ({
				content: await readFile(absoluteFilePath, 'utf8'),
				filePath: normalizeFilePath(path.relative(repositoryRoot, absoluteFilePath)),
			}),
		),
	);
}

async function runAuditCli(): Promise<void> {
	const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
	const findings = auditControllerStateRecordBoundaries(
		await readControllerStateRecordBoundaryAuditSources(repositoryRoot),
	);
	if (findings.length === 0) {
		process.stdout.write('controller-state record boundary audit passed.\n');
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
