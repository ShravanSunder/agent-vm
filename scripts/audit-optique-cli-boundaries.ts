import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import ts from 'typescript';

export interface OptiqueCliBoundaryInventoryEntry {
	readonly commandTypeAlias: string;
	readonly executableName: string;
	readonly executableRoot: string;
	readonly parserFiles: readonly string[];
	readonly rootParserName: string;
	readonly valueBearing: boolean;
}

export interface OptiqueCliBoundaryAuditFinding {
	readonly executableName: string;
	readonly filePath: string;
	readonly line: number;
	readonly reason: string;
}

export interface AuditOptiqueCliBoundariesProps {
	readonly additionalExportFiles?: readonly string[];
	readonly inventory: readonly OptiqueCliBoundaryInventoryEntry[];
	readonly repositoryRoot: string;
}

interface DefaultInventorySeed {
	readonly commandTypeAlias: string;
	readonly executableName: string;
	readonly executableRoot: string;
	readonly parserSearchRoots: readonly string[];
	readonly rootParserName: string;
	readonly valueBearing: boolean;
}

const DEFAULT_INVENTORY_SEEDS = [
	{
		commandTypeAlias: 'AgentVmCommand',
		executableName: 'agent-vm',
		executableRoot: 'packages/agent-vm/src/cli/agent-vm-entrypoint.ts',
		parserSearchRoots: ['packages/agent-vm/src/cli'],
		rootParserName: 'agentVmRootParser',
		valueBearing: true,
	},
	{
		commandTypeAlias: 'WorkerCommand',
		executableName: 'agent-vm-worker',
		executableRoot: 'packages/agent-vm-worker/src/main.ts',
		parserSearchRoots: ['packages/agent-vm-worker/src'],
		rootParserName: 'workerCommandParser',
		valueBearing: true,
	},
	{
		commandTypeAlias: 'ToolPortalCommand',
		executableName: 'tool-portal',
		executableRoot: 'packages/agent-portal-sdk/src/cli/tool-portal.ts',
		parserSearchRoots: ['packages/agent-portal-sdk/src/cli'],
		rootParserName: 'toolPortalRootParser',
		valueBearing: true,
	},
	{
		commandTypeAlias: 'McpPortalCommand',
		executableName: 'mcp-portal',
		executableRoot: 'packages/mcp-portal/src/bin/mcp-portal.ts',
		parserSearchRoots: ['packages/mcp-portal/src/bin', 'packages/mcp-portal/src/cli'],
		rootParserName: 'mcpPortalRootParser',
		valueBearing: true,
	},
	{
		commandTypeAlias: 'GatewayRuntimeCommand',
		executableName: 'agent-vm-gateway-runtime',
		executableRoot: 'packages/gateway-runtime/src/bin/gateway-runtime.ts',
		parserSearchRoots: ['packages/gateway-runtime/src/bin'],
		rootParserName: 'gatewayRuntimeRootParser',
		valueBearing: true,
	},
] as const satisfies readonly DefaultInventorySeed[];

const DEFAULT_EXPORT_FILES = [
	'packages/mcp-portal/src/cli/index.ts',
	'scripts/verify-portal-package-exports.ts',
] as const;
const PARSER_FILE_NAME_PATTERN =
	/(?:cli-parser|command-parser|parser-support|definition|command-definition-support|create-app|serve-command|schema)[.]ts$/u;
const PARSER_SOURCE_MARKER_PATTERN =
	/(?:from\s+['"](?:cmd-ts|@optique\/(?:core(?:\/[^'"]+)?|zod))['"]|function\s+(?:parseCliArguments|parsePortalServerCliArgs|configPathFromArguments)\b)/u;
const NODE_EFFECT_OWNER_IMPORT_PATTERN =
	/^node:(?:child_process|fs(?:\/promises)?|http|https|net)$/u;
const DISPATCHER_OR_OPERATION_FILE_NAME_PATTERN = /(?:dispatcher|operation)[.]ts$/u;
const ROOT_SUPPORT_FILE_NAME_PATTERN =
	/(?:cli-support|terminal|version|entrypoint-identity|executable-identity)(?:-support)?[.]ts$/u;
const CUSTOM_EXIT_PROTOCOL_NAME_PATTERN =
	/(?:ReportedCliError|Cli\w*(?:Exit|Outcome|Signal)|\w*(?:Exit|Outcome|Signal)Protocol)/u;
