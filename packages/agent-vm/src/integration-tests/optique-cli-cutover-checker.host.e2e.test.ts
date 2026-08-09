import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

export const forbiddenCliDependencyName = 'cmd-ts';
const forbiddenCliResiduePattern = /\bcmd(?:[-_\s]+)?ts\b/giu;
const constructedForbiddenCliResiduePattern =
	/['"`]cmd['"`]\s*(?:\+\s*['"`]-['"`]\s*\+\s*|,\s*)['"`]ts['"`]/giu;

const activeSourceRoots = [
	'packages/agent-vm/src',
	'packages/agent-vm-worker/src',
	'packages/agent-portal-sdk/src',
	'packages/mcp-portal/src',
	'packages/gateway-runtime/src',
] as const;

const manifestPaths = [
	'packages/agent-vm/package.json',
	'packages/agent-vm-worker/package.json',
	'packages/agent-portal-sdk/package.json',
	'packages/mcp-portal/package.json',
	'packages/gateway-runtime/package.json',
	'pnpm-lock.yaml',
] as const;

// These are the only documentation exceptions. The four migration artifacts
// define this cutover; the four older superpowers plans are historical records.
// Current operational documentation, including other docs/specs files, is
// scanned and must not mention the removed dependency.
const authorizedDocumentationPaths = new Set([
	'docs/specs/2026-08-08-optique-cli-migration/requirements.md',
	'docs/specs/2026-08-08-optique-cli-migration/specification.md',
	'docs/specs/2026-08-08-optique-cli-migration/program-design.md',
	'docs/specs/2026-08-08-optique-cli-migration/plans/2026-08-08-optique-cli-migration.md',
	'docs/superpowers/plans/2026-04-30-agent-vm-manual-update.md',
	'docs/superpowers/plans/2026-05-06-openclaw-zone-git-controller-push.md',
	'docs/superpowers/plans/2026-05-12-mcp-portal-schema-config-migration.md',
	'docs/superpowers/plans/2026-05-23-mcp-portal-error-dx-and-live-validation.md',
]);

export interface OptiqueCliCutoverResidueViolation {
	readonly path: string;
	readonly matches: readonly string[];
}

export interface OptiqueCliCutoverResidueScanResult {
	readonly scannedPaths: readonly string[];
	readonly violations: readonly OptiqueCliCutoverResidueViolation[];
}

function normalizeRepositoryPath(filePath: string): string {
	return filePath.split(path.sep).join('/');
}

function findForbiddenCliResidue(content: string): readonly string[] {
	const matches = new Set<string>();
	if (content.includes(forbiddenCliDependencyName)) {
		matches.add(forbiddenCliDependencyName);
	}
	for (const match of content.matchAll(forbiddenCliResiduePattern)) {
		matches.add(match[0]);
	}
	for (const match of content.matchAll(constructedForbiddenCliResiduePattern)) {
		matches.add(match[0]);
	}
	return [...matches];
}

async function collectFiles(rootPath: string): Promise<readonly string[]> {
	const entries = await readdir(rootPath, { withFileTypes: true });
	const childDirectoryPromises = entries
		.filter((entry) => entry.isDirectory())
		.map(async (entry) => await collectFiles(path.join(rootPath, entry.name)));
	const files = entries
		.filter((entry) => entry.isFile())
		.map((entry) => path.join(rootPath, entry.name));
	const childFiles = await Promise.all(childDirectoryPromises);
	return [...files, ...childFiles.flat()];
}

async function collectScanPaths(repositoryRoot: string): Promise<readonly string[]> {
	const sourceAndDocumentationFiles = await Promise.all(
		[...activeSourceRoots, 'docs'].map(async (relativePath) =>
			collectFiles(path.join(repositoryRoot, relativePath)),
		),
	);
	const paths = [
		...manifestPaths.map((relativePath) => path.join(repositoryRoot, relativePath)),
		...sourceAndDocumentationFiles.flat(),
	];
	return paths
		.map((filePath) => normalizeRepositoryPath(path.relative(repositoryRoot, filePath)))
		.filter((relativePath) => !authorizedDocumentationPaths.has(relativePath))
		.toSorted();
}

export async function scanOptiqueCliCutoverResidue(
	repositoryRoot: string,
): Promise<OptiqueCliCutoverResidueScanResult> {
	const checkerImplementationPath = normalizeRepositoryPath(
		path.relative(repositoryRoot, fileURLToPath(import.meta.url)),
	);
	const scannedPaths = await collectScanPaths(repositoryRoot);
	const scanPathsWithoutChecker = scannedPaths.filter(
		(relativePath) => relativePath !== checkerImplementationPath,
	);
	const fileContents = await Promise.all(
		scanPathsWithoutChecker.map(async (relativePath) => ({
			content: await readFile(path.join(repositoryRoot, relativePath), 'utf8'),
			relativePath,
		})),
	);
	const violations = fileContents.flatMap(({ content, relativePath }) => {
		const matches = findForbiddenCliResidue(content);
		return matches.length > 0 ? [{ path: relativePath, matches }] : [];
	});
	return { scannedPaths: scanPathsWithoutChecker, violations };
}

describe('Optique CLI cutover checker', () => {
	it('scans active manifests, source/tests, lockfile, and operational docs', async () => {
		const result = await scanOptiqueCliCutoverResidue(process.cwd());

		expect(result.violations).toEqual([]);
		expect(result.scannedPaths).toContain('packages/agent-vm/package.json');
		expect(result.scannedPaths).toContain('packages/agent-vm-worker/package.json');
		expect(result.scannedPaths).toContain('packages/agent-portal-sdk/package.json');
		expect(result.scannedPaths).toContain('packages/mcp-portal/package.json');
		expect(result.scannedPaths).toContain('packages/gateway-runtime/package.json');
		expect(result.scannedPaths).toContain('pnpm-lock.yaml');
		expect(result.scannedPaths).toContain('packages/agent-vm/src/cli/agent-vm-entrypoint.ts');
		expect(result.scannedPaths).toContain('packages/agent-vm-worker/src/main.ts');
		expect(result.scannedPaths).toContain('packages/agent-portal-sdk/src/cli/tool-portal.ts');
		expect(result.scannedPaths).toContain('packages/mcp-portal/src/bin/mcp-portal.ts');
		expect(result.scannedPaths).toContain('packages/gateway-runtime/src/bin/gateway-runtime.ts');
		expect(result.scannedPaths).toContain('docs/README.md');
		expect(result.scannedPaths).not.toContain(
			'packages/agent-vm/src/integration-tests/optique-cli-cutover-checker.host.e2e.test.ts',
		);
		expect(result.scannedPaths).not.toContain(
			'docs/specs/2026-08-08-optique-cli-migration/specification.md',
		);
		expect(result.scannedPaths).not.toContain(
			'docs/superpowers/plans/2026-05-12-mcp-portal-schema-config-migration.md',
		);
	});
});
