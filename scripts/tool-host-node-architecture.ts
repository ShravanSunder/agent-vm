/// <reference types="node" />

import path from 'node:path';

import ts from 'typescript';

import type { PortalArchitectureSourceFile } from './audit-portal-architecture.js';
function normalizedFilePath(filePath: string): string {
	return filePath.split(path.sep).join('/');
}
function isTestSourceFile(filePath: string): boolean {
	return /\.(?:unit|integration|host\.e2e|vm\.e2e|hermes\.e2e|secrets\.e2e|llm\.e2e)\.(?:test|spec)\.ts$/u.test(
		filePath,
	);
}
export function isForbiddenToolHostNodeImport(specifier: string): boolean {
	const scoped = /(?:^|\/)(@agent-vm\/[^/]+)/u.exec(specifier)?.[1];
	return (
		(scoped !== undefined &&
			!['@agent-vm/oauth-broker-contracts', '@agent-vm/agent-portal-sdk'].includes(scoped)) ||
		/(?:^|\/)(?:agent-vm|managed-vm|gondolin(?:-vm-adapter)?|secret-management|tool-portal|mcp-portal|gateway-runtime)(?:\/|$)/u.test(
			specifier,
		) ||
		specifier.startsWith('@gondolin/') ||
		specifier.startsWith('@earendil-works/gondolin')
	);
}
export function isNodeHostTestingEntry(specifier: string): boolean {
	return (
		/^(?:@agent-collaboration\/tool-host-node\/testing|#node-host\/testing)(?:\/|$)/u.test(
			specifier,
		) || /\/@agent-collaboration\/tool-host-node\/(?:src|dist)\/testing\//u.test(specifier)
	);
}
export function isNodeHostTestingDependency(specifier: string): boolean {
	return (
		/^(?:hono(?:\/|$)|@hono\/node-server(?:\/|$))/u.test(specifier) ||
		isNodeHostTestingEntry(specifier)
	);
}
export function collectToolHostNodeViolations(
	file: PortalArchitectureSourceFile,
): readonly string[] {
	const filePath = normalizedFilePath(file.filePath);
	if (!filePath.startsWith('packages/tool-host-node/src/') || isTestSourceFile(filePath)) return [];
	const violations: string[] = [];
	const testSupport = filePath.startsWith('packages/tool-host-node/src/testing/');
	const source = ts.createSourceFile(filePath, file.sourceText, ts.ScriptTarget.Latest, true);
	function visit(node: ts.Node): void {
		const inbound =
			filePath.startsWith('packages/tool-host-node/src/mcp-proxy-server/') ||
			filePath.startsWith('packages/tool-host-node/src/standalone-tool-portal/');
		if (
			inbound &&
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			/session/iu.test(node.name.text) &&
			node.initializer !== undefined &&
			ts.isNewExpression(node.initializer) &&
			ts.isIdentifier(node.initializer.expression) &&
			node.initializer.expression.text === 'Map'
		)
			violations.push(`${filePath}: inbound MCP protocol session map is forbidden`);
		if (
			inbound &&
			((ts.isStringLiteral(node) && node.text.toLowerCase() === 'mcp-session-id') ||
				(ts.isIdentifier(node) && node.text === 'sessionIdGenerator'))
		)
			violations.push(`${filePath}: inbound MCP protocol session reuse is forbidden`);
		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier !== undefined &&
			ts.isStringLiteral(node.moduleSpecifier) &&
			(isForbiddenToolHostNodeImport(node.moduleSpecifier.text) ||
				(!testSupport && isNodeHostTestingDependency(node.moduleSpecifier.text)))
		)
			violations.push(`${filePath}: tool-host-node forbidden import ${node.moduleSpecifier.text}`);
		if (
			ts.isImportEqualsDeclaration(node) &&
			ts.isExternalModuleReference(node.moduleReference) &&
			node.moduleReference.expression !== undefined &&
			ts.isStringLiteral(node.moduleReference.expression) &&
			(isForbiddenToolHostNodeImport(node.moduleReference.expression.text) ||
				(!testSupport && isNodeHostTestingDependency(node.moduleReference.expression.text)))
		)
			violations.push(
				`${filePath}: tool-host-node forbidden import ${node.moduleReference.expression.text}`,
			);
		if (
			ts.isImportTypeNode(node) &&
			ts.isLiteralTypeNode(node.argument) &&
			ts.isStringLiteral(node.argument.literal) &&
			(isForbiddenToolHostNodeImport(node.argument.literal.text) ||
				(!testSupport && isNodeHostTestingDependency(node.argument.literal.text)))
		)
			violations.push(
				`${filePath}: tool-host-node forbidden type import ${node.argument.literal.text}`,
			);
		if (ts.isIdentifier(node) && node.text.startsWith('GatewayRuntime'))
			violations.push(`${filePath}: tool-host-node managed type ${node.text}`);
		if (
			ts.isCallExpression(node) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) && node.expression.text === 'require'))
		) {
			const argument = node.arguments[0];
			if (
				argument !== undefined &&
				ts.isStringLiteral(argument) &&
				(isForbiddenToolHostNodeImport(argument.text) ||
					(!testSupport && isNodeHostTestingDependency(argument.text)))
			)
				violations.push(`${filePath}: tool-host-node forbidden import ${argument.text}`);
		}
		ts.forEachChild(node, visit);
	}
	visit(source);
	return violations;
}