const MANUAL_PARSER_NAME_PATTERN =
	/^(?:configPathFromArguments|parseCliArguments|parseNamedOptions|parseOutputDirectory|parsePortalServerCliArgs|printUsage|readFlag)$/u;

function normalizeFilePath(filePath: string): string {
	return filePath.replaceAll('\\', '/');
}

function moduleSpecifierText(node: ts.ImportDeclaration): string | undefined {
	return ts.isStringLiteralLike(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
}

interface ImportedBindings {
	readonly namedBindings: ReadonlyMap<string, string>;
	readonly namespaceBindings: ReadonlySet<string>;
}

function importedBindingsFrom(
	sourceFile: ts.SourceFile,
	moduleSpecifier: string,
): ImportedBindings {
	const namedBindingsByLocalName = new Map<string, string>();
	const namespaceBindings = new Set<string>();
	for (const statement of sourceFile.statements) {
		if (!ts.isImportDeclaration(statement) || moduleSpecifierText(statement) !== moduleSpecifier) {
			continue;
		}
		const importedBindings = statement.importClause?.namedBindings;
		if (importedBindings !== undefined && ts.isNamedImports(importedBindings)) {
			for (const element of importedBindings.elements) {
				namedBindingsByLocalName.set(
					element.name.text,
					(element.propertyName ?? element.name).text,
				);
			}
		} else if (importedBindings !== undefined && ts.isNamespaceImport(importedBindings)) {
			namespaceBindings.add(importedBindings.name.text);
		}
	}
	return { namedBindings: namedBindingsByLocalName, namespaceBindings };
}

function importedBindingsFromPrefix(
	sourceFile: ts.SourceFile,
	moduleSpecifierPrefix: string,
): ImportedBindings {
	const namedBindingsByLocalName = new Map<string, string>();
	const namespaceBindings = new Set<string>();
	for (const statement of sourceFile.statements) {
		if (!ts.isImportDeclaration(statement)) continue;
		const importedModule = moduleSpecifierText(statement);
		if (
			importedModule !== moduleSpecifierPrefix &&
			importedModule?.startsWith(`${moduleSpecifierPrefix}/`) !== true
		) {
			continue;
		}
		const bindings = statement.importClause?.namedBindings;
		if (bindings !== undefined && ts.isNamedImports(bindings)) {
			for (const element of bindings.elements) {
				namedBindingsByLocalName.set(
					element.name.text,
					(element.propertyName ?? element.name).text,
				);
			}
		} else if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
			namespaceBindings.add(bindings.name.text);
		}
	}
	return { namedBindings: namedBindingsByLocalName, namespaceBindings };
}

function sourceImportsNamedBinding(
	sourceFile: ts.SourceFile,
	moduleSpecifier: string,
	importedName: string,
): boolean {
	return [...importedBindingsFrom(sourceFile, moduleSpecifier).namedBindings.values()].includes(
		importedName,
	);
}

function importedCallName(node: ts.CallExpression, bindings: ImportedBindings): string | undefined {
	if (ts.isIdentifier(node.expression)) {
		return bindings.namedBindings.get(node.expression.text);
	}
	if (
		ts.isPropertyAccessExpression(node.expression) &&
		ts.isIdentifier(node.expression.expression) &&
		bindings.namespaceBindings.has(node.expression.expression.text)
	) {
		return node.expression.name.text;
	}
	return undefined;
}

function hasExportModifier(node: ts.Node): boolean {
	return (
		ts.canHaveModifiers(node) &&
		(ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ??
			false)
	);
}

function callChainNames(node: ts.CallExpression): readonly string[] {
	const names: string[] = [];
	let currentNode: ts.Expression = node;
	while (ts.isCallExpression(currentNode)) {
		const expression = currentNode.expression;
		if (ts.isPropertyAccessExpression(expression)) {
			names.push(expression.name.text);
			currentNode = expression.expression;
			continue;
		}
		if (ts.isIdentifier(expression)) {
			names.push(expression.text);
		}
		break;
	}
	return names;
}

function enclosingFunctionName(node: ts.Node): string | undefined {
	let currentNode = node.parent;
	while (currentNode !== undefined) {
		if (
			(ts.isFunctionDeclaration(currentNode) || ts.isMethodDeclaration(currentNode)) &&
			currentNode.name !== undefined
		) {
			return currentNode.name.getText();
		}
		if (
			ts.isVariableDeclaration(currentNode) &&
			ts.isIdentifier(currentNode.name) &&
			currentNode.initializer !== undefined &&
			(ts.isArrowFunction(currentNode.initializer) ||
				ts.isFunctionExpression(currentNode.initializer))
		) {
			return currentNode.name.text;
		}
		currentNode = currentNode.parent;
	}
	return undefined;
}

