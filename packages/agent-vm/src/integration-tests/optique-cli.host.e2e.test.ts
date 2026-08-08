import { once } from 'node:events';
import { access, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

const repoRoot = process.cwd();
const agentVmCliPath = path.join(
	repoRoot,
	'packages',
	'agent-vm',
	'dist',
	'cli',
	'agent-vm-entrypoint.js',
);
const agentVmWorkerCliPath = path.join(repoRoot, 'packages', 'agent-vm-worker', 'dist', 'main.js');
const temporaryDirectories: string[] = [];
const forbiddenPackagedDependencyPattern = /^cmd(?:[-_\s]+)?ts$/iu;

const packedPackageManifestSchema = z.object({
	name: z.string(),
	version: z.string(),
	dependencies: z.record(z.string(), z.string()).optional(),
});

const packedPackageDefinitions = [
	{
		name: '@agent-vm/agent-vm',
		directoryPath: path.join(repoRoot, 'packages', 'agent-vm'),
	},
	{
		name: '@agent-vm/agent-vm-worker',
		directoryPath: path.join(repoRoot, 'packages', 'agent-vm-worker'),
	},
] as const;

interface CliInvocationResult {
	readonly argv: readonly string[];
	readonly exitCode: number;
	readonly stderr: string;
	readonly stdout: string;
}

async function runBuiltCli(
	cliPath: string,
	argv: readonly string[],
	cwd: string,
): Promise<CliInvocationResult> {
	const result = await execa('node', [cliPath, ...argv], {
		cwd,
		reject: false,
		timeout: 30_000,
	});
	if (result.exitCode === undefined) {
		throw new Error(`Built CLI did not report an exit status for argv: ${argv.join(' ')}`);
	}
	return {
		argv,
		exitCode: result.exitCode,
		stderr: result.stderr,
		stdout: result.stdout,
	};
}

async function packPackageWithoutScripts(
	packageDefinition: (typeof packedPackageDefinitions)[number],
): Promise<z.infer<typeof packedPackageManifestSchema>> {
	const destinationDirectory = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-optique-pack-'));
	temporaryDirectories.push(destinationDirectory);
	const packResult = await execa('pnpm', ['pack', '--pack-destination', destinationDirectory], {
		cwd: packageDefinition.directoryPath,
		env: {
			...process.env,
			npm_config_ignore_scripts: 'true',
			NPM_CONFIG_IGNORE_SCRIPTS: 'true',
		},
		reject: false,
	});
	if (packResult.exitCode !== 0) {
		throw new Error(`Packing ${packageDefinition.name} failed: ${packResult.stderr}`);
	}
	const packageTarballs = (await readdir(destinationDirectory)).filter((entry) =>
		entry.endsWith('.tgz'),
	);
	if (packageTarballs.length !== 1) {
		throw new Error(
			`Expected one packed tarball for ${packageDefinition.name}, found ${packageTarballs.length}.`,
		);
	}
	const packageTarballName = packageTarballs[0];
	if (packageTarballName === undefined) {
		throw new Error(`Packed tarball name for ${packageDefinition.name} was unavailable.`);
	}
	const manifestResult = await execa(
		'tar',
		['-xOf', path.join(destinationDirectory, packageTarballName), 'package/package.json'],
		{ reject: false },
	);
	if (manifestResult.exitCode !== 0) {
		throw new Error(`Inspecting ${packageDefinition.name} failed: ${manifestResult.stderr}`);
	}
	return packedPackageManifestSchema.parse(JSON.parse(manifestResult.stdout));
}

async function closeHttpServer(server: Server): Promise<void> {
	if (!server.listening) {
		return;
	}
	await new Promise<void>((resolve, reject) => {
		server.close((error) => {
			if (error) {
				reject(error);
				return;
			}
			resolve();
		});
	});
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(async (directoryPath) => {
			await rm(directoryPath, { force: true, recursive: true });
		}),
	);
});

