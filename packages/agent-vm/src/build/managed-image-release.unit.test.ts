import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
	generateManagedDockerfile,
	type ManagedImageRelease,
	resolveManagedImageRelease,
} from './managed-image-dockerfile.js';
import {
	managedToolPortalGuide,
	managedToolPortalGuideFileName,
	managedToolVmLoginProfile,
	managedToolVmLoginProfileFileName,
} from './managed-image-tool-portal-guide.js';

const managedOpenAiCodexCliVersion = '0.139.0';
const managedDockerfileForbiddenSecretPattern =
	/TOKEN|Authorization|\.npmrc|\.netrc|_authToken|Bearer/u;

function expectManagedDockerfileToAvoidSecretMaterial(generatedDockerfile: string): void {
	expect(generatedDockerfile).not.toMatch(managedDockerfileForbiddenSecretPattern);
}

function expectToolVmDockerfileToInstallGitHubCliFromStableApt(generatedDockerfile: string): void {
	expect(generatedDockerfile).toContain('uv venv /opt/agent-vm-tools');
	expect(generatedDockerfile).toContain('agent-vm-agent-portal-sdk==');
	expect(generatedDockerfile).toContain('/node_modules');
	expect(generatedDockerfile).toContain(
		'/node_modules/@agent-vm/agent-portal-sdk/dist/cli/tool-portal.js /pnpm/tool-portal',
	);
	expect(generatedDockerfile).not.toContain(
		'node_modules/.bin/tool-portal /pnpm/tool-portal',
	);
	expect(generatedDockerfile).toContain(
		`COPY ${managedToolPortalGuideFileName} /agent-vm/tool-portal.md`,
	);
	expect(generatedDockerfile).toContain(
		`COPY ${managedToolVmLoginProfileFileName} /etc/profile.d/agent-vm-tools.sh`,
	);
	const githubCliKeyringPath = '/usr/share/keyrings/githubcli-archive-keyring.gpg';
	const githubCliSource = 'https://cli.github.com/packages stable main';
	const sourceIndex = generatedDockerfile.indexOf(githubCliSource);
	const installIndex = generatedDockerfile.indexOf('apt-get install -y --no-install-recommends gh');

	expect(generatedDockerfile).toContain(
		'https://cli.github.com/packages/githubcli-archive-keyring.gpg',
	);
	expect(generatedDockerfile).toContain(`signed-by=${githubCliKeyringPath}`);
	expect(generatedDockerfile).toContain(githubCliSource);
	expect(sourceIndex).toBeGreaterThan(-1);
	expect(installIndex).toBeGreaterThan(sourceIndex);
}

function createTestManagedImageRelease(): ManagedImageRelease {
	return {
		baseImages: {
			'worker-gateway': {
				packageOverrides: {
					npm: [`@openai/codex@${managedOpenAiCodexCliVersion}`],
				},
				repository: 'ghcr.io/shravansunder/agent-vm-managed-worker-gateway-base',
				tag: '2026.05.27.1',
			},
			'tool-vm': {
				packageOverrides: {
					npm: [],
				},
				repository: 'ghcr.io/shravansunder/agent-vm-managed-tool-vm-base',
				tag: '2026.05.27.1',
			},
		},
	};
}