function isExactInferredCommandAlias(
	node: ts.TypeAliasDeclaration,
	commandTypeAlias: string,
	rootParserName: string,
	hasImportedInferValue: boolean,
): boolean {
	if (
		node.name.text !== commandTypeAlias ||
		!hasExportModifier(node) ||
		!hasImportedInferValue ||
		!ts.isTypeReferenceNode(node.type)
	) {
		return false;
	}
	if (!ts.isIdentifier(node.type.typeName) || node.type.typeName.text !== 'InferValue') {
		return false;
	}
	const [typeArgument] = node.type.typeArguments ?? [];
	return (
		typeArgument !== undefined &&
		ts.isTypeQueryNode(typeArgument) &&
		ts.isIdentifier(typeArgument.exprName) &&
		typeArgument.exprName.text === rootParserName
	);
}

function isRuntimeImportDeclaration(node: ts.ImportDeclaration): boolean {
	const importClause = node.importClause;
	if (importClause === undefined) return true;
	if (importClause.isTypeOnly) return false;
	if (importClause.name !== undefined) return true;
	const namedBindings = importClause.namedBindings;
	if (namedBindings === undefined || ts.isNamespaceImport(namedBindings)) return true;
	return namedBindings.elements.some((element) => !element.isTypeOnly);
}

function isApprovedDomainSchemaImport(node: ts.ImportDeclaration, importedModule: string): boolean {
	const namedBindings = node.importClause?.namedBindings;
	return (
		(importedModule.startsWith('.') || importedModule.startsWith('@agent-vm/')) &&
		namedBindings !== undefined &&
		ts.isNamedImports(namedBindings) &&
		namedBindings.elements.every(
			(element) =>
				element.isTypeOnly || /schema$/iu.test((element.propertyName ?? element.name).text),
		)
	);
}

function isApprovedParserRuntimeModule(importedModule: string): boolean {
	return (
		importedModule === '@optique/core' ||
		importedModule.startsWith('@optique/core/') ||
		importedModule === '@optique/zod' ||
		importedModule === 'node:path' ||
		importedModule === 'zod'
	);
}

function isPresenceOnlyFlagDefault(
	node: ts.CallExpression,
	optiqueCoreBindings: ImportedBindings,
): boolean {
	const [parserArgument, defaultArgument] = node.arguments;
	return (
		importedCallName(node, optiqueCoreBindings) === 'withDefault' &&
		parserArgument !== undefined &&
		ts.isCallExpression(parserArgument) &&
		importedCallName(parserArgument, optiqueCoreBindings) === 'flag' &&
		defaultArgument?.kind === ts.SyntaxKind.FalseKeyword
	);
}

function nodeContainsImportedCall(
	node: ts.Node,
	bindings: ImportedBindings,
	name: string,
): boolean {
	let containsCall = false;
	const visit = (candidate: ts.Node): void => {
		if (containsCall) return;
		if (ts.isCallExpression(candidate) && importedCallName(candidate, bindings) === name) {
			containsCall = true;
			return;
		}
		ts.forEachChild(candidate, visit);
	};
	visit(node);
	return containsCall;
}

function projectionSchemaExpression(node: ts.CallExpression): ts.Expression | undefined {
	const [firstArgument] = node.arguments;
	if (firstArgument === undefined) return undefined;
	if (!ts.isObjectLiteralExpression(firstArgument)) return firstArgument;
	for (const property of firstArgument.properties) {
		if (
			ts.isPropertyAssignment(property) &&
			property.name.getText() === 'schema' &&
			ts.isExpression(property.initializer)
		) {
			return property.initializer;
		}
		if (ts.isShorthandPropertyAssignment(property) && property.name.text === 'schema') {
			return property.name;
		}
	}
	return undefined;
}

function zodSchemaExpressions(
	node: ts.CallExpression,
	optiqueZodBindings: ImportedBindings,
): readonly ts.Expression[] {
	const schemaExpressions: ts.Expression[] = [];
	const visit = (child: ts.Node): void => {
		if (ts.isCallExpression(child) && importedCallName(child, optiqueZodBindings) === 'zod') {
			const [schemaExpression] = child.arguments;
			if (schemaExpression !== undefined) schemaExpressions.push(schemaExpression);
		}
		ts.forEachChild(child, visit);
	};
	visit(node);
	return schemaExpressions;
}

