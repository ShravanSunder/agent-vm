import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
	AGENT_VM_PACKAGE_NAMES,
	GONDOLIN_EXACT_VM_PATCH_RELATIVE_PATH,
	GONDOLIN_EXACT_VM_PATCH_SHA256,
	OPENCLAW_GATEWAY_TARBALL_PACKAGE_NAMES,
	TOOL_VM_TARBALL_PACKAGE_NAMES,
	assertGondolinPatchIdentity,
	calculateGondolinPatchSha256,
	createBetaTarballSyncPlan,
	listStaleLocalOverlayFileNames,
	migrateLegacyOpenClawPackageOverrides,
	parseCliOptions,
	renderBetaPnpmWorkspace,
	renderOpenClawGatewayOverlay,
	renderToolVmOverlay,
	refreshBetaDeploymentTarballArtifacts,
	resolveBetaPnpmInstallArgs,
	resolveBetaPnpmInstallEnvironment,
	resolvePnpmPackArgs,
	updateBetaPackageManifest,
} from './sync-local-tarballs-to-deployment.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((temporaryDirectory) => rm(temporaryDirectory, { force: true, recursive: true })),
	);
});

async function createTemporaryDirectory(prefix: string): Promise<string> {
	const temporaryDirectory = await mkdtemp(path.join(tmpdir(), prefix));
	temporaryDirectories.push(temporaryDirectory);
	return temporaryDirectory;
}

async function writeJsonFixture(filePath: string, value: unknown): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, `${JSON.stringify(value, null, '\t')}\n`);
}