describe('built Optique CLI binaries', () => {
	it('proves agent-vm help, nested help, and version on stdout with success status', async () => {
		// Arrange
		await access(agentVmCliPath);
		const packageManifestText = await readFile(
			path.join(repoRoot, 'packages', 'agent-vm', 'package.json'),
			'utf8',
		);
		const packageVersion = packageManifestText.match(/"version": "([^"]+)"/u)?.[1];
		if (packageVersion === undefined) {
			throw new Error('agent-vm package manifest does not declare a version.');
		}

		// Act
		const invocations = await Promise.all([
			runBuiltCli(agentVmCliPath, ['--help'], repoRoot),
			runBuiltCli(agentVmCliPath, ['controller', '--help'], repoRoot),
			runBuiltCli(agentVmCliPath, ['--version'], repoRoot),
		]);

		// Assert
		expect(invocations[0]).toMatchObject({ argv: ['--help'], exitCode: 0, stderr: '' });
		expect(invocations[0].stdout).toContain('agent-vm');
		expect(invocations[1]).toMatchObject({
			argv: ['controller', '--help'],
			exitCode: 0,
			stderr: '',
		});
		expect(invocations[1].stdout).toContain('controller');
		expect(invocations[2]).toMatchObject({
			argv: ['--version'],
			exitCode: 0,
			stderr: '',
			stdout: packageVersion,
		});
	});

	it('reports agent-vm invalid input with useful diagnostics only on stderr', async () => {
		// Arrange
		await access(agentVmCliPath);
		const invalidCases = [
			{
				argv: ['unknown-command'],
				diagnostic: 'Unexpected option or subcommand: `unknown-command`.',
			},
			{
				argv: ['--unknown-option'],
				diagnostic: 'Unexpected option or subcommand: `--unknown-option`.',
			},
			{ argv: ['init', 'demo'], diagnostic: 'Missing option `--type`.' },
			{
				argv: ['init', 'demo', '--type', 'hermes'],
				diagnostic: "Gateway type is required. Expected 'openclaw' or 'worker', got 'hermes'.",
			},
		];

		// Act
		const invocations = await Promise.all(
			invalidCases.map(async ({ argv }) => await runBuiltCli(agentVmCliPath, argv, repoRoot)),
		);

		// Assert
		for (const [index, invocation] of invocations.entries()) {
			const invalidCase = invalidCases[index];
			if (invalidCase === undefined) {
				throw new Error(`Missing agent-vm invalid case at index ${index}.`);
			}
			expect(invocation.argv).toEqual(invalidCase.argv);
			expect(invocation.exitCode).not.toBe(0);
			expect(invocation.stdout).toBe('');
			expect(invocation.stderr).toContain(invalidCase.diagnostic);
			expect(invocation.stderr.match(/^Error:/gmu)).toHaveLength(1);
			expect(invocation.stderr).not.toMatch(/TypeError:|ReferenceError:|SyntaxError:|\n\s+at\s/u);
		}
	});

	it('proves packed runtime dependencies for both shipped CLI packages', async () => {
		// Act
		const packedManifests = await Promise.all(
			packedPackageDefinitions.map(async (packageDefinition) => ({
				packageDefinition,
				manifest: await packPackageWithoutScripts(packageDefinition),
			})),
		);

		// Assert
		for (const { packageDefinition, manifest } of packedManifests) {
			expect(manifest.name).toBe(packageDefinition.name);
			expect(manifest.dependencies ?? {}).toMatchObject({
				'@optique/core': '1.2.0',
				'@optique/run': '1.2.0',
				'@optique/zod': '1.2.0',
			});
			expect(
				Object.keys(manifest.dependencies ?? {}).filter((dependencyName) =>
					forbiddenPackagedDependencyPattern.test(dependencyName),
				),
			).toEqual([]);
		}
	});

	it('performs a safe agent-vm resources init effect through the built binary', async () => {
		// Arrange
		await access(agentVmCliPath);
		const targetDirectory = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-optique-cli-'));
		temporaryDirectories.push(targetDirectory);

		// Act
		const invocation = await runBuiltCli(agentVmCliPath, ['resources', 'init'], targetDirectory);

		// Assert
		expect(invocation.argv).toEqual(['resources', 'init']);
		expect(invocation.exitCode).toBe(0);
		expect(invocation.stderr).toBe('');
		expect(invocation.stdout).toContain('.agent-vm');
		await expect(
			access(path.join(targetDirectory, '.agent-vm', 'README.md')),
		).resolves.toBeUndefined();
	});

	it('proves agent-vm-worker help and leaf help on stdout with success status', async () => {
		// Arrange
		await access(agentVmWorkerCliPath);

		// Act
		const invocations = await Promise.all([
			runBuiltCli(agentVmWorkerCliPath, ['--help'], repoRoot),
			runBuiltCli(agentVmWorkerCliPath, ['serve', '--help'], repoRoot),
		]);

		// Assert
		expect(invocations[0]).toMatchObject({ argv: ['--help'], exitCode: 0, stderr: '' });
		expect(invocations[0].stdout).toContain('agent-vm-worker');
		expect(invocations[1]).toMatchObject({ argv: ['serve', '--help'], exitCode: 0, stderr: '' });
		expect(invocations[1].stdout).toContain('--port');
	});

	it('reports agent-vm-worker invalid input with useful diagnostics only on stderr', async () => {
		// Arrange
		await access(agentVmWorkerCliPath);
		const invalidCases = [
			{
				argv: ['unknown-command'],
				diagnostic: 'Unexpected option or subcommand: `unknown-command`.',
			},
			{
				argv: ['--unknown-option'],
				diagnostic: 'Unexpected option or subcommand: `--unknown-option`.',
			},
			{ argv: ['serve', '--port'], diagnostic: '`--port` requires `PORT`.' },
			{
				argv: ['health', '--port', 'not-a-port'],
				diagnostic: '"Invalid input: expected number, received NaN"',
			},
		];

		// Act
		const invocations = await Promise.all(
			invalidCases.map(async ({ argv }) => await runBuiltCli(agentVmWorkerCliPath, argv, repoRoot)),
		);

		// Assert
		for (const [index, invocation] of invocations.entries()) {
			const invalidCase = invalidCases[index];
			if (invalidCase === undefined) {
				throw new Error(`Missing agent-vm-worker invalid case at index ${index}.`);
			}
			expect(invocation.argv).toEqual(invalidCase.argv);
			expect(invocation.exitCode).not.toBe(0);
			expect(invocation.stdout).toBe('');
			expect(invocation.stderr).toContain(invalidCase.diagnostic);
			expect(invocation.stderr.match(/^Error:/gmu)).toHaveLength(1);
			expect(invocation.stderr).not.toMatch(/TypeError:|ReferenceError:|SyntaxError:|\n\s+at\s/u);
		}
	});

	it('performs a safe worker health effect through the built binary', async () => {
		// Arrange
		await access(agentVmWorkerCliPath);
		const healthServer = createServer((_request, response) => {
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end('{"status":"ok"}');
		});
		healthServer.listen(0, '127.0.0.1');
		await once(healthServer, 'listening');
		const address = healthServer.address();
		if (address === null || typeof address === 'string') {
			await closeHttpServer(healthServer);
			throw new Error('Health server did not expose a TCP address.');
		}

		try {
			// Act
			const invocation = await runBuiltCli(
				agentVmWorkerCliPath,
				['health', '--port', String(address.port)],
				repoRoot,
			);

			// Assert
			expect(invocation.argv).toEqual(['health', '--port', String(address.port)]);
			expect(invocation.exitCode).toBe(0);
			expect(invocation.stderr).toBe('');
			expect(invocation.stdout).toContain('"status": "ok"');
		} finally {
			await closeHttpServer(healthServer);
		}
	});
});
