import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import { afterEach, describe, expect, it } from 'vitest';

import { compileCatalogTypescriptModules } from './catalog-typescript-compiler.js';
import type { NormalizedCatalogToolDefinition } from './catalog-typescript-types.js';

interface ChildResult {
	readonly exitCode: number | null;
	readonly stderr: string;
	readonly stdout: string;
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

async function runCommand(
	command: string,
	args: readonly string[],
	cwd: string,
): Promise<ChildResult> {
	const child = spawn(command, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
	let stdout = '';
	let stderr = '';
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data', (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.on('data', (chunk: string) => {
		stderr += chunk;
	});
	await once(child, 'exit');
	return { exitCode: child.exitCode, stderr, stdout };
}

async function createConsumerRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'agent-vm-generated-consumer-'));
	temporaryDirectories.push(root);
	const packageScopeDirectory = join(root, 'node_modules', '@agent-vm');
	await mkdir(packageScopeDirectory, { recursive: true });
	await symlink(
		resolve('packages/agent-portal-sdk'),
		join(packageScopeDirectory, 'agent-portal-sdk'),
		'dir',
	);
	await writeFile(join(root, 'package.json'), '{"type":"module"}\n', 'utf8');
	return root;
}

function createCatalog(options: {
	readonly namespaceCount: number;
	readonly toolsPerNamespace: number;
}): readonly NormalizedCatalogToolDefinition[] {
	return Array.from({ length: options.namespaceCount }, (_namespaceValue, namespaceIndex) =>
		Array.from({ length: options.toolsPerNamespace }, (_toolValue, toolIndex) => ({
			inputSchema: {
				additionalProperties: false,
				properties: {
					count: { maximum: 1_000, minimum: 0, type: 'integer' },
					mode: { enum: ['quick', 'complete'] },
					query: { minLength: 1, type: 'string' },
				},
				required: ['query'],
				type: 'object',
			},
			name: `tool-${String(toolIndex)}`,
			namespace: `namespace-${String(namespaceIndex)}`,
		})),
	).flat();
}

