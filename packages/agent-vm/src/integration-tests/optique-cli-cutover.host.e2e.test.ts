import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { execa } from 'execa';
import { beforeAll, describe, expect, it } from 'vitest';

interface CliPackageInventoryEntry {
	readonly executableName: string;
	readonly packageDirectory: string;
}

interface BuiltCliTarget extends CliPackageInventoryEntry {
	readonly executablePath: string;
}

interface CliExecutionResult {
	readonly exitCode: number;
	readonly stderr: string;
	readonly stdout: string;
}

const repositoryRoot = process.cwd();
const cliPackageInventory = [
	{ executableName: 'agent-vm', packageDirectory: 'packages/agent-vm' },
	{ executableName: 'agent-vm-worker', packageDirectory: 'packages/agent-vm-worker' },
	{ executableName: 'tool-portal', packageDirectory: 'packages/agent-portal-sdk' },
	{ executableName: 'mcp-portal', packageDirectory: 'packages/mcp-portal' },
	{
		executableName: 'agent-vm-gateway-runtime',
		packageDirectory: 'packages/gateway-runtime',
	},
] as const satisfies readonly CliPackageInventoryEntry[];

let builtCliTargets: ReadonlyMap<string, BuiltCliTarget>;

async function resolveBuiltCliTarget(
	inventoryEntry: CliPackageInventoryEntry,
): Promise<BuiltCliTarget> {
	const packageRoot = path.join(repositoryRoot, inventoryEntry.packageDirectory);
	const packageManifest = JSON.parse(
		await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
	) as { readonly bin?: Readonly<Record<string, string>> };
	const manifestBinPath = packageManifest.bin?.[inventoryEntry.executableName];
	if (manifestBinPath === undefined) {
		throw new Error(
			`${inventoryEntry.executableName} is missing from ${inventoryEntry.packageDirectory}/package.json bin.`,
		);
	}
	const normalizedBinPath = manifestBinPath.replace(/^\.\//u, '');
	if (!normalizedBinPath.startsWith('dist/') || /(?:^|\/)src(?:\/|$)/u.test(normalizedBinPath)) {
		throw new Error(
			`${inventoryEntry.executableName} bin must resolve to built dist output, received ${manifestBinPath}.`,
		);
	}
	const executablePath = path.resolve(packageRoot, normalizedBinPath);
	const relativeExecutablePath = path.relative(packageRoot, executablePath);
	if (relativeExecutablePath.startsWith('..') || path.isAbsolute(relativeExecutablePath)) {
		throw new Error(`${inventoryEntry.executableName} bin escapes its package root.`);
	}
	const executableStat = await stat(executablePath);
	if (!executableStat.isFile()) {
		throw new Error(`${inventoryEntry.executableName} built bin is not a file: ${executablePath}`);
	}
	return { ...inventoryEntry, executablePath };
}

async function runBuiltCli(
	executableName: string,
	arguments_: readonly string[],
): Promise<CliExecutionResult> {
	const target = builtCliTargets.get(executableName);
	if (target === undefined) {
		throw new Error(`Unknown built CLI target: ${executableName}.`);
	}
	const result = await execa('node', [target.executablePath, ...arguments_], {
		cwd: repositoryRoot,
		reject: false,
		timeout: 15_000,
	});
	if (typeof result.stdout !== 'string' || typeof result.stderr !== 'string') {
		throw new Error(`${executableName} did not return text stdout and stderr.`);
	}
	if (result.exitCode === undefined) {
		throw new Error(`${executableName} terminated without an exit code.`);
	}
	return { exitCode: result.exitCode, stderr: result.stderr, stdout: result.stdout };
}

function expectNoOrdinaryStack(stderr: string): void {
	expect(stderr).not.toMatch(/(?:^|\n)\s+at\s+/u);
	expect(stderr).not.toContain('node:internal');
}

beforeAll(async () => {
	const targets = await Promise.all(cliPackageInventory.map(resolveBuiltCliTarget));
	builtCliTargets = new Map(targets.map((target) => [target.executableName, target]));
});

describe('Optique cutover built CLI contract', () => {
	it('resolves all five executable paths only from package manifests and built dist output', () => {
		// Arrange / Act
		const targets = [...builtCliTargets.values()];

		// Assert
		expect(targets.map((target) => target.executableName)).toEqual(
			cliPackageInventory.map((entry) => entry.executableName),
		);
		for (const target of targets) {
			expect(path.relative(repositoryRoot, target.executablePath)).toContain('/dist/');
			expect(path.relative(repositoryRoot, target.executablePath)).not.toContain('/src/');
		}
	});

	it.each(cliPackageInventory)(
		'$executableName exposes standard successful top-level help on stdout',
		async ({ executableName }) => {
			// Arrange / Act
			const result = await runBuiltCli(executableName, ['--help']);

			// Assert
			expect(result.exitCode).toBe(0);
			expect(result.stdout.trim().length).toBeGreaterThan(0);
			expect(result.stderr).toBe('');
			expectNoOrdinaryStack(result.stderr);
		},
	);

	it('preserves the existing agent-vm version surface', async () => {
		// Arrange / Act
		const result = await runBuiltCli('agent-vm', ['--version']);

		// Assert
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/u);
		expect(result.stderr).toBe('');
	});

	it.each([
		{ arguments_: ['unknown-command'], executableName: 'agent-vm' },
		{ arguments_: ['serve', '--port', 'not-a-port'], executableName: 'agent-vm-worker' },
		{
			arguments_: [
				'list',
				'--input-json',
				'{}',
				'--transport',
				'http',
				'--endpoint',
				'https://example.invalid',
				'--authorization-env',
				'not-valid',
			],
			executableName: 'tool-portal',
		},
		{ arguments_: ['serve'], executableName: 'mcp-portal' },
		{ arguments_: ['--config', 'relative.json'], executableName: 'agent-vm-gateway-runtime' },
	] as const)(
		'$executableName rejects invalid input on stderr without a stack or ordinary stdout',
		async ({ arguments_, executableName }) => {
			// Arrange / Act
			const result = await runBuiltCli(executableName, arguments_);

			// Assert
			expect(result.exitCode).not.toBe(0);
			expect(result.stdout).toBe('');
			expect(result.stderr.trim().length).toBeGreaterThan(0);
			expectNoOrdinaryStack(result.stderr);
		},
	);

	it.each([
		{ arguments_: ['health', '--port', '-1'], boundary: '-1' },
		{ arguments_: ['health', '--port', '65536'], boundary: '65536' },
	])(
		'agent-vm-worker rejects out-of-range port $boundary before health IO',
		async ({ arguments_, boundary }) => {
			// Arrange / Act
			const result = await runBuiltCli('agent-vm-worker', arguments_);

			// Assert
			expect(result.exitCode).not.toBe(0);
			expect(result.stdout).toBe('');
			expect(result.stderr).toContain(boundary);
			expect(result.stderr.toLowerCase()).toContain('port');
			expect(result.stderr).not.toContain('Health check failed: fetch failed');
			expectNoOrdinaryStack(result.stderr);
		},
	);

	it('mcp-portal rejects an out-of-range port before loading server configuration', async () => {
		// Arrange / Act
		const result = await runBuiltCli('mcp-portal', [
			'mcp-proxy',
			'serve',
			'--config-dir',
			'/definitely-not-loaded',
			'--port',
			'65536',
		]);

		// Assert
		expect(result.exitCode).not.toBe(0);
		expect(result.stdout).toBe('');
		expect(result.stderr).toContain('65536');
		expect(result.stderr.toLowerCase()).toContain('port');
		expect(result.stderr).not.toContain('ENOENT');
		expectNoOrdinaryStack(result.stderr);
	});
});