function isProcessArgvExpression(node: ts.Expression): boolean {
	return (
		ts.isPropertyAccessExpression(node) &&
		ts.isIdentifier(node.expression) &&
		node.expression.text === 'process' &&
		node.name.text === 'argv'
	);
}

function isAllowedExecutableIdentityRead(
	node: ts.ElementAccessExpression,
	entry: OptiqueCliBoundaryInventoryEntry,
	sourceFile: ts.SourceFile,
): boolean {
	const parent = node.parent;
	const isWrite =
		(parent !== undefined &&
			ts.isBinaryExpression(parent) &&
			parent.left === node &&
			parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
			parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
		(parent !== undefined &&
			(ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
			parent.operand === node &&
			(parent.operator === ts.SyntaxKind.PlusPlusToken ||
				parent.operator === ts.SyntaxKind.MinusMinusToken)) ||
		(parent !== undefined && ts.isDeleteExpression(parent));
	return (
		!isWrite &&
		sourceFile.fileName === entry.executableRoot &&
		isProcessArgvExpression(node.expression) &&
		ts.isNumericLiteral(node.argumentExpression) &&
		node.argumentExpression.text === '1'
	);
}

function isManualProcessArgvSlice(node: ts.CallExpression): boolean {
	return (
		ts.isPropertyAccessExpression(node.expression) &&
		node.expression.name.text === 'slice' &&
		isProcessArgvExpression(node.expression.expression)
	);
}

function compareFindings(
	left: OptiqueCliBoundaryAuditFinding,
	right: OptiqueCliBoundaryAuditFinding,
): number {
	return (
		left.executableName.localeCompare(right.executableName) ||
		left.filePath.localeCompare(right.filePath) ||
		left.line - right.line ||
		left.reason.localeCompare(right.reason)
	);
}

async function readSourceFile(repositoryRoot: string, filePath: string): Promise<ts.SourceFile> {
	const normalizedFilePath = normalizeFilePath(filePath);
	return ts.createSourceFile(
		normalizedFilePath,
		await readFile(path.join(repositoryRoot, normalizedFilePath), 'utf8'),
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
}

function isParserModule(
	entry: OptiqueCliBoundaryInventoryEntry,
	sourceFile: ts.SourceFile,
): boolean {
	if (
		sourceFile.fileName === entry.executableRoot ||
		DISPATCHER_OR_OPERATION_FILE_NAME_PATTERN.test(sourceFile.fileName)
	) {
		return false;
	}
	return (
		entry.parserFiles.includes(sourceFile.fileName) ||
		PARSER_FILE_NAME_PATTERN.test(sourceFile.fileName) ||
		[...sourceFile.statements].some(
			(statement) =>
				ts.isImportDeclaration(statement) &&
				['cmd-ts', '@optique/core', '@optique/zod'].includes(moduleSpecifierText(statement) ?? ''),
		)
	);
}

function auditInventoryEntry(
	entry: OptiqueCliBoundaryInventoryEntry,
	sourceFiles: ReadonlyMap<string, ts.SourceFile>,
	reachableFiles: readonly string[],
): readonly OptiqueCliBoundaryAuditFinding[] {
	const findings: OptiqueCliBoundaryAuditFinding[] = [];
	const findingKeys = new Set<string>();
	const rootSourceFile = sourceFiles.get(entry.executableRoot);
	if (rootSourceFile === undefined) {
		return [
			{
				executableName: entry.executableName,
				filePath: entry.executableRoot,
				line: 1,
				reason: 'configured executable root is missing',
			},
		];
	}
	const insertFinding = (sourceFile: ts.SourceFile, node: ts.Node, reason: string): void => {
		const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
		const findingKey = `${sourceFile.fileName}\0${String(line)}\0${reason}`;
		if (findingKeys.has(findingKey)) return;
		findingKeys.add(findingKey);
		findings.push({
			executableName: entry.executableName,
			filePath: sourceFile.fileName,
			line,
			reason,
		});
	};

	const rootRunBindings = importedBindingsFrom(rootSourceFile, '@optique/run');
	const rootImportsRun = [...rootRunBindings.namedBindings.values()].includes('run');
	let rootCallsRun = false;
	let hasExactCommandAlias = false;
	let importsOptiqueZod = false;
	for (const reachableFile of reachableFiles) {
		const sourceFile = sourceFiles.get(reachableFile);
		if (sourceFile === undefined) continue;
		const optiqueCoreBindings = importedBindingsFromPrefix(sourceFile, '@optique/core');
		const optiqueZodBindings = importedBindingsFrom(sourceFile, '@optique/zod');
		const cmdTsBindings = importedBindingsFrom(sourceFile, 'cmd-ts');
		const parserModule = isParserModule(entry, sourceFile);
		const cliArchitectureModule = sourceFile.fileName === entry.executableRoot || parserModule;
		if (parserModule) {
			importsOptiqueZod ||= [...optiqueZodBindings.namedBindings.values()].includes('zod');
		}
		const hasImportedInferValue =
			optiqueCoreBindings.namedBindings.get('InferValue') === 'InferValue';

		const visit = (node: ts.Node): void => {
			if (parserModule && ts.isStringLiteralLike(node) && /\bdefault\s*:/iu.test(node.text)) {
				insertFinding(
					sourceFile,
					node,
					'fixed default literal must appear only in its Zod schema declaration',
				);
			}
			if (ts.isImportDeclaration(node)) {
				const importedModule = moduleSpecifierText(node);
				const importedLocalFilePath =
					importedModule?.startsWith('.') === true
						? localTypeScriptImportPath(sourceFile.fileName, importedModule)
						: undefined;
				const importedLocalSourceFile =
					importedLocalFilePath === undefined ? undefined : sourceFiles.get(importedLocalFilePath);
				if (importedModule === 'cmd-ts') {
					insertFinding(sourceFile, node, 'active parser imports forbidden cmd-ts');
				}
				if (
					importedModule === 'node:util' &&
					sourceImportsNamedBinding(sourceFile, 'node:util', 'parseArgs')
				) {
					insertFinding(sourceFile, node, 'active parser imports forbidden node:util parseArgs');
				}
				if (parserModule && isRuntimeImportDeclaration(node) && importedModule !== undefined) {
					if (
						importedLocalFilePath !== undefined &&
						(importedLocalSourceFile === undefined ||
							!isParserModule(entry, importedLocalSourceFile)) &&
						!isApprovedDomainSchemaImport(node, importedModule)
					) {
						insertFinding(sourceFile, node, `parser module imports effect owner ${importedModule}`);
					} else if (
						importedLocalFilePath === undefined &&
						!isApprovedParserRuntimeModule(importedModule) &&
						!isApprovedDomainSchemaImport(node, importedModule)
					) {
						const ownerKind = NODE_EFFECT_OWNER_IMPORT_PATTERN.test(importedModule)
							? 'effect owner'
							: 'forbidden runtime module';
						insertFinding(sourceFile, node, `parser module imports ${ownerKind} ${importedModule}`);
					}
				}
				if (
					sourceFile.fileName === entry.executableRoot &&
					isRuntimeImportDeclaration(node) &&
					importedModule !== undefined &&
					importedModule !== '@optique/run' &&
					importedModule !== 'node:fs' &&
					importedModule !== 'node:path' &&
					importedModule !== 'node:url' &&
					!(
						importedLocalSourceFile !== undefined &&
						(isParserModule(entry, importedLocalSourceFile) ||
							(DISPATCHER_OR_OPERATION_FILE_NAME_PATTERN.test(importedLocalFilePath ?? '') &&
								/(?:dispatcher)[.]ts$/u.test(importedLocalFilePath ?? '')) ||
							ROOT_SUPPORT_FILE_NAME_PATTERN.test(importedLocalFilePath ?? ''))
					)
				) {
					insertFinding(
						sourceFile,
						node,
						`executable root imports forbidden owner ${importedModule}`,
					);
				}
			}
			if (cliArchitectureModule && ts.isTypeAliasDeclaration(node)) {
				if (
					isExactInferredCommandAlias(
						node,
						entry.commandTypeAlias,
						entry.rootParserName,
						hasImportedInferValue,
					)
				) {
					hasExactCommandAlias = true;
				} else if (node.name.text === entry.commandTypeAlias) {
					insertFinding(
						sourceFile,
						node,
						`command alias must export exactly imported InferValue<typeof ${entry.rootParserName}>`,
					);
				} else if (
					ts.isUnionTypeNode(node.type) &&
					/(?:Command|CliArguments)$/u.test(node.name.text)
				) {
					insertFinding(
						sourceFile,
						node,
						'handwritten command union is forbidden; use the root parser InferValue alias',
					);
				}
				if (CUSTOM_EXIT_PROTOCOL_NAME_PATTERN.test(node.name.text)) {
					insertFinding(sourceFile, node, 'custom runner or exit protocol is forbidden');
				}
			}
			if (
				cliArchitectureModule &&
				(ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
				node.name !== undefined &&
				CUSTOM_EXIT_PROTOCOL_NAME_PATTERN.test(node.name.text)
			) {
				insertFinding(sourceFile, node, 'custom runner or exit protocol is forbidden');
			}
			if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
				if (MANUAL_PARSER_NAME_PATTERN.test(node.name.text)) {
					insertFinding(
						sourceFile,
						node,
						`manual argv parser ${node.name.text} is forbidden in an active CLI`,
					);
				}
				const acceptsArgv = node.parameters.some(
					(parameter) =>
						ts.isIdentifier(parameter.name) && /^(?:argv|arguments_)$/u.test(parameter.name.text),
				);
				if (
					cliArchitectureModule &&
					acceptsArgv &&
					(/^(?:run|execute)\w*Cli/u.test(node.name.text) ||
						/(?:Exit|Protocol)/u.test(node.name.text))
				) {
					insertFinding(sourceFile, node, 'custom runner or exit protocol is forbidden');
				}
			}
			if (
				parserModule &&
				ts.isPropertyAccessExpression(node) &&
				(node.name.text === '_def' || node.name.text === '_zod')
			) {
				insertFinding(sourceFile, node, 'private Zod _def/_zod representation access is forbidden');
			}
			if (
				cliArchitectureModule &&
				ts.isPropertyAssignment(node) &&
				node.name.getText(sourceFile) === 'onExit'
			) {
				insertFinding(sourceFile, node, 'custom runner onExit protocol is forbidden');
			}
			if (
				isProcessArgvExpression(node) &&
				!(
					ts.isElementAccessExpression(node.parent) &&
					node.parent.expression === node &&
					isAllowedExecutableIdentityRead(node.parent, entry, sourceFile)
				)
			) {
				insertFinding(sourceFile, node, 'manual process.argv access is forbidden');
			}
			if (ts.isCallExpression(node)) {
				const optiqueCoreCallName = importedCallName(node, optiqueCoreBindings);
				const cmdTsCallName = importedCallName(node, cmdTsBindings);
				const localCallName = ts.isIdentifier(node.expression) ? node.expression.text : undefined;
				if (parserModule && localCallName === 'projectZodScalarPresence') {
					const projectedSchemaExpression = projectionSchemaExpression(node);
					const providedTokenSchemaExpressions = zodSchemaExpressions(node, optiqueZodBindings);
					if (
						projectedSchemaExpression === undefined ||
						!ts.isIdentifier(projectedSchemaExpression) ||
						providedTokenSchemaExpressions.length === 0 ||
						providedTokenSchemaExpressions.some(
							(schemaExpression) =>
								!ts.isIdentifier(schemaExpression) ||
								schemaExpression.text !== projectedSchemaExpression.text,
						)
					) {
						insertFinding(
							sourceFile,
							node,
							'presence projection and zod() must reuse the exact named Zod schema object',
						);
					}
				}
				if (
					sourceFile.fileName === entry.executableRoot &&
					importedCallName(node, rootRunBindings) === 'run'
				) {
					rootCallsRun = true;
				}
				const prohibitedRunnerName =
					optiqueCoreCallName === 'runParser'
						? 'runParser'
						: cmdTsCallName === 'runSafely'
							? 'runSafely'
							: undefined;
				if (prohibitedRunnerName !== undefined) {
					insertFinding(sourceFile, node, `production ${prohibitedRunnerName} call is forbidden`);
				}
				if (isManualProcessArgvSlice(node)) {
					insertFinding(
						sourceFile,
						node,
						'manual argv parsing through process.argv.slice is forbidden',
					);
				}
				if (
					node.arguments.some(
						(argument) => ts.isExpression(argument) && isProcessArgvExpression(argument),
					) &&
					importedCallName(node, rootRunBindings) !== 'run'
				) {
					insertFinding(sourceFile, node, 'manual argv consumer receives process.argv');
				}
				const chainNames = callChainNames(node);
				if (chainNames.includes('optional') && chainNames.includes('default')) {
					insertFinding(sourceFile, node, 'CLI schema mixes ZodOptional and ZodDefault wrappers');
				}
				if (
					parserModule &&
					optiqueCoreCallName !== undefined &&
					['optional', 'withDefault', 'multiple'].includes(optiqueCoreCallName)
				) {
					const functionName = enclosingFunctionName(node);
					const allowedProjection =
						optiqueCoreCallName === 'multiple'
							? functionName === 'projectZodRepeatedOption'
							: functionName === 'projectZodScalarPresence' ||
								functionName === 'projectZodRepeatedOption';
					if (!allowedProjection && !isPresenceOnlyFlagDefault(node, optiqueCoreBindings)) {
						insertFinding(
							sourceFile,
							node,
							`${optiqueCoreCallName} duplicates schema-owned presence outside an admitted projection`,
						);
					}
					if (
						optiqueCoreCallName === 'multiple' &&
						allowedProjection &&
						!node.arguments.some(
							(argument) =>
								ts.isObjectLiteralExpression(argument) &&
								argument.properties.some(
									(property) =>
										ts.isPropertyAssignment(property) &&
										property.name.getText(sourceFile) === 'min' &&
										property.initializer.getText(sourceFile) === '1',
								),
						)
					) {
						insertFinding(
							sourceFile,
							node,
							'multiple inside a repeated projection must preserve absence with min: 1',
						);
					}
				}
				if (
					parserModule &&
					optiqueCoreCallName !== undefined &&
					['argument', 'option', 'positional'].includes(optiqueCoreCallName) &&
					!nodeContainsImportedCall(node, optiqueZodBindings, 'zod')
				) {
					insertFinding(
						sourceFile,
						node,
						'value parser bypasses @optique/zod for its provided token',
					);
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(sourceFile);
	}

	if (!rootImportsRun) {
		insertFinding(
			rootSourceFile,
			rootSourceFile,
			'executable root must import run from @optique/run',
		);
	}
	if (!rootCallsRun) {
		insertFinding(
			rootSourceFile,
			rootSourceFile,
			'executable root must call run from @optique/run',
		);
	}
	if (!hasExactCommandAlias) {
		insertFinding(
			rootSourceFile,
			rootSourceFile,
			`active CLI must export ${entry.commandTypeAlias} as exactly InferValue<typeof ${entry.rootParserName}>`,
		);
	}
	if (entry.valueBearing && !importsOptiqueZod) {
		insertFinding(
			rootSourceFile,
			rootSourceFile,
			'value-bearing parser must import zod from @optique/zod',
		);
	}
	return findings;
}

export async function auditOptiqueCliBoundaries(
	props: AuditOptiqueCliBoundariesProps,
): Promise<readonly OptiqueCliBoundaryAuditFinding[]> {
	const sourceFiles = new Map<string, ts.SourceFile>();
	const expandedInventory = await Promise.all(
		props.inventory.map(async (entry) => {
			const reachableFiles = await loadReachableCliFiles(props.repositoryRoot, entry, sourceFiles);
			return { entry, reachableFiles };
		}),
	);
	const allFiles = new Set<string>(props.additionalExportFiles ?? []);
	await Promise.all(
		[...allFiles].map(async (filePath) => {
			sourceFiles.set(filePath, await readSourceFile(props.repositoryRoot, filePath));
		}),
	);
	const findings = expandedInventory.flatMap(({ entry, reachableFiles }) =>
		auditInventoryEntry(entry, sourceFiles, reachableFiles),
	);
	for (const filePath of props.additionalExportFiles ?? []) {
		const sourceFile = sourceFiles.get(filePath);
		if (sourceFile === undefined) continue;
		let hasRetiredParserExport = false;
		const visit = (node: ts.Node): void => {
			if (
				(ts.isIdentifier(node) || ts.isStringLiteralLike(node)) &&
				node.text === 'parsePortalServerCliArgs'
			) {
				hasRetiredParserExport = true;
			}
			ts.forEachChild(node, visit);
		};
		visit(sourceFile);
		if (hasRetiredParserExport) {
			findings.push({
				executableName: 'mcp-portal',
				filePath,
				line: 1,
				reason: 'retired parsePortalServerCliArgs export remains active',
			});
		}
	}
	return findings.toSorted(compareFindings);
}

function localTypeScriptImportPath(sourceFilePath: string, importedModule: string): string {
	const resolvedImport = normalizeFilePath(path.join(path.dirname(sourceFilePath), importedModule));
	if (/[.](?:c|m)?js$/u.test(resolvedImport)) {
		return resolvedImport.replace(/[.](?:c|m)?js$/u, '.ts');
	}
	return `${resolvedImport}.ts`;
}

async function loadReachableCliFiles(
	repositoryRoot: string,
	entry: OptiqueCliBoundaryInventoryEntry,
	sourceFiles: Map<string, ts.SourceFile>,
): Promise<readonly string[]> {
	const visitedFiles = new Set<string>();
	const explicitParserFiles = new Set(entry.parserFiles);
	const visitFile = async (filePath: string, required: boolean): Promise<void> => {
		if (visitedFiles.has(filePath)) return;
		visitedFiles.add(filePath);
		let sourceFile: ts.SourceFile;
		try {
			sourceFile = await readSourceFile(repositoryRoot, filePath);
		} catch (error: unknown) {
			if (required) throw error;
			return;
		}
		sourceFiles.set(filePath, sourceFile);
		const localImports = sourceFile.statements.flatMap((statement) => {
			if (!ts.isImportDeclaration(statement)) return [];
			const importedModule = moduleSpecifierText(statement);
			return importedModule?.startsWith('.') === true
				? [localTypeScriptImportPath(filePath, importedModule)]
				: [];
		});
		await Promise.all(
			localImports.map(async (importedFile) => await visitFile(importedFile, false)),
		);
	};
	await Promise.all([
		visitFile(entry.executableRoot, true),
		...entry.parserFiles.map(
			async (parserFile) => await visitFile(parserFile, explicitParserFiles.has(parserFile)),
		),
	]);
	return [...visitedFiles].filter((filePath) => sourceFiles.has(filePath)).toSorted();
}

async function listProductionTypeScriptFiles(
	repositoryRoot: string,
	relativeDirectory: string,
): Promise<readonly string[]> {
	const directoryEntries = await readdir(path.join(repositoryRoot, relativeDirectory), {
		withFileTypes: true,
	});
	const files: string[] = [];
	const discoveredFiles = await Promise.all(
		directoryEntries.map(async (directoryEntry): Promise<readonly string[]> => {
			const relativePath = normalizeFilePath(path.join(relativeDirectory, directoryEntry.name));
			if (directoryEntry.isDirectory()) {
				return await listProductionTypeScriptFiles(repositoryRoot, relativePath);
			}
			return directoryEntry.isFile() &&
				relativePath.endsWith('.ts') &&
				!/[.](?:test|spec)[.]ts$/u.test(relativePath)
				? [relativePath]
				: [];
		}),
	);
	files.push(...discoveredFiles.flat());
	return files;
}

async function discoverParserFiles(
	repositoryRoot: string,
	seed: DefaultInventorySeed,
): Promise<readonly string[]> {
	const candidateFiles = new Set<string>([seed.executableRoot]);
	const searchRootFiles = (
		await Promise.all(
			seed.parserSearchRoots.map(
				async (searchRoot) => await listProductionTypeScriptFiles(repositoryRoot, searchRoot),
			),
		)
	).flat();
	await Promise.all(
		searchRootFiles.map(async (filePath) => {
			if (PARSER_FILE_NAME_PATTERN.test(filePath)) {
				candidateFiles.add(filePath);
				return;
			}
			const sourceText = await readFile(path.join(repositoryRoot, filePath), 'utf8');
			if (PARSER_SOURCE_MARKER_PATTERN.test(sourceText)) candidateFiles.add(filePath);
		}),
	);
	return [...candidateFiles].toSorted();
}

export async function auditRepositoryOptiqueCliBoundaries(
	repositoryRoot: string = process.cwd(),
): Promise<readonly OptiqueCliBoundaryAuditFinding[]> {
	const inventory = await Promise.all(
		DEFAULT_INVENTORY_SEEDS.map(async (seed) => ({
			commandTypeAlias: seed.commandTypeAlias,
			executableName: seed.executableName,
			executableRoot: seed.executableRoot,
			parserFiles: await discoverParserFiles(repositoryRoot, seed),
			rootParserName: seed.rootParserName,
			valueBearing: seed.valueBearing,
		})),
	);
	return await auditOptiqueCliBoundaries({
		additionalExportFiles: DEFAULT_EXPORT_FILES,
		inventory,
		repositoryRoot,
	});
}

async function main(): Promise<void> {
	const findings = await auditRepositoryOptiqueCliBoundaries();
	if (findings.length === 0) {
		process.stdout.write('Optique CLI architecture audit passed for 5 active roots.\n');
		return;
	}
	process.stderr.write(
		findings
			.map(
				(finding) =>
					`${finding.executableName}: ${finding.filePath}:${String(finding.line)}: ${finding.reason}`,
			)
			.join('\n') + '\n',
	);
	process.exitCode = 1;
}

if (
	process.argv[1] !== undefined &&
	pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
	await main();
}
