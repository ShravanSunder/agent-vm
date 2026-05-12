import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runAgentVmMcpPortal } from './agent-vm-mcp-portal.js';

describe('agent-vm-mcp-portal CLI', () => {
	it('validates catalog files and reports wrapper metadata errors', async () => {
		const workspace = await mkdtemp(join(tmpdir(), 'agent-vm-mcp-portal-'));
		try {
			const validCatalogPath = join(workspace, 'catalog.json');
			const invalidCatalogPath = join(workspace, 'invalid.json');
			await writeFile(
				validCatalogPath,
				JSON.stringify({
					tools: [
						{ inputSchema: { type: 'object' }, namespace: 'linear', toolName: 'create_issue' },
					],
				}),
			);
			await writeFile(
				invalidCatalogPath,
				JSON.stringify({
					tools: [
						{
							inputSchema: { type: 'object' },
							metadata: { headers: { Authorization: 'Bearer secret' } },
							namespace: 'linear',
							toolName: 'create_issue',
						},
					],
				}),
			);

			expect(await runAgentVmMcpPortal(['validate', validCatalogPath])).toBe(0);
			expect(await runAgentVmMcpPortal(['validate', invalidCatalogPath])).toBe(1);
		} finally {
			await rm(workspace, { force: true, recursive: true });
		}
	});

	it('generates catalog JSON and TypeScript helper files', async () => {
		const workspace = await mkdtemp(join(tmpdir(), 'agent-vm-mcp-portal-'));
		try {
			const catalogPath = join(workspace, 'catalog.json');
			const outputDir = join(workspace, 'generated');
			await writeFile(
				catalogPath,
				JSON.stringify({
					tools: [
						{ inputSchema: { type: 'object' }, namespace: 'linear', toolName: 'create_issue' },
					],
				}),
			);

			expect(await runAgentVmMcpPortal(['generate-helper', catalogPath, '--out', outputDir])).toBe(
				0,
			);
			await expect(readFile(join(outputDir, 'catalog.json'), 'utf-8')).resolves.toContain(
				'create_issue',
			);
			await expect(readFile(join(outputDir, 'catalog.ts'), 'utf-8')).resolves.toContain(
				'z.fromJSONSchema',
			);
		} finally {
			await rm(workspace, { force: true, recursive: true });
		}
	});
});