describe('managed image release', () => {
	it('keeps managed image tags separate from npm package versions', async () => {
		const release = await resolveManagedImageRelease();

		expect(release.baseImages['worker-gateway']).toMatchObject({
			repository: 'ghcr.io/shravansunder/agent-vm-managed-worker-gateway-base',
			packageOverrides: {
				npm: [`@openai/codex@${managedOpenAiCodexCliVersion}`],
			},
			tag: '2026.05.27.1',
		});
		expect(release.baseImages['tool-vm']).toMatchObject({
			repository: 'ghcr.io/shravansunder/agent-vm-managed-tool-vm-base',
			tag: '2026.05.27.1',
		});
		expect(release).not.toHaveProperty('openAiCodexCliVersion');
		expect(release.baseImages['tool-vm'].tag).not.toMatch(/^0\.0\.\d+$/u);
	});

	it('rejects deployment overlay pnpm overrides', async () => {
		const temporaryDirectory = await fs.mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-managed-pnpm-overrides-'),
		);
		const overlayPath = path.join(temporaryDirectory, 'overlay.jsonc');
		const outputDirectory = path.join(temporaryDirectory, 'generated');
		await fs.writeFile(
			overlayPath,
			[
				'{',
				'  "schemaVersion": 1,',
				'  "pnpmOverrides": {',
				'    "undici": "8.5.0"',
				'  }',
				'}',
				'',
			].join('\n'),
			'utf8',
		);

		await expect(
			generateManagedDockerfile({
				base: 'worker-gateway',
				imageTargetFamily: 'gateway',
				imageTargetName: 'worker',
				managedImageRelease: createTestManagedImageRelease(),
				outputDirectory,
				overlayPath,
			}),
		).rejects.toThrow(/accepts only exact npm package pins/u);
	});

	it('accepts legacy uppercase direct npm package override names', async () => {
		const temporaryDirectory = await fs.mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-managed-legacy-uppercase-npm-'),
		);
		const overlayPath = path.join(temporaryDirectory, 'overlay.jsonc');
		const outputDirectory = path.join(temporaryDirectory, 'generated');
		await fs.writeFile(
			overlayPath,
			[
				'{',
				'  "schemaVersion": 1,',
				'  "packageOverrides": {',
				'    "npm": ["JSONStream@1.3.5"]',
				'  }',
				'}',
				'',
			].join('\n'),
			'utf8',
		);

		const result = await generateManagedDockerfile({
			base: 'tool-vm',
			imageTargetFamily: 'toolVm',
			imageTargetName: 'default',
			managedImageRelease: createTestManagedImageRelease(),
			outputDirectory,
			overlayPath,
		});

		const generatedDockerfile = await fs.readFile(result.dockerfilePath, 'utf8');
		expect(generatedDockerfile).toContain('RUN pnpm add -g --ignore-scripts "JSONStream@1.3.5"');
		expect(result.plan.directNpmPackages).toEqual([
			{
				name: 'JSONStream',
				source: 'overlay.jsonc/packageOverrides.npm',
				spec: 'JSONStream@1.3.5',
				version: '1.3.5',
			},
		]);
	});

	it('renders direct npm package overrides for worker gateway images', async () => {
		const temporaryDirectory = await fs.mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-managed-direct-npm-worker-'),
		);
		const overlayPath = path.join(temporaryDirectory, 'overlay.jsonc');
		const outputDirectory = path.join(temporaryDirectory, 'generated');
		await fs.writeFile(
			overlayPath,
			[
				'{',
				'  "schemaVersion": 1,',
				'  "packageOverrides": {',
				'    "npm": ["zx@8.1.0"]',
				'  }',
				'}',
				'',
			].join('\n'),
			'utf8',
		);

		const result = await generateManagedDockerfile({
			base: 'worker-gateway',
			imageTargetFamily: 'gateway',
			imageTargetName: 'worker',
			managedImageRelease: createTestManagedImageRelease(),
			outputDirectory,
			overlayPath,
		});

		const generatedDockerfile = await fs.readFile(result.dockerfilePath, 'utf8');
		expect(generatedDockerfile).toContain('ENV PNPM_HOME=/pnpm');
		expect(generatedDockerfile).toContain(
			'RUN pnpm add -g --ignore-scripts "@openai/codex@0.139.0" "zx@8.1.0"',
		);
		expect(result.plan.directNpmPackages.map((packageEntry) => packageEntry.name)).toEqual([
			'@openai/codex',
			'zx',
		]);
	});

	it('renders direct npm package overrides for Tool VM images', async () => {
		const temporaryDirectory = await fs.mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-managed-direct-npm-tool-vm-'),
		);
		const overlayPath = path.join(temporaryDirectory, 'overlay.jsonc');
		const outputDirectory = path.join(temporaryDirectory, 'generated');
		await fs.writeFile(
			overlayPath,
			[
				'{',
				'  "schemaVersion": 1,',
				'  "packageOverrides": {',
				'    "npm": ["zx@8.1.0"]',
				'  }',
				'}',
				'',
			].join('\n'),
			'utf8',
		);

		const result = await generateManagedDockerfile({
			base: 'tool-vm',
			imageTargetFamily: 'toolVm',
			imageTargetName: 'default',
			managedImageRelease: createTestManagedImageRelease(),
			outputDirectory,
			overlayPath,
		});

		const generatedDockerfile = await fs.readFile(result.dockerfilePath, 'utf8');
		expect(generatedDockerfile).toContain('RUN pnpm add -g "@agent-vm/mcp-portal@');
		expect(generatedDockerfile).toContain('RUN pnpm add -g --ignore-scripts "zx@8.1.0"');
		expect(result.plan.directNpmPackages).toEqual([
			{
				name: 'zx',
				source: 'overlay.jsonc/packageOverrides.npm',
				spec: 'zx@8.1.0',
				version: '8.1.0',
			},
		]);
	});

	it('rejects malformed scoped direct npm package overrides before Docker generation', async () => {
		const temporaryDirectory = await fs.mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-managed-malformed-npm-'),
		);
		const overlayPath = path.join(temporaryDirectory, 'overlay.jsonc');
		const outputDirectory = path.join(temporaryDirectory, 'generated');
		await fs.writeFile(
			overlayPath,
			[
				'{',
				'  "schemaVersion": 1,',
				'  "packageOverrides": {',
				'    "npm": ["@scope/@1.2.3"]',
				'  }',
				'}',
				'',
			].join('\n'),
			'utf8',
		);

		await expect(
			generateManagedDockerfile({
				base: 'tool-vm',
				imageTargetFamily: 'toolVm',
				imageTargetName: 'default',
				managedImageRelease: createTestManagedImageRelease(),
				outputDirectory,
				overlayPath,
			}),
		).rejects.toThrow(/Package override specs require valid npm package names/u);
	});

	it('installs MCP Portal in Tool VM Dockerfiles without credential literals', async () => {
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-tool-vm-plan-'));
		const overlayPath = path.join(temporaryDirectory, 'overlay.jsonc');
		const outputDirectory = path.join(temporaryDirectory, 'generated');
		await fs.writeFile(
			overlayPath,
			[
				'{',
				'  "schemaVersion": 1,',
				'  "extraAptPackages": [],',
				'  "runAfterBase": []',
				'}',
				'',
			].join('\n'),
			'utf8',
		);

		const result = await generateManagedDockerfile({
			base: 'tool-vm',
			imageTargetFamily: 'toolVm',
			imageTargetName: 'default',
			managedImageRelease: createTestManagedImageRelease(),
			outputDirectory,
			overlayPath,
		});

		const generatedDockerfile = await fs.readFile(result.dockerfilePath, 'utf8');
		const generatedToolPortalGuide = await fs.readFile(
			path.join(outputDirectory, managedToolPortalGuideFileName),
			'utf8',
		);
		const generatedToolVmLoginProfile = await fs.readFile(
			path.join(outputDirectory, managedToolVmLoginProfileFileName),
			'utf8',
		);
		expect(generatedDockerfile).toContain(
			'RUN rm -rf /scratch && install -d -m 0755 /work /workspace',
		);
		expectToolVmDockerfileToInstallGitHubCliFromStableApt(generatedDockerfile);
		expect(generatedDockerfile).toContain('ENV PNPM_HOME=/pnpm');
		expect(generatedDockerfile).toContain('ENV PATH=${PNPM_HOME}:${PATH}');
		expect(generatedDockerfile).toContain(
			'RUN pnpm config set global-dir /pnpm/global && pnpm config set global-bin-dir /pnpm',
		);
		expect(generatedDockerfile).toContain('RUN pnpm add -g "@agent-vm/mcp-portal@');
		expectManagedDockerfileToAvoidSecretMaterial(generatedDockerfile);
		expect(generatedToolPortalGuide).toBe(managedToolPortalGuide);
		expect(generatedToolPortalGuide).toContain('async with connect_tool_portal() as portal:');
		expect(generatedToolPortalGuide).toContain('const portal = await connectToolPortal();');
		expect(generatedToolPortalGuide).toContain(
			'CLI (managed transport is automatic; omit transport flags)',
		);
		expect(generatedToolPortalGuide).not.toContain('--transport');
		expect(generatedToolVmLoginProfile).toBe(managedToolVmLoginProfile);
		expect(generatedToolVmLoginProfile).toBe(
			'export PATH=/opt/agent-vm-tools/bin:/pnpm:$PATH\n',
		);
		expect(result.plan.mcpPortalPackage).toMatchObject({
			name: '@agent-vm/mcp-portal',
			source: 'installed-package',
		});
	});

	it('uses local overlay packages for Tool VM MCP Portal during beta tarball sync builds', async () => {
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-tool-vm-local-'));
		const overlayDirectory = path.join(temporaryDirectory, 'overlay-source');
		const localPackageDirectory = path.join(overlayDirectory, 'local-agent-vm');
		const overlayPath = path.join(overlayDirectory, 'overlay.jsonc');
		const outputDirectory = path.join(temporaryDirectory, 'generated');
		await fs.mkdir(localPackageDirectory, { recursive: true });
		await fs.writeFile(path.join(localPackageDirectory, 'agent-vm-mcp-portal-0.0.93-local.tgz'), '');
		await fs.writeFile(
			overlayPath,
			[
				'{',
				'  "schemaVersion": 1,',
				'  "copy": [',
				'    {',
				'      "from": "local-agent-vm/agent-vm-mcp-portal-0.0.93-local.tgz",',
				'      "to": "/tmp/agent-vm-mcp-portal-0.0.93-local.tgz"',
				'    }',
				'  ],',
				'  "runAfterBase": [',
				'    "cd /opt/agent-vm/local-packages && pnpm install --prod --ignore-scripts",',
				'    "ln -sfn /opt/agent-vm/local-packages/node_modules/.bin/mcp-portal /pnpm/mcp-portal"',
				'  ]',
				'}',
				'',
			].join('\n'),
			'utf8',
		);

		const result = await generateManagedDockerfile({
			base: 'tool-vm',
			imageTargetFamily: 'toolVm',
			imageTargetName: 'default',
			managedImageRelease: createTestManagedImageRelease(),
			outputDirectory,
			overlayPath,
		});

		const generatedDockerfile = await fs.readFile(result.dockerfilePath, 'utf8');
		expectToolVmDockerfileToInstallGitHubCliFromStableApt(generatedDockerfile);
		expect(generatedDockerfile).not.toContain('RUN pnpm add -g "@agent-vm/mcp-portal@');
		expect(generatedDockerfile).toContain(
			'COPY overlay/local-agent-vm/agent-vm-mcp-portal-0.0.93-local.tgz /tmp/agent-vm-mcp-portal-0.0.93-local.tgz',
		);
		expect(generatedDockerfile).toContain(
			'ln -sfn /opt/agent-vm/local-packages/node_modules/.bin/mcp-portal /pnpm/mcp-portal',
		);
		expect(result.plan.mcpPortalPackage).toMatchObject({
			name: '@agent-vm/mcp-portal',
			source: 'local-overlay',
			spec: 'local-agent-vm',
		});
	});

	it('rejects the removed framework-specific package override bucket', async () => {
		const temporaryDirectory = await fs.mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-managed-override-'),
		);
		const overlayPath = path.join(temporaryDirectory, 'overlay.jsonc');
		const outputDirectory = path.join(temporaryDirectory, 'generated');
		await fs.writeFile(
			overlayPath,
				[
					'{',
					'  "schemaVersion": 1,',
					'  "extraAptPackages": [],',
					'  "packageOverrides": {',
					'    "openclaw": ["@agent-vm/mcp-portal@0.0.1"]',
					'  },',
					'  "runAfterBase": []',
				'}',
				'',
			].join('\n'),
			'utf8',
		);

		await expect(
			generateManagedDockerfile({
				base: 'worker-gateway',
				imageTargetFamily: 'gateway',
				imageTargetName: 'worker',
				managedImageRelease: createTestManagedImageRelease(),
				outputDirectory,
				overlayPath,
			}),
		).rejects.toThrow(/Unrecognized key: "openclaw"/u);
	});
});
