import { readFile, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { execa } from 'execa';
import { beforeAll, describe, expect, it } from 'vitest';

interface CliPackageInventoryEntry {
	readonly executableName: string;
	readonly helpDescription: string | undefined;
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
const nodeSqliteExperimentalWarningLinePattern =
	/^(?:\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time|\(Use `node --trace-warnings \.\.\.` to show where the warning was created\))$/u;
const cliPackageInventory = [
	{
		executableName: 'agent-vm',
		helpDescription: 'Gondolin-based VM controller for Worker and OpenClaw agents',
		packageDirectory: 'packages/agent-vm',
	},
	{
		executableName: 'agent-vm-worker',
		helpDescription: 'Configurable task worker for Gondolin VMs',
		packageDirectory: 'packages/agent-vm-worker',
	},
	{
		executableName: 'tool-portal',
		helpDescription: undefined,
		packageDirectory: 'packages/agent-portal-sdk',
	},
	{
		executableName: 'mcp-portal',
		helpDescription: undefined,
		packageDirectory: 'packages/mcp-portal',
	},
	{
		executableName: 'agent-vm-gateway-runtime',
		helpDescription: undefined,
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
	return {
		exitCode: result.exitCode,
		stderr: result.stderr
			.split('\n')
			.filter((line) => !nodeSqliteExperimentalWarningLinePattern.test(line))
			.join('\n'),
		stdout: result.stdout,
	};
}

function expectNoOrdinaryStack(stderr: string): void {
	expect(stderr).not.toMatch(/(?:^|\n)\s+at\s+/u);
	expect(stderr).not.toContain('node:internal');
}

interface RunningWorkerHealthServer {
	readonly close: () => Promise<void>;
	readonly port: number;
}

async function startWorkerHealthServer(): Promise<RunningWorkerHealthServer> {
	const server = createServer((request, response) => {
		if (request.url !== '/health') {
			response.writeHead(404).end();
			return;
		}
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end(JSON.stringify({ status: 'ok' }));
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, () => {
			server.off('error', reject);
			resolve();
		});
	});
	const address = server.address();
	if (address === null || typeof address === 'string') {
		await closeHttpServer(server);
		throw new Error('Worker health fixture did not bind a TCP port.');
	}
	return { close: async () => await closeHttpServer(server), port: address.port };
}

async function closeHttpServer(server: Server): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		server.close((error) => {
			if (error === undefined) resolve();
			else reject(error);
		});
	});
}

beforeAll(async () => {
	const targets = await Promise.all(cliPackageInventory.map(resolveBuiltCliTarget));
	builtCliTargets = new Map(targets.map((target) => [target.executableName, target]));
});

