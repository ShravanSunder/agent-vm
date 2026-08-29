import fs from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const publishNpmTokenOpRef = 'op://agent-vm/npm-token-agent-vm-publish/credential';
const staleNpmTokenOpRef = ['op://agent-vm', 'npm-token', 'credential'].join('/');

describe('publish workflow', () => {
	it('declares trusted-publishing repository provenance for every public Agent VM package', async () => {
		const packageDirectories = await fs.readdir(path.join(process.cwd(), 'packages'), {
			withFileTypes: true,
		});
		const expectedRepositoryUrl = 'git+https://github.com/ShravanSunder/agent-vm.git';
		const packageManifests = await Promise.all(
			packageDirectories
				.filter((entry) => entry.isDirectory())
				.map(async (packageDirectory) => {
					const packageJsonPath = path.join(
						process.cwd(),
						'packages',
						packageDirectory.name,
						'package.json',
					);
					try {
						return JSON.parse(await fs.readFile(packageJsonPath, 'utf8')) as {
							readonly name?: string;
							readonly private?: boolean;
							readonly repository?: { readonly url?: string };
						};
					} catch (error: unknown) {
						if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
							return undefined;
						}
						throw error;
					}
				}),
		);

		for (const packageJson of packageManifests) {
			if (
				packageJson === undefined ||
				!packageJson.name?.startsWith('@agent-vm/') ||
				packageJson.private === true
			) {
				continue;
			}
			const publicPackageJson: {
				readonly name?: string;
				readonly repository?: { readonly url?: string };
			} = packageJson;

			expect(publicPackageJson.repository?.url, publicPackageJson.name).toBe(expectedRepositoryUrl);
		}
	});

	it('does not define publish lifecycle scripts other than the workspace rebuild prepack', async () => {
		const packageDirectories = await fs.readdir(path.join(process.cwd(), 'packages'), {
			withFileTypes: true,
		});
		type PackageManifestEntry = {
			readonly name: string;
			readonly packageJson: { readonly scripts?: Readonly<Record<string, string>> };
		};
		const forbiddenLifecycleScripts = [
			'prepublishOnly',
			'prepublish',
			'prepare',
			'postpack',
			'publish',
			'postpublish',
		];

		const packageManifests = (
			await Promise.all(
				packageDirectories
					.filter((packageDirectory) => packageDirectory.isDirectory())
					.map(async (packageDirectory): Promise<PackageManifestEntry | undefined> => {
						const packageDirectoryPath = path.join(
							process.cwd(),
							'packages',
							packageDirectory.name,
						);
						const packageDirectoryEntries = await fs.readdir(packageDirectoryPath);
						if (!packageDirectoryEntries.includes('package.json')) {
							return undefined;
						}

						const packageJsonPath = path.join(packageDirectoryPath, 'package.json');
						const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8')) as {
							readonly scripts?: Readonly<Record<string, string>>;
						};
						return { name: packageDirectory.name, packageJson };
					}),
			)
		).filter((entry): entry is PackageManifestEntry => entry !== undefined);

		for (const { name, packageJson } of packageManifests) {
			for (const scriptName of forbiddenLifecycleScripts) {
				expect(packageJson.scripts?.[scriptName], `${name}:${scriptName}`).toBe(undefined);
			}
			if (packageJson.scripts?.prepack !== undefined) {
				expect(packageJson.scripts.prepack).toBe('pnpm -C ../.. build');
			}
		}
	});

	it('installs Gondolin Zig only for explicit source-build publication', async () => {
		const [ciWorkflow, publishWorkflow, sharedSetupAction] = await Promise.all([
			fs.readFile(path.join(process.cwd(), '.github', 'workflows', 'ci.yml'), 'utf8'),
			fs.readFile(path.join(process.cwd(), '.github', 'workflows', 'publish.yml'), 'utf8'),
			fs.readFile(
				path.join(process.cwd(), '.github', 'actions', 'setup-agent-vm', 'action.yml'),
				'utf8',
			),
		]);

		expect(ciWorkflow).toContain('./.github/actions/setup-agent-vm');

		expect(publishWorkflow).toContain('Resolve Gondolin Zig version');
		expect(publishWorkflow).toContain('Cache Zig tarballs');
		expect(publishWorkflow).toContain('path: .cache/zig');
		expect(publishWorkflow).toContain(
			'key: ${{ runner.os }}-zig-${{ steps.zig-version.outputs.arch }}-${{ steps.zig-version.outputs.version }}',
		);
		expect(publishWorkflow).toContain('--continue-at -');
		expect(publishWorkflow).toContain('--speed-limit 1024');
		expect(publishWorkflow).toContain('xz --test "${ZIG_ARCHIVE}"');
		expect(publishWorkflow).toContain('sudo tar -xJf "${ZIG_ARCHIVE}" -C /opt');
		expect(publishWorkflow).not.toContain('curl -fsSL "https://ziglang.org');
		expect(publishWorkflow).not.toContain('-o /tmp/zig.tar.xz');

		expect(sharedSetupAction).not.toContain('Resolve Gondolin Zig version');
		expect(sharedSetupAction).not.toContain('Cache Zig tarballs');
		expect(sharedSetupAction).not.toContain('ziglang.org');
	});

	it('publishes managed base images as multi-arch manifest lists independently of packages', async () => {
		const workflow = await fs.readFile(
			path.join(process.cwd(), '.github', 'workflows', 'publish.yml'),
			'utf8',
		);

		expect(workflow).toContain('base_images_mode');
		expect(workflow).toContain('managed_image_tag');
		expect(workflow).toContain('source_managed_image_tag');
		expect(workflow).toContain('Cache apt packages');
		expect(workflow).toContain('Install Zig for Gondolin e2e tests');
		expect(workflow).toContain('Detect managed base image changes');
		expect(workflow).toContain('MANAGED_IMAGE_TAG="$(node -e');
		expect(workflow).not.toContain('publish_npm');
		expect(workflow).not.toContain('Publish to npm via OIDC');
		expect(workflow).not.toContain(
			'IMAGE_VERSION="${REQUESTED_IMAGE_VERSION:-${PACKAGE_VERSION}}"',
		);
		expect(workflow).toContain('AUTO_MODE="skip"');
		expect(workflow).toContain('docker/setup-qemu-action@v4');
		expect(workflow).toContain('docker/setup-buildx-action@v4');
		expect(workflow).toContain('Retag managed base images in GHCR');
		expect(workflow).not.toContain('agent-vm-managed-openclaw-gateway-base');
		expect(workflow).toContain('agent-vm-managed-worker-gateway-base');
		expect(workflow).toContain('agent-vm-managed-tool-vm-base');
		expect(workflow).toContain('docker buildx build');
		expect(workflow).toContain('--platform linux/amd64,linux/arm64');
		expect(workflow).toContain('--push');
		expect(workflow).toContain('docker buildx imagetools inspect --raw');
		expect(workflow).not.toMatch(/docker build -t/u);
		expect(workflow).not.toMatch(/docker push "ghcr\.io\/shravansunder\/agent-vm-/u);
	});

	it('uses the publish-specific 1Password item for local npm publish', async () => {
		const publishScript = await fs.readFile(
			path.join(process.cwd(), 'scripts', 'publish-local.sh'),
			'utf8',
		);
		const agentsGuidance = await fs.readFile(path.join(process.cwd(), 'AGENTS.md'), 'utf8');

		expect(publishScript).toContain(
			`OP_REF="\${AGENT_VM_NPM_TOKEN_OP_REF:-${publishNpmTokenOpRef}}"`,
		);
		expect(publishScript).not.toContain(staleNpmTokenOpRef);
		expect(agentsGuidance).toContain(
			`AGENT_VM_NPM_TOKEN_OP_REF='${publishNpmTokenOpRef}' scripts/publish-local.sh`,
		);
		expect(agentsGuidance).not.toContain(staleNpmTokenOpRef);
	});

	it('verifies local npm publish cannot reference missing managed GHCR base image tags', async () => {
		const publishScript = await fs.readFile(
			path.join(process.cwd(), 'scripts', 'publish-local.sh'),
			'utf8',
		);

		expect(publishScript).toContain('verify_managed_base_images_exist');
		expect(publishScript).toContain('packages/agent-vm/managed-images.json');
		expect(publishScript).toContain('Object.values(manifest.baseImages)');
		expect(publishScript).toContain('`${image.repository}:${image.tag}`');
		expect(publishScript).toContain('docker buildx imagetools inspect');
		expect(publishScript).toContain('MANAGED_BASE_IMAGE_MANIFEST');
		expect(publishScript).toContain("['linux/amd64', 'linux/arm64']");
		expect(publishScript).not.toContain('mapfile');
		expect(publishScript.indexOf('[publish] verifying managed GHCR base image tags')).toBeLessThan(
			publishScript.indexOf('[publish] verifying npm auth'),
		);
		expect(publishScript.indexOf('verify_managed_base_images_exist')).toBeLessThan(
			publishScript.indexOf('pnpm -r publish'),
		);
	});

	it('builds once before local npm publish and disables package prepack rebuilds', async () => {
		const publishScript = await fs.readFile(
			path.join(process.cwd(), 'scripts', 'publish-local.sh'),
			'utf8',
		);

		expect(publishScript).toContain('echo "[publish] building workspace once"');
		expect(publishScript).toContain('pnpm build');
		expect(publishScript).toContain('--config.ignore-scripts=true');
		expect(publishScript.indexOf('pnpm build')).toBeLessThan(
			publishScript.indexOf('pnpm -r publish'),
		);
		expect(publishScript.indexOf('--config.ignore-scripts=true')).toBeGreaterThan(
			publishScript.indexOf('pnpm -r publish'),
		);
		expect(publishScript.indexOf('NPM_TOKEN="$(op read "$OP_REF")"')).toBeLessThan(
			publishScript.indexOf('pnpm build'),
		);
		expect(publishScript.indexOf('PYPI_TOKEN="$(op read "$PYPI_OP_REF")"')).toBeLessThan(
			publishScript.indexOf('pnpm build'),
		);
		expect(publishScript).toContain('NPM_TOKEN="${AGENT_VM_NPM_TOKEN-}"');
		expect(publishScript).toContain('PYPI_TOKEN="${AGENT_VM_PYPI_TOKEN-}"');
	});

	it('publishes Python packages from isolated explicit artifacts with optional 1Password auth', async () => {
		const publishScript = await fs.readFile(
			path.join(process.cwd(), 'scripts', 'publish-python-local.sh'),
			'utf8',
		);
		const workspacePackageJson = JSON.parse(
			await fs.readFile(path.join(process.cwd(), 'package.json'), 'utf8'),
		) as { readonly scripts?: Readonly<Record<string, string>> };

		expect(workspacePackageJson.scripts?.['python:publish']).toBe(
			'bash scripts/publish-python-local.sh',
		);
		expect(publishScript).toContain('AGENT_VM_PYPI_TOKEN_OP_REF');
		expect(publishScript).toContain('AGENT_VM_PYPI_TOKEN');
		expect(publishScript).not.toMatch(/AGENT_VM_PYPI_TOKEN_OP_REF:-/u);
		expect(publishScript).toContain('PYTHON_DIST_DIR="$(mktemp -d)"');
		expect(publishScript).toContain('--out-dir "$PYTHON_DIST_DIR"');
		expect(publishScript).not.toContain('dist/*');
		expect(publishScript).toContain('--trusted-publishing never');
		expect(publishScript).toContain('--trusted-publishing always');
		expect(publishScript).toContain('--check-url https://pypi.org/simple');
		expect(publishScript).toContain('uv publish --dry-run');

		const sdkPublishIndex = publishScript.indexOf('"${SDK_ARTIFACTS[@]}"');
		const adapterPublishIndex = publishScript.indexOf('"${ADAPTER_ARTIFACTS[@]}"');
		expect(sdkPublishIndex).toBeGreaterThan(-1);
		expect(adapterPublishIndex).toBeGreaterThan(sdkPublishIndex);

		const dryRunExitIndex = publishScript.indexOf('exit 0');
		const tokenReadIndex = publishScript.indexOf('op read');
		expect(dryRunExitIndex).toBeGreaterThan(-1);
		expect(tokenReadIndex).toBeGreaterThan(dryRunExitIndex);
		expect(publishScript).toContain('export UV_PUBLISH_TOKEN');
		expect(publishScript).toContain('unset PYPI_TOKEN');
		expect(publishScript).not.toContain('.pypirc');
	});

	it('publishes the synchronized package train from the exact successful master CI commit', async () => {
		const [agentsGuidance, managedImagesWorkflow, releaseWorkflow, trustedPublishScript] =
			await Promise.all([
				fs.readFile(path.join(process.cwd(), 'AGENTS.md'), 'utf8'),
				fs.readFile(path.join(process.cwd(), '.github', 'workflows', 'publish.yml'), 'utf8'),
				fs.readFile(path.join(process.cwd(), '.github', 'workflows', 'release.yml'), 'utf8'),
				fs.readFile(path.join(process.cwd(), 'scripts', 'publish-trusted-release.sh'), 'utf8'),
			]);

		expect(agentsGuidance).toContain('pnpm release:version -- <version>');
		expect(agentsGuidance).toContain('.github/workflows/release.yml');
		expect(agentsGuidance).toContain('npm trust github <package>');
		expect(agentsGuidance).toContain('remains the break-glass publisher');

		expect(managedImagesWorkflow).not.toContain('id-token: write');
		expect(managedImagesWorkflow).not.toContain('Publish to npm via OIDC');
		expect(managedImagesWorkflow).not.toContain('publish_npm');

		expect(releaseWorkflow).toContain('workflow_run:');
		expect(releaseWorkflow).toContain('workflows: [CI]');
		expect(releaseWorkflow).toContain('branches: [master]');
		expect(releaseWorkflow).toContain("github.event.workflow_run.conclusion == 'success'");
		expect(releaseWorkflow).toContain('ref: ${{ github.event.workflow_run.head_sha }}');
		expect(releaseWorkflow).toContain('persist-credentials: false');
		expect(releaseWorkflow).toContain('if [[ "${RELEASE_VERSION}" == "${PREVIOUS_VERSION}" ]]');
		expect(releaseWorkflow).toContain('RELEASE_REQUIRED="false"');
		expect(releaseWorkflow).toContain('RELEASE_REQUIRED="true"');
		expect(releaseWorkflow).toContain('id-token: write');
		expect(releaseWorkflow).toContain('contents: read');
		expect(releaseWorkflow).toContain('contents: write');
		expect(releaseWorkflow).toContain('scripts/publish-trusted-release.sh');
		expect(releaseWorkflow).toContain('gh release create');
		expect(releaseWorkflow.indexOf('id-token: write')).toBeLessThan(
			releaseWorkflow.indexOf('contents: write'),
		);
		const publishJob = releaseWorkflow.slice(
			releaseWorkflow.indexOf('  publish-packages:'),
			releaseWorkflow.indexOf('  create-release:'),
		);
		const releaseJob = releaseWorkflow.slice(releaseWorkflow.indexOf('  create-release:'));
		expect(publishJob).toContain('id-token: write');
		expect(publishJob).not.toContain('contents: write');
		expect(releaseJob).toContain('contents: write');
		expect(releaseJob).not.toContain('id-token: write');
		expect(releaseJob).toContain('if [[ "${TAGGED_SHA}" != "${RELEASE_SHA}" ]]');
		expect(releaseJob).toContain('points to ${TAGGED_SHA}, expected ${RELEASE_SHA}');

		expect(trustedPublishScript).toContain('bash scripts/check-package-version-sync.sh');
		expect(trustedPublishScript).toContain('pnpm build');
		expect(trustedPublishScript).toContain('scripts/publish-python-local.sh --trusted-publishing');
		expect(trustedPublishScript).toContain('npm view "$package_name@$release_version" version');
		expect(trustedPublishScript).toContain('--filter "$package_name"');
		expect(trustedPublishScript).toContain('pack \\');
		expect(trustedPublishScript).toContain('npm publish "$package_tarball"');
		expect(trustedPublishScript).toContain('--config.ignore-scripts=true');
		expect(trustedPublishScript).toContain('MANAGED_BASE_IMAGE_MANIFEST');
		expect(trustedPublishScript).toContain("['linux/amd64', 'linux/arm64']");
		expect(trustedPublishScript).toContain('NPM_PACKAGE_NAMES_PATH=');
		expect(trustedPublishScript).toContain('npm_package_count=');
		expect(trustedPublishScript.match(/fs\.readdirSync\('packages'\)/gu)).toHaveLength(1);
		const npmExistingVersionIndex = trustedPublishScript.indexOf(
			'npm view "$package_name@$release_version" version',
		);
		const npmSkipIndex = trustedPublishScript.indexOf('continue', npmExistingVersionIndex);
		const npmPublishIndex = trustedPublishScript.indexOf('npm publish "$package_tarball"');
		expect(npmExistingVersionIndex).toBeGreaterThan(-1);
		expect(npmSkipIndex).toBeGreaterThan(npmExistingVersionIndex);
		expect(npmPublishIndex).toBeGreaterThan(npmSkipIndex);
		expect(trustedPublishScript).not.toContain('NPM_TOKEN');
		expect(trustedPublishScript).not.toContain('PYPI_TOKEN');
		expect(trustedPublishScript).not.toContain('op read');
	});

	it('publishes npm and Python packages through one verified release entrypoint', async () => {
		const publishScript = await fs.readFile(
			path.join(process.cwd(), 'scripts', 'publish-local.sh'),
			'utf8',
		);

		expect(publishScript).toContain(
			'PYPI_OP_REF="${AGENT_VM_PYPI_TOKEN_OP_REF:-op://Dev/PyPI/api-token}"',
		);
		expect(publishScript).toContain('scripts/publish-python-local.sh --dry-run');
		expect(publishScript).toContain(
			'AGENT_VM_PYPI_TOKEN="$PYPI_TOKEN" scripts/publish-python-local.sh',
		);
		expect(publishScript).toContain('verify_published_release');
		expect(publishScript).toContain('npm view "$package_name@$release_version" version');
		expect(publishScript).toContain(
			'https://pypi.org/pypi/${python_package}/${release_version}/json',
		);
		expect(publishScript.indexOf('scripts/publish-python-local.sh')).toBeLessThan(
			publishScript.indexOf('pnpm -r publish'),
		);
		expect(publishScript.indexOf('pnpm -r publish')).toBeLessThan(
			publishScript.lastIndexOf('verify_published_release'),
		);
	});

	it('keeps npm and Python release versions synchronized', async () => {
		const versionGuard = await fs.readFile(
			path.join(process.cwd(), 'scripts', 'check-package-version-sync.sh'),
			'utf8',
		);

		expect(versionGuard).toContain('agent-vm-agent-portal-sdk');
		expect(versionGuard).toContain('agent-vm-hermes-adapter');
		expect(versionGuard).toContain(
			'uv version --output-format json --package "$python_package_name"',
		);
		expect(versionGuard).toContain(
			'EXPECTED_ADAPTER_SDK_PIN="agent-vm-agent-portal-sdk==${PACKAGE_VERSION}"',
		);
		expect(versionGuard).toContain('if [[ "$ADAPTER_SDK_PIN" != "$EXPECTED_ADAPTER_SDK_PIN" ]]');
	});
});