describe('beta tarball sync planning', () => {
	it('pins the default Gondolin patch identity to the current workspace patch', async () => {
		const patchBytes = await readFile(
			new URL(`../${GONDOLIN_EXACT_VM_PATCH_RELATIVE_PATH}`, import.meta.url),
		);

		expect(calculateGondolinPatchSha256(patchBytes)).toBe(GONDOLIN_EXACT_VM_PATCH_SHA256);
	});

	it('rejects Gondolin patch bytes that do not match the frozen identity', () => {
		expect(() => assertGondolinPatchIdentity(Buffer.from('wrong patch'), '0'.repeat(64))).toThrow(
			/Gondolin exact-VM patch SHA-256 mismatch/u,
		);
	});

	it('pins the host install and every workspace override to one tarball directory', () => {
		const plan = createBetaTarballSyncPlan({
			cacheKey: 'abc123ef',
			tarballDirectoryReference: '../agent-vm/tmp/beta-tarballs-abc123ef',
			version: '0.0.82',
		});

		expect(plan.packages.map((packageEntry) => packageEntry.name)).toEqual(AGENT_VM_PACKAGE_NAMES);
		expect(plan.gatewayPackages.map((packageEntry) => packageEntry.name)).toEqual(
			OPENCLAW_GATEWAY_TARBALL_PACKAGE_NAMES,
		);
		expect(plan.toolVmPackages.map((packageEntry) => packageEntry.name)).toEqual(
			TOOL_VM_TARBALL_PACKAGE_NAMES,
		);
		expect(plan.hostPackageSpecifier).toBe(
			'file:../agent-vm/tmp/beta-tarballs-abc123ef/agent-vm-agent-vm-0.0.82.tgz',
		);
		expect(
			plan.packages.find((packageEntry) => packageEntry.name === '@agent-vm/gateway-interface')
				?.specifier,
		).toBe('file:../agent-vm/tmp/beta-tarballs-abc123ef/agent-vm-gateway-interface-0.0.82.tgz');
		expect(plan.packages.map((packageEntry) => packageEntry.name)).toContain(
			'@agent-vm/agent-portal-sdk',
		);
		expect(plan.packages.map((packageEntry) => packageEntry.name)).toContain(
			'@agent-vm/controller-execution-contracts',
		);
		expect(plan.packages.map((packageEntry) => packageEntry.name)).toContain(
			'@agent-vm/tool-portal',
		);
	});

	it('renders pnpm-workspace.yaml with overrides in the pnpm v10 location', () => {
		const plan = createBetaTarballSyncPlan({
			cacheKey: 'abc123ef',
			tarballDirectoryReference: '../agent-vm/tmp/beta-tarballs-abc123ef',
			version: '0.0.82',
		});

		const workspaceYaml = renderBetaPnpmWorkspace({
			onlyBuiltDependencies: ['@google/genai', 'openclaw', 'ssh2'],
			plan,
		});

		expect(workspaceYaml).toContain('packages: []');
		expect(workspaceYaml).toContain('patchedDependencies:');
		expect(workspaceYaml).toContain("'@earendil-works/gondolin@0.12.0': patches/");
		expect(workspaceYaml).toContain('  - "@google/genai"');
		expect(workspaceYaml).toContain('  - "openclaw"');
		expect(workspaceYaml).toContain(
			"  '@agent-vm/openclaw-agent-vm-plugin': file:../agent-vm/tmp/beta-tarballs-abc123ef/agent-vm-openclaw-agent-vm-plugin-0.0.82.tgz",
		);
		expect(workspaceYaml).not.toContain('pnpm:');
	});

	it('omits onlyBuiltDependencies when the deployment does not configure built dependencies', () => {
		const plan = createBetaTarballSyncPlan({
			cacheKey: 'abc123ef',
			tarballDirectoryReference: '../agent-vm/tmp/beta-tarballs-abc123ef',
			version: '0.0.82',
		});

		const workspaceYaml = renderBetaPnpmWorkspace({
			onlyBuiltDependencies: [],
			plan,
		});

		expect(workspaceYaml).not.toContain('onlyBuiltDependencies:');
		expect(workspaceYaml).toContain('overrides:');
	});

	it('updates beta package.json without leaving pnpm overrides in package.json', () => {
		const plan = createBetaTarballSyncPlan({
			cacheKey: 'abc123ef',
			tarballDirectoryReference: '../agent-vm/tmp/beta-tarballs-abc123ef',
			version: '0.0.82',
		});

		const manifest = updateBetaPackageManifest({
			manifest: {
				name: 'shravan-claw-beta',
				dependencies: { '@agent-vm/agent-vm': '0.0.81' },
				pnpm: { onlyBuiltDependencies: ['openclaw'] },
			},
			plan,
		});

		expect(manifest).toEqual({
			name: 'shravan-claw-beta',
			dependencies: {
				'@agent-vm/agent-vm':
					'file:../agent-vm/tmp/beta-tarballs-abc123ef/agent-vm-agent-vm-0.0.82.tgz',
			},
		});
	});

	it('accepts the leading separator pnpm passes to scripts', () => {
		const options = parseCliOptions([
			'--',
			'--deployment',
			'../shravan-claw-beta',
			'--hash',
			'adb797d4',
			'--skip-build',
			'--skip-install',
		]);

		expect(options).toMatchObject({
			hash: 'adb797d4',
			skipInstall: true,
			skipBuild: true,
		});
		expect(options.deploymentDirectory).toContain('shravan-claw-beta');
	});

	it('uses pnpm config syntax for disabling prepack rebuilds', () => {
		expect(
			resolvePnpmPackArgs({
				packageName: '@agent-vm/agent-vm',
				tarballDirectory: '/repo/tmp/beta-tarballs-abc123ef',
			}),
		).toEqual([
			'--filter',
			'@agent-vm/agent-vm',
			'pack',
			'--pack-destination',
			'/repo/tmp/beta-tarballs-abc123ef',
			'--json',
			'--config.ignore-scripts=true',
		]);
	});

	it('uses a non-frozen noninteractive install for local beta tarball sync', () => {
		expect(resolveBetaPnpmInstallArgs()).toEqual(['install', '--no-frozen-lockfile']);
		expect(resolveBetaPnpmInstallEnvironment()).toEqual({
			CI: 'true',
			PNPM_CONFIG_CONFIRM_MODULES_PURGE: 'false',
		});
	});

	it('selects superseded local overlay package files for pruning', () => {
		const plan = createBetaTarballSyncPlan({
			cacheKey: 'abc123ef',
			tarballDirectoryReference: '../agent-vm/tmp/beta-tarballs-abc123ef',
			version: '0.0.82',
		});

		expect(
			listStaleLocalOverlayFileNames({
				existingFileNames: [
					'agent-vm-agent-portal-sdk-0.0.82-abc123ef.tgz',
					'agent-vm-openclaw-agent-vm-plugin-0.0.82-oldhash.tgz',
					'agent-vm-openclaw-mcp-portal-plugin-0.0.82-oldhash.tgz',
					'agent-vm-local-packages-openclaw-gateway-oldhash.json',
					'README.md',
				],
				packageEntries: plan.gatewayPackages,
			}),
		).toEqual([
			'agent-vm-openclaw-agent-vm-plugin-0.0.82-oldhash.tgz',
			'agent-vm-openclaw-mcp-portal-plugin-0.0.82-oldhash.tgz',
			'agent-vm-local-packages-openclaw-gateway-oldhash.json',
		]);
	});
});

