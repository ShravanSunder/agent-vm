import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { imageArtifactFixtureFileContent } from '../../../../scripts/test-fixtures/image-artifact-fixture.js';
import { computeFingerprintFromConfigPath } from '../build/gondolin-image-builder.js';
import { managedVmImageAssetFileNames } from '../build/gondolin-managed-vm-build-tooling.js';
import {
	configuredImageSelectionRecordPath,
	readPreparedManagedVmImage,
	writePreparedManagedVmImage,
} from '../build/prepared-gondolin-image-cache.js';
import {
	sharedImageCacheDirForSystemConfig,
	type LoadedSystemConfig,
} from '../config/system-config.js';
import { packLocalAgentVmPackageTarball, prepareGatewayE2eProjectImages } from './e2e-harness.js';
import {
	materializeLocalHermesGatewayImagePackages,
	renderHermesManagedE2eConfiguration,
	scaffoldHermesE2eProject,
} from './hermes-e2e-harness.js';

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

async function createTemporaryRoot(prefix: string): Promise<string> {
	const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	temporaryRoots.push(temporaryRoot);
	return temporaryRoot;
}

function e2eSelectionRecordPath(
	systemConfig: LoadedSystemConfig,
	family: 'gateway' | 'toolVm',
	profileName: string,
): string {
	return configuredImageSelectionRecordPath({
		deploymentGeneratedDir: path.join(systemConfig.storageRootDir, 'generated'),
		family,
		profileName,
	});
}

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((temporaryRoot) =>
			fs.rm(temporaryRoot, {
				force: true,
				recursive: true,
			}),
		),
	);
});

