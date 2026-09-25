import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

import {
	generateManagedDockerfile,
	resolveManagedImageRelease,
} from '../build/managed-image-dockerfile.js';

describe('managed Tool VM registry package install', () => {
	it('creates the registry install directory before adding the SDK package', async () => {
		const temporaryRoot = await mkdtemp(
			path.join(tmpdir(), 'agent-vm-tool-vm-registry-install-e2e-'),
		);
		const fixturePackageDirectory = path.join(temporaryRoot, 'fixture-package');
		const dockerContextDirectory = path.join(temporaryRoot, 'docker-context');
		const generatedDirectory = path.join(temporaryRoot, 'generated-managed-image');
		const testIdentity = randomUUID().replaceAll('-', '');
		const missingDirectoryImageTag = `agent-vm-tool-vm-registry-install:missing-directory-${testIdentity}`;
		const generatedDirectoryImageTag = `agent-vm-tool-vm-registry-install:generated-directory-${testIdentity}`;
		const imageTags = [missingDirectoryImageTag, generatedDirectoryImageTag] as const;
		const fixturePackageManifestPath = path.join(fixturePackageDirectory, 'package.json');
		const fixtureExecutablePath = path.join(
			fixturePackageDirectory,
			'dist',
			'cli',
			'tool-portal.js',
		);
		const registryFixturePackageName = '@agent-vm/agent-portal-sdk';
		const fixturePackageVersion = '0.0.0-host-e2e.1';
		const fixtureExecutableMarker = 'local registry SDK fixture executable';
		const expectedGuestPackageRoot =
			'/opt/agent-vm/portal-packages/node_modules/@agent-vm/agent-portal-sdk';
		const expectedGuestExecutablePath = `${expectedGuestPackageRoot}/dist/cli/tool-portal.js`;

		try {
			await Promise.all([
				mkdir(fixturePackageDirectory, { recursive: true }),
				mkdir(path.dirname(fixtureExecutablePath), { recursive: true }),
				mkdir(dockerContextDirectory, { recursive: true }),
				mkdir(generatedDirectory, { recursive: true }),
			]);
			await writeFile(
				fixturePackageManifestPath,
				`${JSON.stringify(
					{
						bin: { 'tool-portal': 'dist/cli/tool-portal.js' },
						files: ['dist/cli/tool-portal.js'],
						name: registryFixturePackageName,
						type: 'module',
						version: fixturePackageVersion,
					},
					null,
					'\t',
				)}\n`,
				'utf8',
			);
			await writeFile(
				fixtureExecutablePath,
				`#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(`${fixtureExecutableMarker}\\n`)});\n`,
				'utf8',
			);
			await chmod(fixtureExecutablePath, 0o755);
			await execa('pnpm', ['pack', '--pack-destination', dockerContextDirectory], {
				cwd: fixturePackageDirectory,
				timeout: 60_000,
			});

			const fixtureTarballNames = (await readdir(dockerContextDirectory)).filter((fileName) =>
				fileName.endsWith('.tgz'),
			);
			expect(fixtureTarballNames).toHaveLength(1);
			const fixtureTarballName = fixtureTarballNames[0];
			if (fixtureTarballName === undefined) {
				throw new Error('The packed registry SDK fixture tarball is missing.');
			}
			const fixtureTarballGuestPath = `/tmp/${fixtureTarballName}`;

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

			const generatedPackageSpecMatch = generatedRegistryInstallCommand.match(/"([^"]+)"$/u);
			const generatedPackageSpec = generatedPackageSpecMatch?.[1];
			if (
				generatedPackageSpec === undefined ||
				!generatedPackageSpec.startsWith(`${registryFixturePackageName}@`)
			) {
				throw new Error(
					'The generated registry install command does not end with the SDK package spec.',
				);
			}
			const registryPackageSpecArgument = `"${generatedPackageSpec}"`;
			expect(generatedRegistryInstallCommand.split(registryPackageSpecArgument)).toHaveLength(2);
			const generatedInstallCommandWithFixture = generatedRegistryInstallCommand.replace(
				registryPackageSpecArgument,
				fixtureTarballGuestPath,
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
				`COPY ${fixtureTarballName} ${fixtureTarballGuestPath}`,
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