describe('beta tarball deployment artifact refresh', () => {
	it('updates host manifests and VM overlays before install is required', async () => {
		const workspaceDirectory = await createTemporaryDirectory('agent-vm-beta-sync-');
		const deploymentDirectory = path.join(workspaceDirectory, 'shravan-claw-beta');
		const tarballDirectory = path.join(
			workspaceDirectory,
			'agent-vm',
			'tmp',
			'beta-tarballs-newhash01',
		);
		const openClawOverlayDirectory = path.join(
			deploymentDirectory,
			'vm-images',
			'gateways',
			'openclaw',
		);
		const toolVmOverlayDirectory = path.join(
			deploymentDirectory,
			'vm-images',
			'tool-vms',
			'default',
		);
		const gondolinPatchFilePath = path.join(workspaceDirectory, 'gondolin-exact-vm.patch');
		const gondolinPatchBytes = Buffer.from('test Gondolin exact-VM patch bytes');
		await writeFile(gondolinPatchFilePath, gondolinPatchBytes);
		const plan = createBetaTarballSyncPlan({
			cacheKey: 'newhash01',
			gondolinPatchSha256: calculateGondolinPatchSha256(gondolinPatchBytes),
			tarballDirectoryReference: '../agent-vm/tmp/beta-tarballs-newhash01',
			version: '0.0.110',
		});

		await mkdir(tarballDirectory, { recursive: true });
		await Promise.all(
			plan.packages.map((packageEntry) =>
				writeFile(path.join(tarballDirectory, packageEntry.fileName), 'fake package'),
			),
		);
		await writeJsonFixture(path.join(deploymentDirectory, 'package.json'), {
			dependencies: {
				'@agent-vm/agent-vm':
					'file:../agent-vm/tmp/beta-tarballs-oldhash/agent-vm-agent-vm-0.0.110.tgz',
			},
			name: 'shravan-claw-beta',
			pnpm: {
				onlyBuiltDependencies: ['openclaw'],
			},
		});
		await writeJsonFixture(path.join(openClawOverlayDirectory, 'overlay.jsonc'), {
			copy: [
				{
					from: 'local-agent-vm/agent-vm-openclaw-agent-vm-plugin-0.0.110-oldhash00.tgz',
					to: '/tmp/agent-vm-openclaw-agent-vm-plugin-0.0.110-oldhash00.tgz',
				},
			],
			extraAptPackages: ['ffmpeg'],
			runAfterBase: [
				'echo keep',
				'rm -f /tmp/agent-vm-openclaw-agent-vm-plugin-0.0.110-oldhash00.tgz',
			],
		});
		await writeJsonFixture(path.join(toolVmOverlayDirectory, 'overlay.jsonc'), {
			copy: [
				{
					from: 'local-agent-vm/agent-vm-mcp-portal-0.0.110-oldhash00.tgz',
					to: '/tmp/agent-vm-mcp-portal-0.0.110-oldhash00.tgz',
				},
			],
			runAfterBase: ['rm -f /tmp/agent-vm-mcp-portal-0.0.110-oldhash00.tgz'],
		});
		await mkdir(path.join(openClawOverlayDirectory, 'local-agent-vm'), { recursive: true });
		await mkdir(path.join(toolVmOverlayDirectory, 'local-agent-vm'), { recursive: true });
		await writeFile(
			path.join(
				openClawOverlayDirectory,
				'local-agent-vm',
				'agent-vm-openclaw-agent-vm-plugin-0.0.110-oldhash00.tgz',
			),
			'stale gateway package',
		);
		await writeFile(
			path.join(
				toolVmOverlayDirectory,
				'local-agent-vm',
				'agent-vm-mcp-portal-0.0.110-oldhash00.tgz',
			),
			'stale tool package',
		);

		await refreshBetaDeploymentTarballArtifacts({
			deploymentDirectory,
			gondolinPatchFilePath,
			managedOpenClawGatewayPackageOverrides: {
				npm: [],
				openclaw: [],
				pnpm: {},
			},
			plan,
			tarballDirectory,
		});

		const packageJson = await readFile(path.join(deploymentDirectory, 'package.json'), 'utf8');
		const workspaceYaml = await readFile(
			path.join(deploymentDirectory, 'pnpm-workspace.yaml'),
			'utf8',
		);
		const openClawOverlayJson = await readFile(
			path.join(openClawOverlayDirectory, 'overlay.jsonc'),
			'utf8',
		);
		const toolVmOverlayJson = await readFile(
			path.join(toolVmOverlayDirectory, 'overlay.jsonc'),
			'utf8',
		);
		const openClawLocalFileNames = await readdir(
			path.join(openClawOverlayDirectory, 'local-agent-vm'),
		);
		const toolVmLocalFileNames = await readdir(path.join(toolVmOverlayDirectory, 'local-agent-vm'));
		const deploymentPatchBytes = await readFile(
			path.join(deploymentDirectory, plan.gondolinPatch.workspaceRelativePath),
		);
		const gatewayPatchBytes = await readFile(
			path.join(openClawOverlayDirectory, 'local-agent-vm', plan.gondolinPatch.overlayFileName),
		);

		expect(packageJson).toContain(
			'../agent-vm/tmp/beta-tarballs-newhash01/agent-vm-agent-vm-0.0.110.tgz',
		);
		expect(packageJson).not.toContain('oldhash');
		expect(workspaceYaml).toContain(
			"'@agent-vm/openclaw-agent-vm-plugin': file:../agent-vm/tmp/beta-tarballs-newhash01/agent-vm-openclaw-agent-vm-plugin-0.0.110.tgz",
		);
		expect(calculateGondolinPatchSha256(deploymentPatchBytes)).toBe(plan.gondolinPatch.sha256);
		expect(calculateGondolinPatchSha256(gatewayPatchBytes)).toBe(plan.gondolinPatch.sha256);
		expect(openClawOverlayJson).toContain(
			'local-agent-vm/agent-vm-openclaw-agent-vm-plugin-0.0.110-newhash01.tgz',
		);
		expect(openClawOverlayJson).not.toContain('oldhash00');
		expect(toolVmOverlayJson).toContain('local-agent-vm/agent-vm-mcp-portal-0.0.110-newhash01.tgz');
		expect(toolVmOverlayJson).not.toContain('oldhash00');
		expect(openClawLocalFileNames).toContain(
			'agent-vm-openclaw-agent-vm-plugin-0.0.110-newhash01.tgz',
		);
		expect(openClawLocalFileNames).not.toContain(
			'agent-vm-openclaw-agent-vm-plugin-0.0.110-oldhash00.tgz',
		);
		expect(toolVmLocalFileNames).toContain('agent-vm-mcp-portal-0.0.110-newhash01.tgz');
		expect(toolVmLocalFileNames).not.toContain('agent-vm-mcp-portal-0.0.110-oldhash00.tgz');
	});
});