describe('shared Hermes E2E harness contracts', () => {
	it('dispatches through the typed Hermes project scaffold', async () => {
		const project = await scaffoldHermesE2eProject({
			agents: ['smoke-agent'],
			architecture: 'aarch64',
			prefix: 'agent-vm-gateway-e2e-project-',
			zoneId: 'smoke-zone',
		});
		temporaryRoots.push(project.tempRoot);

		expect(project.zone.gateway.type).toBe('hermes');
		expect(project.systemConfig.zones[0]?.agents).toEqual([{ id: 'smoke-agent' }]);
	});

	it('materializes the local Hermes image overlay into a fresh Docker context', async () => {
		const project = await scaffoldHermesE2eProject({
			agents: ['main', 'beta'],
			architecture: 'aarch64',
			prefix: 'hermes-managed-base-environment-e2e-',
			zoneId: 'hermes-smoke',
		});
		temporaryRoots.push(project.tempRoot);
		const gatewayProfile = project.systemConfig.imageProfiles.gateways.hermes;
		if (gatewayProfile === undefined) {
			throw new Error('Expected the Hermes E2E image profile.');
		}
		const localArtifactDirectory = path.join(
			path.dirname(gatewayProfile.buildConfig),
			'local-agent-vm',
		);
		await expect(fs.access(localArtifactDirectory)).rejects.toThrow();

		await materializeLocalHermesGatewayImagePackages({
			architecture: 'aarch64',
			profileName: project.zone.gateway.imageProfile,
			projectRoot: project.tempRoot,
			repoRoot: process.cwd(),
			systemConfig: project.systemConfig,
		});

		const localArtifactFileNames = await fs.readdir(localArtifactDirectory);
		expect(localArtifactFileNames).toContain('package.json');
		expect(localArtifactFileNames.some((fileName) => fileName.endsWith('.tgz'))).toBe(true);
		expect(
			localArtifactFileNames.some(
				(fileName) => fileName.startsWith('agent_vm_hermes_adapter-') && fileName.endsWith('.whl'),
			),
		).toBe(true);
		await expect(
			fs.readFile(path.join(path.dirname(gatewayProfile.buildConfig), 'Dockerfile'), 'utf8'),
		).resolves.toContain('agent_vm_hermes_adapter');
	});

	it('renders safe shared Hermes policy', () => {
		const configuration = renderHermesManagedE2eConfiguration({
			contextLength: 65_536,
			fakeModelHost: 'model.vm.host',
			fakeModelName: 'hermes-e2e',
		});

		expect(configuration).toContain('    - agent-vm-tool-portal');
		expect(configuration).toContain('  context_length: 65536');
		expect(configuration).toContain(
			'fallback_providers:\n  - provider: custom:hermes-e2e\n    model: hermes-e2e',
		);
		expect(configuration).toContain('provider_routing:\n  order:\n    - hermes-e2e');
		expect(configuration).not.toContain('api_key:');
		expect(configuration).not.toContain('webhook');
		expect(configuration).not.toContain('multiplex_profiles');
		expect(configuration).not.toContain('preserve_existing');
	});

	it('does not materialize a combined manifest when one selected profile uses a managed source', async () => {
		const sharedCacheRoot = await createTemporaryRoot('agent-vm-managed-source-manifest-');
		const previousCacheRoot = process.env.AGENT_VM_E2E_CACHE_DIR;
		const previousStrictMode = process.env.AGENT_VM_E2E_REQUIRE_PREPARED_IMAGE_CACHE;
		const previousLocalToolVmPackages = process.env.AGENT_VM_E2E_USE_LOCAL_TOOL_VM_PACKAGES;
		process.env.AGENT_VM_E2E_CACHE_DIR = sharedCacheRoot;
		delete process.env.AGENT_VM_E2E_REQUIRE_PREPARED_IMAGE_CACHE;
		delete process.env.AGENT_VM_E2E_USE_LOCAL_TOOL_VM_PACKAGES;
		try {
			const projects = await Promise.all(
				[0, 1].map(
					async () =>
						await scaffoldHermesE2eProject({
							agents: ['main'],
							architecture: 'aarch64',
							prefix: 'hermes-managed-source-e2e-',
							zoneId: 'hermes-e2e',
						}),
				),
			);
			temporaryRoots.push(...projects.map((project) => project.tempRoot));
			const buildConfigs: LoadedSystemConfig[] = [];
			for (const project of projects) {
				// oxlint-disable-next-line no-await-in-loop -- the second call must observe the first manifest.
				await prepareGatewayE2eProjectImages({
					project,
					runBuild: async ({ systemConfig }) => {
						buildConfigs.push(systemConfig);
					},
				});
			}
			expect(buildConfigs).toEqual(projects.map((project) => project.systemConfig));
		} finally {
			if (previousCacheRoot === undefined) delete process.env.AGENT_VM_E2E_CACHE_DIR;
			else process.env.AGENT_VM_E2E_CACHE_DIR = previousCacheRoot;
			if (previousStrictMode === undefined)
				delete process.env.AGENT_VM_E2E_REQUIRE_PREPARED_IMAGE_CACHE;
			else process.env.AGENT_VM_E2E_REQUIRE_PREPARED_IMAGE_CACHE = previousStrictMode;
			if (previousLocalToolVmPackages === undefined)
				delete process.env.AGENT_VM_E2E_USE_LOCAL_TOOL_VM_PACKAGES;
			else process.env.AGENT_VM_E2E_USE_LOCAL_TOOL_VM_PACKAGES = previousLocalToolVmPackages;
		}
	});

	it('materializes a prepared Hermes gateway record for an equivalent temp deployment', async () => {
		const sharedCacheRoot = await createTemporaryRoot('agent-vm-prepared-hermes-manifest-');
		const previousCacheRoot = process.env.AGENT_VM_E2E_CACHE_DIR;
		const previousStrictMode = process.env.AGENT_VM_E2E_REQUIRE_PREPARED_IMAGE_CACHE;
		process.env.AGENT_VM_E2E_CACHE_DIR = sharedCacheRoot;
		delete process.env.AGENT_VM_E2E_REQUIRE_PREPARED_IMAGE_CACHE;
		try {
			const firstProject = await scaffoldHermesE2eProject({
				agents: ['main'],
				architecture: 'aarch64',
				prefix: 'hermes-prepared-manifest-e2e-',
				zoneId: 'hermes-e2e',
			});
			const secondProject = await scaffoldHermesE2eProject({
				agents: ['main'],
				architecture: 'aarch64',
				prefix: 'hermes-prepared-manifest-e2e-',
				zoneId: 'hermes-e2e',
			});
			temporaryRoots.push(firstProject.tempRoot, secondProject.tempRoot);
			for (const project of [firstProject, secondProject]) {
				Object.assign(project.systemConfig, { cacheDir: path.join(sharedCacheRoot, 'hermes') });
				const gatewayProfile = project.systemConfig.imageProfiles.gateways.hermes;
				if (gatewayProfile === undefined) {
					throw new Error('Expected Hermes gateway image profile.');
				}
				const dockerfilePath = path.join(
					project.tempRoot,
					'docker-context',
					'hermes',
					'Dockerfile',
				);
				await fs.mkdir(path.dirname(dockerfilePath), { recursive: true });
				await fs.writeFile(dockerfilePath, 'FROM scratch\n', 'utf8');
				gatewayProfile.dockerfile = dockerfilePath;
				delete gatewayProfile.source;
			}
			const managedGatewayBoot = {
				frameworkBootEntry: 'hermes-framework-service',
				kind: 'managed-gateway-exact-two-role',
			} as const;
			const buildConfigs: LoadedSystemConfig[] = [];
			await prepareGatewayE2eProjectImages({
				imageFamilies: ['gateway'],
				project: firstProject,
				runBuild: async ({ systemConfig }) => {
					buildConfigs.push(systemConfig);
					const gatewayProfile = systemConfig.imageProfiles.gateways.hermes;
					if (gatewayProfile === undefined) {
						throw new Error('Expected Hermes gateway image profile.');
					}
					const fingerprint = await computeFingerprintFromConfigPath(gatewayProfile.buildConfig, {
						managedGatewayBoot,
					});
					const cacheDir = sharedImageCacheDirForSystemConfig(systemConfig);
					const imagePath = path.join(cacheDir, fingerprint);
					await fs.mkdir(imagePath, { recursive: true });
					await Promise.all(
						managedVmImageAssetFileNames.map(
							async (fileName) =>
								await fs.writeFile(
									path.join(imagePath, fileName),
									imageArtifactFixtureFileContent(fileName),
									'utf8',
								),
						),
					);
					await writePreparedManagedVmImage({
						buildConfigPath: gatewayProfile.buildConfig,
						fingerprint,
						imagePath,
						managedGatewayBoot,
						selectionRecordPath: e2eSelectionRecordPath(systemConfig, 'gateway', 'hermes'),
						sharedImageCacheDir: cacheDir,
					});
				},
			});
			process.env.AGENT_VM_E2E_REQUIRE_PREPARED_IMAGE_CACHE = '1';
			await prepareGatewayE2eProjectImages({
				imageFamilies: ['gateway'],
				project: secondProject,
				runBuild: async ({ systemConfig }) => {
					buildConfigs.push(systemConfig);
				},
			});

			expect(buildConfigs).toEqual([firstProject.systemConfig]);
			const secondProfile = secondProject.systemConfig.imageProfiles.gateways.hermes;
			if (secondProfile === undefined) {
				throw new Error('Expected second Hermes gateway image profile.');
			}
			await expect(
				readPreparedManagedVmImage({
					buildConfigPath: secondProfile.buildConfig,
					expectedManagedGatewayBoot: managedGatewayBoot,
					selectionRecordPath: e2eSelectionRecordPath(
						secondProject.systemConfig,
						'gateway',
						'hermes',
					),
					sharedImageCacheDir: sharedImageCacheDirForSystemConfig(secondProject.systemConfig),
				}),
			).resolves.toMatchObject({ built: false });
		} finally {
			if (previousCacheRoot === undefined) delete process.env.AGENT_VM_E2E_CACHE_DIR;
			else process.env.AGENT_VM_E2E_CACHE_DIR = previousCacheRoot;
			if (previousStrictMode === undefined)
				delete process.env.AGENT_VM_E2E_REQUIRE_PREPARED_IMAGE_CACHE;
			else process.env.AGENT_VM_E2E_REQUIRE_PREPARED_IMAGE_CACHE = previousStrictMode;
		}
	});
});