describe('Optique cutover built CLI contract', () => {
	it('preserves Agent VM identifier schemas through the built root package export', async () => {
		// Arrange
		const agentVmPackageEntrypoint = path.join(repositoryRoot, 'packages/agent-vm/dist/index.js');

		// Act
		const agentVmPackage: unknown = await import(pathToFileURL(agentVmPackageEntrypoint).href);

		// Assert
		for (const schemaExportName of [
			'agentIdSchema',
			'projectNamespaceSchema',
			'zoneIdSchema',
		] as const) {
			expect(Reflect.has(Object(agentVmPackage), schemaExportName)).toBe(true);
		}
	});

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
		async ({ executableName, helpDescription }) => {
			// Arrange / Act
			const result = await runBuiltCli(executableName, ['--help']);

			// Assert
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain(executableName);
			if (helpDescription !== undefined) {
				expect(result.stdout).toContain(helpDescription);
			}
			expect(result.stderr).toBe('');
			expectNoOrdinaryStack(result.stderr);
		},
	);

	it.each(['agent-vm', 'agent-vm-worker'] as const)(
		'$executableName preserves the supported -h help alias',
		async (executableName) => {
			// Arrange / Act
			const result = await runBuiltCli(executableName, ['-h']);

			// Assert
			expect(result.exitCode).toBe(0);
			expect(result.stdout.trim().length).toBeGreaterThan(0);
			expect(result.stderr).toBe('');
		},
	);

	it.each([
		{ arguments_: ['init', '--help'], executableName: 'agent-vm' },
		{ arguments_: ['health', '--help'], executableName: 'agent-vm-worker' },
		{ arguments_: ['call', '--help'], executableName: 'tool-portal' },
		{ arguments_: ['mcp-proxy', 'serve', '--help'], executableName: 'mcp-portal' },
	] as const)(
		'$executableName exposes successful reachable leaf help on stdout',
		async ({ arguments_, executableName }) => {
			// Arrange / Act
			const result = await runBuiltCli(executableName, arguments_);

			// Assert
			expect(result.exitCode).toBe(0);
			expect(result.stdout.trim().length).toBeGreaterThan(0);
			expect(result.stderr).toBe('');
			expectNoOrdinaryStack(result.stderr);
		},
	);

	it('agent-vm-worker executes a valid built health operation against a real listener', async () => {
		// Arrange
		const healthServer = await startWorkerHealthServer();

		try {
			// Act
			const result = await runBuiltCli('agent-vm-worker', [
				'health',
				'--port',
				String(healthServer.port),
			]);

			// Assert
			expect(result.exitCode).toBe(0);
			expect(JSON.parse(result.stdout)).toEqual({ status: 'ok' });
			expect(result.stderr).toBe('');
		} finally {
			await healthServer.close();
		}
	});

	it('agent-vm init leaf help renders its Zod default exactly once', async () => {
		// Arrange / Act
		const result = await runBuiltCli('agent-vm', ['init', '--help']);

		// Assert
		expect(result.exitCode).toBe(0);
		expect(result.stdout.match(/"default"/gu)).toHaveLength(1);
		expect(result.stderr).toBe('');
	});

	it('agent-vm-worker accepts port zero and reaches the health operation', async () => {
		// Arrange / Act
		const result = await runBuiltCli('agent-vm-worker', ['health', '--port', '0']);

		// Assert
		expect(result.exitCode).not.toBe(0);
		expect(result.stdout).toBe('');
		expect(result.stderr).toContain('Health check failed');
		expect(result.stderr).not.toContain('>=0');
		expectNoOrdinaryStack(result.stderr);
	});

	it('agent-vm-worker renders the schema-owned default port in built leaf help', async () => {
		// Arrange / Act
		const result = await runBuiltCli('agent-vm-worker', ['serve', '--help']);

		// Assert
		expect(result.exitCode).toBe(0);
		expect(result.stdout.match(/18789/gu)).toHaveLength(1);
		expect(result.stderr).toBe('');
	});

	it('agent-vm-worker accepts the maximum port and reaches the health operation', async () => {
		// Arrange / Act
		const result = await runBuiltCli('agent-vm-worker', ['health', '--port', '65535']);

		// Assert
		expect(result.exitCode).not.toBe(0);
		expect(result.stdout).toBe('');
		expect(result.stderr).toContain('Health check failed');
		expect(result.stderr).not.toContain('<=65535');
		expectNoOrdinaryStack(result.stderr);
	});

	it('preserves the existing agent-vm version surface', async () => {
		// Arrange / Act
		const longVersionResult = await runBuiltCli('agent-vm', ['--version']);
		const shortVersionResult = await runBuiltCli('agent-vm', ['-v']);

		// Assert
		expect(longVersionResult.exitCode).toBe(0);
		expect(longVersionResult.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/u);
		expect(longVersionResult.stderr).toBe('');
		expect(shortVersionResult).toEqual(longVersionResult);
	});

	it('describes controller cleanup force semantics without weakening the health warning', async () => {
		// Arrange / Act
		const result = await runBuiltCli('agent-vm', ['controller', 'cleanup', '--help']);

		// Assert
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(
			'Allow cleanup even if the controller health endpoint is reachable',
		);
		expect(result.stderr).toBe('');
	});

	it.each([
		{
			arguments_: ['auth', 'openclaw', 'login', '--help'],
			description: 'Print the resolved login plan without opening SSH or changing auth.',
		},
		{
			arguments_: ['controller', 'credentials', 'check', '--help'],
			description: 'Check zone credential resolution without refreshing the gateway',
		},
		{
			arguments_: ['init', '--help'],
			description: 'Overwrite existing scaffolded files; otherwise skip existing files',
		},
	] as const)(
		'preserves operator-relevant help semantics for agent-vm $arguments_',
		async ({ arguments_, description }) => {
			// Arrange / Act
			const result = await runBuiltCli('agent-vm', arguments_);

			// Assert
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain(description);
			expect(result.stderr).toBe('');
		},
	);

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
		{ arguments_: ['health', '--port', '-1'], boundary: '-1', constraint: '>=0' },
		{ arguments_: ['health', '--port', '65536'], boundary: '65536', constraint: '<=65535' },
	])(
		'agent-vm-worker rejects out-of-range port $boundary before health IO',
		async ({ arguments_, constraint }) => {
			// Arrange / Act
			const result = await runBuiltCli('agent-vm-worker', arguments_);

			// Assert
			expect(result.exitCode).not.toBe(0);
			expect(result.stdout).toBe('');
			expect(result.stderr).toContain(constraint);
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
		expect(result.stderr).toContain('<=65535');
		expect(result.stderr.toLowerCase()).toContain('port');
		expect(result.stderr).not.toContain('ENOENT');
		expectNoOrdinaryStack(result.stderr);
	});

	it.each(['0', '65535'] as const)(
		'mcp-portal accepts boundary port %s before loading server configuration',
		async (port) => {
			// Arrange / Act
			const result = await runBuiltCli('mcp-portal', [
				'mcp-proxy',
				'serve',
				'--config-dir',
				'/definitely-not-loaded',
				'--port',
				port,
			]);

			// Assert
			expect(result.exitCode).not.toBe(0);
			expect(result.stdout).toBe('');
			expect(result.stderr).toContain('ENOENT');
			expect(result.stderr).not.toContain('>=0');
			expect(result.stderr).not.toContain('<=65535');
			expectNoOrdinaryStack(result.stderr);
		},
	);
});
