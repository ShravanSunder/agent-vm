import { readdir, readFile } from 'node:fs/promises';
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

const AUDIT_SOURCE_ROOTS = ['packages/agent-vm/src'] as const;

const LEGACY_VM_CLEANUP_ALLOWED_FILE_PATHS = new Map<string, ReadonlySet<string>>([
	[
		'cleanupOrphanedGatewayIfPresent',
		new Set(['packages/agent-vm/src/gateway/gateway-recovery.ts']),
	],
	[
		'cleanupOrphanedToolVmsIfPresent',
		new Set(['packages/agent-vm/src/controller/leases/tool-vm-recovery.ts']),
	],
	[
		'killOrphanedManagedVmProcess',
		new Set([
			'packages/agent-vm/src/controller/leases/tool-vm-recovery.ts',
			'packages/agent-vm/src/gateway/gateway-recovery.ts',
			'packages/agent-vm/src/shared/managed-vm-process.ts',
		]),
	],
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
	'pendingCleanup.vm',
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

function isDestroyLiveCall(callExpression: ts.CallExpression): boolean {
	return (
		ts.isPropertyAccessExpression(callExpression.expression) &&
		callExpression.expression.name.text === 'destroyLive'
	);
}

function isWithinDestroyLive(closeCall: ts.CallExpression): boolean {
	let ancestor: ts.Node | undefined = closeCall.parent;
	while (ancestor !== undefined) {
		if (ts.isCallExpression(ancestor) && isDestroyLiveCall(ancestor)) {
			return true;
		}
		ancestor = ancestor.parent;
	}
	return false;
}

function findContainingVariableDeclaration(node: ts.Node): ts.VariableDeclaration | undefined {
	let ancestor: ts.Node | undefined = node.parent;
	while (ancestor !== undefined && !ts.isStatement(ancestor)) {
		if (ts.isVariableDeclaration(ancestor)) {
			return ancestor;
		}
		ancestor = ancestor.parent;
	}
	return undefined;
}

function findContainingLexicalScope(node: ts.Node): ts.Block | ts.SourceFile | undefined {
	let ancestor: ts.Node | undefined = node.parent;
	while (ancestor !== undefined) {
		if (ts.isBlock(ancestor) || ts.isSourceFile(ancestor)) {
			return ancestor;
		}
		ancestor = ancestor.parent;
	}
	return undefined;
}

function isAssertedDestructionReceipt(closeCall: ts.CallExpression): boolean {
	const declaration = findContainingVariableDeclaration(closeCall);
	if (declaration === undefined || !ts.isIdentifier(declaration.name)) {
		return false;
	}
	const lexicalScope = findContainingLexicalScope(declaration);
	if (lexicalScope === undefined) {
		return false;
	}
	const receiptName = declaration.name.text;
	let asserted = false;
	const visit = (node: ts.Node): void => {
		if (asserted) {
			return;
		}
		if (node.getStart() <= closeCall.getStart()) {
			ts.forEachChild(node, visit);
			return;
		}
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === 'assertVmDestructionComplete' &&
			node.arguments.length > 0 &&
			ts.isIdentifier(node.arguments[0]) &&
			node.arguments[0].text === receiptName
		) {
			asserted = true;
			return;
		}
		ts.forEachChild(node, visit);
	};
	visit(lexicalScope);
	return asserted;
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
		findings.push({
			filePath: normalizedPath,
			line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
			reason,
		});
	};
	const visit = (node: ts.Node): void => {
		if (ts.isIdentifier(node)) {
			const allowedFilePaths = LEGACY_VM_CLEANUP_ALLOWED_FILE_PATHS.get(node.text);
			if (allowedFilePaths !== undefined && !allowedFilePaths.has(normalizedPath)) {
				insertFinding(
					node,
					`legacy VM cleanup symbol '${node.text}' is referenced outside its legacy boundary`,
				);
			}
		}
		if (ts.isCallExpression(node)) {
			const receiver = managedVmCloseReceiver(node, sourceFile);
			if (
				receiver !== undefined &&
				!isWithinDestroyLive(node) &&
				!isAssertedDestructionReceipt(node)
			) {
				insertFinding(
					node,
					`ManagedVm close '${receiver}.close()' is not protected by an ownership destruction receipt`,
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
	const findings = auditVmOwnershipBoundaries(sources);
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
