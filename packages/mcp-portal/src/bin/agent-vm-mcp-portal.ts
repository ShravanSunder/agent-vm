#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { portalToolRecordSchema, type PortalToolRecord } from '../catalog-types.js';
import { generateTypescriptCatalogArtifact } from '../tool-vm/typescript-artifact.js';

const catalogFileSchema = z
	.object({
		tools: z.array(portalToolRecordSchema),
	})
	.strict();

export interface PortalCatalogFile {
	readonly tools: readonly PortalToolRecord[];
}

async function readCatalogFile(catalogPath: string): Promise<PortalCatalogFile> {
	const rawCatalog = await readFile(catalogPath, 'utf-8');
	const parsedJson = JSON.parse(rawCatalog) as unknown;
	return catalogFileSchema.parse(parsedJson);
}

function parseOutputDirectory(args: readonly string[]): string | null {
	const outputFlagIndex = args.indexOf('--out');
	if (outputFlagIndex === -1) {
		return null;
	}

	return args[outputFlagIndex + 1] ?? null;
}

function printUsage(): void {
	process.stderr.write('Usage: agent-vm-mcp-portal validate <catalog.json>\n');
	process.stderr.write(
		'Usage: agent-vm-mcp-portal generate-helper <catalog.json> --out <directory>\n',
	);
}

export async function runAgentVmMcpPortal(args: readonly string[]): Promise<number> {
	const [command, catalogPath, ...restArgs] = args;
	if (!command || !catalogPath) {
		printUsage();
		return 1;
	}

	try {
		const catalog = await readCatalogFile(catalogPath);
		switch (command) {
			case 'validate':
				return 0;
			case 'generate-helper': {
				const outputDirectory = parseOutputDirectory(restArgs);
				if (!outputDirectory) {
					printUsage();
					return 1;
				}

				await mkdir(outputDirectory, { recursive: true });
				await writeFile(join(outputDirectory, 'catalog.json'), JSON.stringify(catalog, null, '\t'));
				await writeFile(
					join(outputDirectory, 'catalog.ts'),
					generateTypescriptCatalogArtifact(catalog),
				);
				return 0;
			}
			default:
				printUsage();
				return 1;
		}
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

if (process.argv[1]?.endsWith('agent-vm-mcp-portal.js')) {
	process.exitCode = await runAgentVmMcpPortal(process.argv.slice(2));
}
