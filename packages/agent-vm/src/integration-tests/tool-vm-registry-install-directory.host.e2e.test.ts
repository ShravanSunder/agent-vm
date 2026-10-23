import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

import {
	generateManagedDockerfile,
	resolveManagedImageRelease,
} from '../build/managed-image-dockerfile.js';

const registryFixturePackageName = '@agent-vm/agent-portal-sdk';
const fixturePackageVersion = '0.0.0-host-e2e.1';
const fixtureExecutableMarker = 'local registry SDK fixture executable';
const guestPackageDirectory = '/opt/agent-vm/portal-packages';
const registryFixturePackageNames = [
	'@agent-collaboration/tool-access',
	'@agent-collaboration/tool-engine',
	'@agent-collaboration/tool-host-node',
	registryFixturePackageName,
] as const;

interface RegistryPackageFixture {
	readonly archiveName: string;
	readonly packageName: string;
}

async function packRegistryPackageFixtures(
	temporaryRoot: string,
	dockerContextDirectory: string,
): Promise<readonly RegistryPackageFixture[]> {
	await mkdir(dockerContextDirectory, { recursive: true });
	return await Promise.all(
		registryFixturePackageNames.map(async (packageName) => {
			const packageDirectory = path.join(
				temporaryRoot,
				'fixture-packages',
				packageName.replace('/', '-'),
			);
			const isSdk = packageName === registryFixturePackageName;
			const entryPath = isSdk ? 'dist/cli/tool-portal.js' : 'dist/index.js';
			await mkdir(path.dirname(path.join(packageDirectory, entryPath)), { recursive: true });
			await writeFile(
				path.join(packageDirectory, 'package.json'),
				JSON.stringify({
					name: packageName,
					version: fixturePackageVersion,
					type: 'module',
					files: ['dist'],
					...(isSdk ? { bin: { 'tool-portal': entryPath } } : {}),
				}) + '\n',
			);
			await writeFile(
				path.join(packageDirectory, entryPath),
				isSdk
					? `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(fixtureExecutableMarker + '\n')});\n`
					: 'export {};\n',
			);
			if (isSdk) await chmod(path.join(packageDirectory, entryPath), 0o755);
			await execa('pnpm', ['pack', '--pack-destination', dockerContextDirectory], {
				cwd: packageDirectory,
				timeout: 60_000,
			});
			return {
				packageName,
				archiveName: `${packageName.replace(/^@/u, '').replace('/', '-')}-${fixturePackageVersion}.tgz`,
			};
		}),
	);
}

function substituteRegistryPackageFixtures(
	command: string,
	fixtures: readonly RegistryPackageFixture[],
	targetPath: (fixture: RegistryPackageFixture) => string,
): string {
	// The SDK-last contract stays explicit even though the install now carries four roots.
	expect(command).toMatch(/"@agent-vm\/agent-portal-sdk@[^"]+"$/u);
	return fixtures.reduce((currentCommand, fixture) => {
		const pattern = new RegExp(`"${fixture.packageName}@[^"]+"`, 'gu');
		expect([...currentCommand.matchAll(pattern)]).toHaveLength(1);
		const quotedPath = "'" + targetPath(fixture).replaceAll("'", "'\"'\"'") + "'";
		return currentCommand.replace(pattern, () => quotedPath);
	}, command);
}

async function generateRegistryInstallCommand(outputDirectory: string): Promise<string> {
	const generated = await generateManagedDockerfile({
		base: 'tool-vm',
		imageTargetFamily: 'toolVm',
		imageTargetName: 'registry-install-host',
		managedImageRelease: await resolveManagedImageRelease(),
		outputDirectory,
	});
	const dockerfile = await readFile(generated.dockerfilePath, 'utf8');
	const command = dockerfile
		.split('\n')
		.find((line) =>
			line.startsWith(
				`RUN install -d -m 0755 ${guestPackageDirectory} && pnpm add --dir ${guestPackageDirectory} --prod --ignore-scripts `,
			),
		);
	if (command === undefined) throw new Error('Missing generated registry install command');
	return command;
}

