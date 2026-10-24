import ts from 'typescript';

interface BoundarySourceFile {
	readonly filePath: string;
	readonly sourceText: string;
}
const coreSourceRoot = 'packages/tool-host-core/src/';
const membershipWriters = new Set([
	'setMembership',
	'beginAgentRemoval',
	'completeAgentRemoval',
	'AgentManagementAuthority',
	'AgentClientManagementPort',
]);

/** Trace the MCP module's local import closure, including type surfaces of injected ports. */
export function collectWorkspaceMcpBoundaryViolations(
	files: readonly BoundarySourceFile[],
): readonly string[] {
	return collectLocalBoundaryViolations({
		files,
		entry: `${coreSourceRoot}hosted-mcp-proxy/hosted-mcp-proxy.ts`,
		kind: 'MCP',
	});
}

/** Production may manage membership, but it must never expose proof-only storage readbacks. */
export function collectProductionReadbackViolations(
	files: readonly BoundarySourceFile[],
): readonly string[] {
	return collectLocalBoundaryViolations({
		files,
		entry: 'packages/tool-host-cloudflare/src/index.ts',
		kind: 'production',
	});
}

function collectLocalBoundaryViolations(props: {
	readonly files: readonly BoundarySourceFile[];
	readonly entry: string;
	readonly kind: 'MCP' | 'production';
}): readonly string[] {
	const sources = new Map(props.files.map((file) => [file.filePath, file.sourceText]));
	const visited = new Set<string>();
	const pending = [props.entry];
	const violations: string[] = [];
	while (pending.length > 0) {
		const filePath = pending.pop();
		if (filePath === undefined || visited.has(filePath)) continue;
		visited.add(filePath);
		const text = sources.get(filePath);
		if (text === undefined) {
			violations.push(`${filePath}: ${props.kind} closure source unavailable`);
			continue;
		}
		const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true);
		function visit(node: ts.Node): void {
			if (ts.isIdentifier(node) || ts.isStringLiteral(node)) {
				if (props.kind === 'MCP' && membershipWriters.has(node.text))
					violations.push(`${filePath}: MCP closure reaches membership write surface ${node.text}`);
				if (
					props.kind === 'production' &&
					(node.text === 'readStoredAgentState' ||
						(ts.isStringLiteral(node) && node.text.startsWith('/__')))
				)
					violations.push(
						`${filePath}: production closure reaches proof-only readback ${node.text}`,
					);
			}
			if (
				ts.isStringLiteral(node) &&
				(ts.isImportDeclaration(node.parent) ||
					ts.isExportDeclaration(node.parent) ||
					ts.isCallExpression(node.parent) ||
					ts.isLiteralTypeNode(node.parent))
			) {
				if (props.kind === 'production' && node.text.includes('/test-fixtures/'))
					violations.push(`${filePath}: production closure imports proof fixture ${node.text}`);
				if (node.text.startsWith('#tool-host-core/'))
					pending.push(`${coreSourceRoot}${node.text.slice('#tool-host-core/'.length)}.ts`);
				if (node.text.startsWith('#worker-host/'))
					pending.push(
						`packages/tool-host-cloudflare/src/${node.text.slice('#worker-host/'.length)}.ts`,
					);
				if (node.text === '@agent-collaboration/tool-host-core')
					pending.push(`${coreSourceRoot}index.ts`);
			}
			ts.forEachChild(node, visit);
		}
		visit(source);
	}
	return [...new Set(violations)].toSorted();
}