describe('generated TypeScript namespace modules', () => {
	it('typechecks and executes emitted Node 24 erasable TypeScript through one explicit client', async () => {
		const root = await createConsumerRoot();
		const generatedDirectory = join(root, 'generated');
		await mkdir(generatedDirectory);
		const bundle = await compileCatalogTypescriptModules({
			tools: [
				{
					inputSchema: {
						$defs: { label: { type: 'string' } },
						additionalProperties: false,
						properties: {
							label: { $ref: '#/$defs/label' },
							limit: { minimum: 1, type: 'integer' },
							query: { minLength: 1, type: 'string' },
						},
						required: ['query'],
						type: 'object',
					},
					name: 'search-messages',
					namespace: 'google',
				},
				{
					inputSchema: {
						$defs: { label: { type: 'number' } },
						additionalProperties: false,
						properties: { label: { $ref: '#/$defs/label' } },
						type: 'object',
					},
					name: 'lookup-contacts',
					namespace: 'google',
				},
			],
		});
		const generatedFile = bundle.files[0];
		const namespaceManifest = bundle.manifest.namespaces[0];
		if (generatedFile === undefined || namespaceManifest === undefined) {
			throw new Error('Expected one generated namespace.');
		}
		await writeFile(join(generatedDirectory, generatedFile.path), generatedFile.source, 'utf8');
		const consumerSource = `
import { ToolPortalMcpClient, type ToolPortalMcpTransport } from '@agent-vm/agent-portal-sdk/tool-portal-mcp-client';
import { ${namespaceManifest.exportedFactoryName} } from './generated/${generatedFile.path}';

const seenCalls: unknown[] = [];
const transport: ToolPortalMcpTransport = {
	async callTool(call, options) {
		seenCalls.push({ call, hasSignal: options?.signal !== undefined });
		return { structuredContent: {
			auditCorrelationId: 'audit-generated',
			items: [{
				id: 'response-item',
				operationId: 'operation-generated',
				outcome: { certainty: 'proven', completion: 'succeeded', kind: 'completed', retryClass: 'forbidden' },
				owningGeneration: 'generation-generated',
				status: 'ok',
				value: { matches: 3 },
			}],
			ok: true,
		} };
	},
	async close() {},
	async connect() {},
	async readResource() { return { contents: [] }; },
};
const client = new ToolPortalMcpClient({ transport });
const tools = ${namespaceManifest.exportedFactoryName}(client);
if (false) {
	// @ts-expect-error query is required by the generated input type.
	void tools.searchMessages({ limit: 2 });
}
const result = await tools.searchMessages({ limit: 2, query: 'newer_than:1d' }, { signal: new AbortController().signal });
console.log(JSON.stringify({ auditCorrelationId: result.auditCorrelationId, seenCalls }));
`;
		await writeFile(join(root, 'consumer.ts'), consumerSource, 'utf8');

		const typecheck = await runCommand(
			resolve('node_modules/.bin/tsc'),
			[
				'--noEmit',
				'--allowImportingTsExtensions',
				'--target',
				'ES2024',
				'--module',
				'NodeNext',
				'--moduleResolution',
				'NodeNext',
				'--strict',
				'--skipLibCheck',
				'consumer.ts',
			],
			root,
		);
		expect(typecheck, typecheck.stderr || typecheck.stdout).toMatchObject({ exitCode: 0 });

		const execution = await runCommand(process.execPath, ['consumer.ts'], root);
		expect(execution, execution.stderr).toMatchObject({ exitCode: 0 });
		const observed: unknown = JSON.parse(execution.stdout.trim());
		expect(observed).toMatchObject({
			auditCorrelationId: 'audit-generated',
			seenCalls: [
				{
					call: {
						arguments: {
							calls: [
								{
									arguments: { limit: 2, query: 'newer_than:1d' },
									name: 'search-messages',
									namespace: 'google',
								},
							],
						},
						name: 'tool_portal_call',
					},
					hasSignal: true,
				},
			],
		});
	});

	it('records small/large cold, unchanged, changed, size, namespace import, and memory costs', async () => {
		const smallCatalog = createCatalog({ namespaceCount: 2, toolsPerNamespace: 3 });
		const largeCatalog = createCatalog({ namespaceCount: 24, toolsPerNamespace: 12 });
		const heapBefore = process.memoryUsage().heapUsed;
		const smallStart = performance.now();
		const small = await compileCatalogTypescriptModules({ tools: smallCatalog });
		const smallDurationMs = performance.now() - smallStart;
		const largeStart = performance.now();
		const large = await compileCatalogTypescriptModules({ tools: largeCatalog });
		const largeDurationMs = performance.now() - largeStart;
		const unchangedStart = performance.now();
		const unchanged = await compileCatalogTypescriptModules({ tools: largeCatalog });
		const unchangedDurationMs = performance.now() - unchangedStart;
		const changedStart = performance.now();
		const changed = await compileCatalogTypescriptModules({
			tools: [...largeCatalog, ...createCatalog({ namespaceCount: 1, toolsPerNamespace: 1 })].map(
				(tool, index) =>
					index === largeCatalog.length ? { ...tool, namespace: 'changed-namespace' } : tool,
			),
		});
		const changedDurationMs = performance.now() - changedStart;
		const heapDeltaBytes = process.memoryUsage().heapUsed - heapBefore;
		const largeBytes = large.files.reduce((total, file) => total + file.byteLength, 0);
		const selectedNamespaceBytes = large.files[0]?.byteLength ?? 0;

		expect(small.files).toHaveLength(2);
		expect(large.files).toHaveLength(24);
		expect(unchanged).toEqual(large);
		expect(changed.definitionFingerprint).not.toBe(large.definitionFingerprint);
		expect(selectedNamespaceBytes).toBeLessThan(largeBytes);
		process.stdout.write(
			`${JSON.stringify({
				changedDurationMs,
				heapDeltaBytes,
				largeBytes,
				largeDurationMs,
				largeTools: largeCatalog.length,
				selectedNamespaceBytes,
				smallBytes: small.files.reduce((total, file) => total + file.byteLength, 0),
				smallDurationMs,
				smallTools: smallCatalog.length,
				unchangedDurationMs,
			})}\n`,
		);
	});
});