describe('openclaw gateway overlay rendering', () => {
	const managedPackageOverrides = {
		npm: ['@openai/codex@0.139.0'],
		openclaw: ['openclaw@2026.6.8', '@openclaw/codex@2026.6.8'],
		pnpm: { undici: '8.5.0' },
	};

	it('rejects legacy OpenClaw package overrides on managed image overlays', () => {
		expect(() =>
			migrateLegacyOpenClawPackageOverrides({
				extraAptPackages: ['ffmpeg'],
				extraOpenClawPackages: [],
				runAfterBase: ['echo ok'],
			}),
		).toThrow(/move extraOpenClawPackages to packageOverrides\.openclaw/u);
		expect(() =>
			migrateLegacyOpenClawPackageOverrides({
				extraAptPackages: ['ffmpeg'],
				openClawPackageOverrides: ['openclaw@2026.6.8'],
				runAfterBase: ['echo ok'],
			}),
		).toThrow(/move openClawPackageOverrides to packageOverrides\.openclaw/u);
		expect(() =>
			migrateLegacyOpenClawPackageOverrides({
				extraAptPackages: ['ffmpeg'],
				pnpmOverrides: { undici: '8.5.0' },
				runAfterBase: ['echo ok'],
			}),
		).toThrow(/move pnpmOverrides to packageOverrides\.pnpm/u);
	});

	it('preserves clean managed image overlays without package overrides', () => {
		const overlay = migrateLegacyOpenClawPackageOverrides({
			extraAptPackages: ['ffmpeg'],
			runAfterBase: ['echo ok'],
		});

		expect(overlay).toEqual({
			extraAptPackages: ['ffmpeg'],
			runAfterBase: ['echo ok'],
		});
		expect(overlay.extraOpenClawPackages).toBeUndefined();
	});

	it('installs local gateway packages through a pnpm project with transitive overrides', () => {
		const plan = createBetaTarballSyncPlan({
			cacheKey: 'abc123ef',
			tarballDirectoryReference: '../agent-vm/tmp/beta-tarballs-abc123ef',
			version: '0.0.82',
		});

		const overlay = renderOpenClawGatewayOverlay({
			existingOverlay: {
				extraAptPackages: ['ffmpeg'],
				packageOverrides: {
					npm: [],
					openclaw: ['openclaw@2026.5.20'],
					pnpm: {},
				},
			},
			plan,
		});
		const overlayJson = JSON.stringify(overlay, null, 2);

		expect(
			overlay.copy
				.map((copyEntry) => copyEntry.from)
				.filter((copyPath) => copyPath.endsWith('.tgz')),
		).toEqual(
			OPENCLAW_GATEWAY_TARBALL_PACKAGE_NAMES.map(
				(packageName) =>
					`local-agent-vm/${packageName.replace('@agent-vm/', 'agent-vm-')}-0.0.82-abc123ef.tgz`,
			),
		);
		expect(overlay.copy.at(-1)?.from).toBe(`local-agent-vm/${plan.gondolinPatch.overlayFileName}`);
		expect(overlay.runAfterBase).toEqual([
			'mkdir -p /opt/agent-vm/local-packages',
			expect.stringContaining(
				'"@agent-vm/gateway-interface": "file:/tmp/agent-vm-gateway-interface-0.0.82-abc123ef.tgz"',
			),
			expect.stringContaining("'@earendil-works/gondolin@0.12.0': /tmp/"),
			'cd /opt/agent-vm/local-packages && pnpm install --prod --ignore-scripts',
			expect.stringContaining(
				'ln -sfn /opt/agent-vm/local-packages/node_modules/@agent-vm/openclaw-agent-vm-plugin',
			),
			expect.any(String),
		]);
		expect(overlay.runAfterBase.at(-1)).toContain(
			'/tmp/agent-vm-config-contracts-0.0.82-abc123ef.tgz',
		);
		expect(overlay.runAfterBase.at(-1)).toContain(
			'/tmp/agent-vm-agent-portal-sdk-0.0.82-abc123ef.tgz',
		);
		expect(overlayJson).toContain('@agent-vm/agent-portal-sdk');
		expect(overlayJson).toContain('file:/tmp/agent-vm-agent-portal-sdk-0.0.82-abc123ef.tgz');
		expect(overlayJson).toContain('@earendil-works/gondolin@0.12.0');
		expect(overlayJson).toContain('.patch');
		expect(overlayJson).not.toContain('npm install --prefix');
		expect(overlayJson).not.toContain('pnpm add -g');
		expect(overlayJson).not.toContain('rm -rf');
		expect(overlayJson).not.toContain('cp -R');
		expect(overlay.packageOverrides?.openclaw).toEqual(['openclaw@2026.5.20']);
		expect(overlay.extraOpenClawPackages).toBeUndefined();
	});

	it('preserves the current package override field without writing legacy names', () => {
		const plan = createBetaTarballSyncPlan({
			cacheKey: 'abc123ef',
			tarballDirectoryReference: '../agent-vm/tmp/beta-tarballs-abc123ef',
			version: '0.0.82',
		});

		const overlay = renderOpenClawGatewayOverlay({
			existingOverlay: {
				extraAptPackages: ['ffmpeg'],
				packageOverrides: {
					npm: [],
					openclaw: ['openclaw@2026.5.21'],
					pnpm: {},
				},
			},
			plan,
		});

		expect(overlay.packageOverrides?.openclaw).toEqual(['openclaw@2026.5.21']);
		expect(overlay.extraOpenClawPackages).toBeUndefined();
	});

	it('removes redundant core managed-default package overrides', () => {
		const plan = createBetaTarballSyncPlan({
			cacheKey: 'abc123ef',
			tarballDirectoryReference: '../agent-vm/tmp/beta-tarballs-abc123ef',
			version: '0.0.82',
		});

		const overlay = renderOpenClawGatewayOverlay({
			existingOverlay: {
				extraAptPackages: ['ffmpeg'],
				packageOverrides: {
					npm: ['@openai/codex@0.139.0'],
					openclaw: ['openclaw@2026.6.8', '@openclaw/codex@2026.6.8'],
					pnpm: { undici: '8.5.0' },
				},
			},
			managedPackageOverrides,
			plan,
		});

		expect(overlay.packageOverrides).toBeUndefined();
	});

	it('preserves Discord pins because Discord is a conditional package, not an unconditional managed default', () => {
		const plan = createBetaTarballSyncPlan({
			cacheKey: 'abc123ef',
			tarballDirectoryReference: '../agent-vm/tmp/beta-tarballs-abc123ef',
			version: '0.0.82',
		});

		const overlay = renderOpenClawGatewayOverlay({
			existingOverlay: {
				extraAptPackages: ['ffmpeg'],
				packageOverrides: {
					npm: [],
					openclaw: ['openclaw@2026.6.8', '@openclaw/codex@2026.6.8', '@openclaw/discord@2026.6.8'],
					pnpm: { undici: '8.5.0' },
				},
			},
			managedPackageOverrides,
			plan,
		});

		expect(overlay.packageOverrides?.pnpm).toEqual({});
		expect(overlay.packageOverrides?.openclaw).toEqual(['@openclaw/discord@2026.6.8']);
	});

	it('preserves non-default OpenClaw package pins while removing stale pnpm overrides', () => {
		const plan = createBetaTarballSyncPlan({
			cacheKey: 'abc123ef',
			tarballDirectoryReference: '../agent-vm/tmp/beta-tarballs-abc123ef',
			version: '0.0.82',
		});

		const overlay = renderOpenClawGatewayOverlay({
			existingOverlay: {
				extraAptPackages: ['ffmpeg'],
				packageOverrides: {
					npm: [],
					openclaw: ['openclaw@2026.5.20', '@openclaw/discord@2026.6.8'],
					pnpm: { undici: '8.5.0' },
				},
			},
			managedPackageOverrides,
			plan,
		});

		expect(overlay.packageOverrides?.pnpm).toEqual({});
		expect(overlay.packageOverrides?.openclaw).toEqual([
			'openclaw@2026.5.20',
			'@openclaw/discord@2026.6.8',
		]);
	});

	it('preserves partial OpenClaw package pins even when the pinned version matches the managed default', () => {
		const plan = createBetaTarballSyncPlan({
			cacheKey: 'abc123ef',
			tarballDirectoryReference: '../agent-vm/tmp/beta-tarballs-abc123ef',
			version: '0.0.82',
		});

		const overlay = renderOpenClawGatewayOverlay({
			existingOverlay: {
				extraAptPackages: ['ffmpeg'],
				packageOverrides: {
					npm: [],
					openclaw: ['@openclaw/discord@2026.6.8'],
					pnpm: { undici: '8.5.0' },
				},
			},
			managedPackageOverrides,
			plan,
		});

		expect(overlay.packageOverrides?.pnpm).toEqual({});
		expect(overlay.packageOverrides?.openclaw).toEqual(['@openclaw/discord@2026.6.8']);
	});

	it('installs local Tool VM packages and keeps the mcp-portal executable on PATH', () => {
		const plan = createBetaTarballSyncPlan({
			cacheKey: 'abc123ef',
			tarballDirectoryReference: '../agent-vm/tmp/beta-tarballs-abc123ef',
			version: '0.0.82',
		});

		const overlay = renderToolVmOverlay({
			existingOverlay: {
				copy: [
					{ from: 'local-agent-vm/agent-vm-mcp-portal-0.0.81-oldhash.tgz', to: '/tmp/old.tgz' },
				],
				runAfterBase: ['echo keep', 'rm -f /tmp/agent-vm-mcp-portal-0.0.81-oldhash.tgz'],
			},
			plan,
		});
		const overlayJson = JSON.stringify(overlay, null, 2);

		expect(overlay.copy.map((copyEntry) => copyEntry.from)).toEqual(
			TOOL_VM_TARBALL_PACKAGE_NAMES.map(
				(packageName) =>
					`local-agent-vm/${packageName.replace('@agent-vm/', 'agent-vm-')}-0.0.82-abc123ef.tgz`,
			),
		);
		expect(overlay.runAfterBase).toEqual([
			'echo keep',
			'mkdir -p /opt/agent-vm/local-packages',
			expect.stringContaining(
				'"@agent-vm/mcp-portal": "file:/tmp/agent-vm-mcp-portal-0.0.82-abc123ef.tgz"',
			),
			'cd /opt/agent-vm/local-packages && pnpm install --prod --ignore-scripts',
			expect.stringContaining(
				'ln -sfn /opt/agent-vm/local-packages/node_modules/.bin/mcp-portal /pnpm/mcp-portal',
			),
			expect.any(String),
		]);
		expect(overlay.runAfterBase.at(-1)).toContain(
			'/tmp/agent-vm-config-contracts-0.0.82-abc123ef.tgz',
		);
		expect(overlay.runAfterBase.at(-1)).toContain(
			'/tmp/agent-vm-agent-portal-sdk-0.0.82-abc123ef.tgz',
		);
		expect(overlayJson).toContain('@agent-vm/agent-portal-sdk');
		expect(overlayJson).toContain('file:/tmp/agent-vm-agent-portal-sdk-0.0.82-abc123ef.tgz');
		expect(overlayJson).not.toContain('0.0.81-oldhash');
		expect(overlayJson).not.toContain('@earendil-works/gondolin@0.12.0');
		expect(overlayJson).not.toContain('.patch');
	});
});