describe('canonical local package archives', () => {
	it('canonicalizes independently generated workspace package archives', async () => {
		const temporaryRoot = await createTemporaryRoot('agent-vm-package-archive-');
		const previousCacheRoot = process.env.AGENT_VM_E2E_CACHE_DIR;
		let firstTarballPath = '';
		let secondTarballPath = '';
		try {
			process.env.AGENT_VM_E2E_CACHE_DIR = path.join(temporaryRoot, 'first-cache');
			firstTarballPath = await packLocalAgentVmPackageTarball({
				packageName: 'gateway-runtime',
				repoRoot: process.cwd(),
			});
			process.env.AGENT_VM_E2E_CACHE_DIR = path.join(temporaryRoot, 'second-cache');
			secondTarballPath = await packLocalAgentVmPackageTarball({
				packageName: 'gateway-runtime',
				repoRoot: process.cwd(),
			});
		} finally {
			if (previousCacheRoot === undefined) delete process.env.AGENT_VM_E2E_CACHE_DIR;
			else process.env.AGENT_VM_E2E_CACHE_DIR = previousCacheRoot;
		}

		expect(await fs.readFile(firstTarballPath)).toEqual(await fs.readFile(secondTarballPath));
	});

	it('preserves conditional export ordering while canonicalizing package dependencies', async () => {
		const temporaryRoot = await createTemporaryRoot('agent-vm-package-exports-');
		const previousCacheRoot = process.env.AGENT_VM_E2E_CACHE_DIR;
		process.env.AGENT_VM_E2E_CACHE_DIR = path.join(temporaryRoot, 'e2e-cache');
		try {
			const tarballPath = await packLocalAgentVmPackageTarball({
				packageName: 'agent-vm',
				repoRoot: process.cwd(),
			});
			const { stdout } = await execFileAsync('tar', ['-xOzf', tarballPath, 'package/package.json']);
			const packedManifest = JSON.parse(stdout) as { readonly exports: unknown };
			const sourceManifest = JSON.parse(
				await fs.readFile(path.join(process.cwd(), 'packages', 'agent-vm', 'package.json'), 'utf8'),
			) as { readonly exports: unknown };
			expect(JSON.stringify(packedManifest.exports)).toBe(JSON.stringify(sourceManifest.exports));
		} finally {
			if (previousCacheRoot === undefined) delete process.env.AGENT_VM_E2E_CACHE_DIR;
			else process.env.AGENT_VM_E2E_CACHE_DIR = previousCacheRoot;
		}
	});
});