describe('managed Tool VM registry package install', () => {
	it('runs the exact generated four-package install command with controlled local archives on the host', async () => {
		const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'agent-vm-registry-command-host-'));
		try {
			const archiveDirectory = path.join(temporaryRoot, 'archives');
			const fixtures = await packRegistryPackageFixtures(temporaryRoot, archiveDirectory);
			const generated = await generateRegistryInstallCommand(path.join(temporaryRoot, 'generated'));
			const substituted = substituteRegistryPackageFixtures(generated, fixtures, (fixture) =>
				path.join(archiveDirectory, fixture.archiveName),
			);
			const installDirectory = path.join(temporaryRoot, 'installed');
			const quotedInstallDirectory = "'" + installDirectory.replaceAll("'", "'\"'\"'") + "'";
			const command = substituted.replaceAll(guestPackageDirectory, quotedInstallDirectory);
			const setupPrefix = `RUN install -d -m 0755 ${quotedInstallDirectory} && `;
			expect(command.startsWith(setupPrefix)).toBe(true);
			const missingDirectory = await execa('sh', ['-c', command.slice(setupPrefix.length)], {
				reject: false,
				cwd: temporaryRoot,
			});
			expect(missingDirectory.exitCode).not.toBe(0);
			expect(`${missingDirectory.stdout}\n${missingDirectory.stderr}`).toMatch(
				/ERR_PNPM_ENOENT|ENOENT|no such file or directory/iu,
			);
			await execa('sh', ['-c', command.slice('RUN '.length)], {
				cwd: temporaryRoot,
				timeout: 60_000,
			});
			await Promise.all(
				registryFixturePackageNames.map(async (packageName) => {
					const manifest: unknown = JSON.parse(
						await readFile(
							path.join(installDirectory, 'node_modules', packageName, 'package.json'),
							'utf8',
						),
					);
					expect(manifest).toMatchObject({ name: packageName, version: fixturePackageVersion });
				}),
			);
			const executable = await execa(
				path.join(
					installDirectory,
					'node_modules',
					registryFixturePackageName,
					'dist/cli/tool-portal.js',
				),
				['--help'],
			);
			expect(executable.stdout).toContain(fixtureExecutableMarker);
		} finally {
			await rm(temporaryRoot, { recursive: true, force: true });
		}
	});

	it('creates the registry install directory before adding the SDK package', async () => {
		const temporaryRoot = await mkdtemp(
			path.join(tmpdir(), 'agent-vm-tool-vm-registry-install-e2e-'),
		);
		const dockerContextDirectory = path.join(temporaryRoot, 'docker-context');
		const generatedDirectory = path.join(temporaryRoot, 'generated-managed-image');
		const testIdentity = randomUUID().replaceAll('-', '');
		const missingDirectoryImageTag = `agent-vm-tool-vm-registry-install:missing-directory-${testIdentity}`;
		const generatedDirectoryImageTag = `agent-vm-tool-vm-registry-install:generated-directory-${testIdentity}`;
		const imageTags = [missingDirectoryImageTag, generatedDirectoryImageTag] as const;

		const expectedGuestPackageRoot =
			'/opt/agent-vm/portal-packages/node_modules/@agent-vm/agent-portal-sdk';
		const expectedGuestExecutablePath = `${expectedGuestPackageRoot}/dist/cli/tool-portal.js`;

		try {
			await mkdir(generatedDirectory, { recursive: true });
			const fixtures = await packRegistryPackageFixtures(temporaryRoot, dockerContextDirectory);
			expect(
				(await readdir(dockerContextDirectory)).filter((name) => name.endsWith('.tgz')),
			).toHaveLength(4);

			const managedImageRelease = await resolveManagedImageRelease();
			const generatedManagedDockerfile = await generateManagedDockerfile({
				base: 'tool-vm',
				imageTargetFamily: 'toolVm',
				imageTargetName: 'registry-install-e2e',
				managedImageRelease,
				outputDirectory: generatedDirectory,
			});
			const generatedDockerfile = await readFile(generatedManagedDockerfile.dockerfilePath, 'utf8');
			const generatedDockerfileLines = generatedDockerfile.split('\n');
			const generatedRegistryInstallCommand = generatedDockerfileLines.find((line) =>
				line.startsWith(
					'RUN install -d -m 0755 /opt/agent-vm/portal-packages && pnpm add --dir /opt/agent-vm/portal-packages --prod --ignore-scripts ',
				),
			);
			if (generatedRegistryInstallCommand === undefined) {
				throw new Error('The generated Tool VM Dockerfile has no registry SDK install command.');
			}
			expect(generatedManagedDockerfile.plan.mcpPortalPackage?.source).toBe('installed-package');
			expect(generatedDockerfile).not.toContain('/opt/agent-vm/local-packages');
			expect(generatedDockerfile).not.toContain('COPY overlay/');

			const generatedInstallCommandWithFixture = substituteRegistryPackageFixtures(
				generatedRegistryInstallCommand,
				fixtures,
				(fixture) => `/tmp/${fixture.archiveName}`,
			);

			const directorySetupCommandPrefix =
				'RUN install -d -m 0755 /opt/agent-vm/portal-packages && ';
			if (!generatedInstallCommandWithFixture.startsWith(directorySetupCommandPrefix)) {
				throw new Error(
					'The generated registry install command no longer creates its target directory.',
				);
			}
			const controlledMissingDirectoryCommand = `RUN ${generatedInstallCommandWithFixture.slice(directorySetupCommandPrefix.length)}`;

			const pnpmHomeLine = generatedDockerfileLines.find((line) =>
				line.startsWith('ENV PNPM_HOME='),
			);
			const pnpmPathLine = generatedDockerfileLines.find((line) =>
				line.startsWith('ENV PATH=${PNPM_HOME}:'),
			);
			const pnpmConfigurationLine = generatedDockerfileLines.find((line) =>
				line.startsWith('RUN pnpm config set global-dir '),
			);
			if (
				pnpmHomeLine === undefined ||
				pnpmPathLine === undefined ||
				pnpmConfigurationLine === undefined
			) {
				throw new Error('The generated Tool VM Dockerfile is missing its pnpm environment setup.');
			}

			const sharedDockerfileLines = [
				`FROM ${generatedManagedDockerfile.plan.baseImage.reference}`,
				pnpmHomeLine,
				pnpmPathLine,
				pnpmConfigurationLine,
				...fixtures.map((fixture) => `COPY ${fixture.archiveName} /tmp/${fixture.archiveName}`),
				'RUN test ! -e /opt/agent-vm',
			];
			const executableCheckCommand = [
				`test -x ${expectedGuestExecutablePath}`,
				`head -n 1 ${expectedGuestExecutablePath} | grep -F -x '#!/usr/bin/env node'`,
				`${expectedGuestExecutablePath} --help`,
			].join(' && ');
			await writeFile(
				path.join(dockerContextDirectory, 'Dockerfile.missing-directory'),
				[...sharedDockerfileLines, controlledMissingDirectoryCommand].join('\n') + '\n',
				'utf8',
			);
			await writeFile(
				path.join(dockerContextDirectory, 'Dockerfile.generated-directory'),
				[
					...sharedDockerfileLines,
					generatedInstallCommandWithFixture,
					`RUN ${executableCheckCommand}`,
				].join('\n') + '\n',
				'utf8',
			);

			const controlledFailure = await execa(
				'docker',
				[
					'build',
					'--progress=plain',
					'--file',
					'Dockerfile.missing-directory',
					'--tag',
					missingDirectoryImageTag,
					'.',
				],
				{
					cwd: dockerContextDirectory,
					reject: false,
					timeout: 600_000,
				},
			);
			expect(controlledFailure.exitCode).not.toBe(0);
			expect(`${controlledFailure.stdout}\n${controlledFailure.stderr}`).toMatch(
				/ERR_PNPM_ENOENT|ENOENT|no such file or directory/iu,
			);

			const generatedRecipeBuild = await execa(
				'docker',
				[
					'build',
					'--progress=plain',
					'--file',
					'Dockerfile.generated-directory',
					'--tag',
					generatedDirectoryImageTag,
					'.',
				],
				{
					cwd: dockerContextDirectory,
					reject: false,
					timeout: 600_000,
				},
			);
			expect(generatedRecipeBuild.exitCode).toBe(0);

			const installedExecutableRun = await execa(
				'docker',
				[
					'run',
					'--rm',
					'--entrypoint',
					'/bin/sh',
					generatedDirectoryImageTag,
					'-c',
					executableCheckCommand,
				],
				{
					reject: false,
					timeout: 30_000,
				},
			);
			expect(installedExecutableRun.exitCode).toBe(0);
			expect(installedExecutableRun.stdout).toContain(fixtureExecutableMarker);
		} finally {
			await Promise.all(
				imageTags.map(async (imageTag) => {
					const inspection = await execa('docker', ['image', 'inspect', imageTag], {
						reject: false,
						timeout: 30_000,
					}).catch(() => undefined);
					if (inspection === undefined || inspection.exitCode !== 0) return;
					const removal = await execa('docker', ['image', 'rm', imageTag], {
						reject: false,
						timeout: 30_000,
					});
					if (removal.exitCode !== 0) {
						throw new Error(`Could not remove temporary Docker image '${imageTag}'.`);
					}
				}),
			);
		}
	}, 900_000);
});
