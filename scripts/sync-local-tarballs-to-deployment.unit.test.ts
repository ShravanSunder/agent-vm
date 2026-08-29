import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
	AGENT_VM_PACKAGE_NAMES,
	HERMES_GATEWAY_TARBALL_PACKAGE_NAMES,
	TOOL_VM_TARBALL_PACKAGE_NAMES,
	createBetaTarballSyncPlan,
	listStaleLocalOverlayFileNames,
	parseCliOptions,
	renderBetaPnpmWorkspace,
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
	it('pins the host install and every workspace override to one tarball directory', () => {
		const plan = createBetaTarballSyncPlan({
			cacheKey: 'abc123ef',
			tarballDirectoryReference: '../agent-vm/tmp/beta-tarballs-abc123ef',
			version: '0.0.82',
		});

		expect(plan.packages.map((packageEntry) => packageEntry.name)).toEqual(AGENT_VM_PACKAGE_NAMES);
		expect(plan.hermesGatewayPackages.map((packageEntry) => packageEntry.name)).toEqual(
			HERMES_GATEWAY_TARBALL_PACKAGE_NAMES,
		);
		expect(plan.toolVmPackages.map((packageEntry) => packageEntry.name)).toEqual(
			TOOL_VM_TARBALL_PACKAGE_NAMES,
		);
		expect(plan.hostPackageSpecifier).toBe(
			'file:../agent-vm/tmp/beta-tarballs-abc123ef/agent-vm-agent-vm-0.0.82.tgz',
		);
		expect(
			plan.packages.find((packageEntry) => packageEntry.name === '@agent-vm/gateway-lifecycle')
				?.specifier,
		).toBe('file:../agent-vm/tmp/beta-tarballs-abc123ef/agent-vm-gateway-lifecycle-0.0.82.tgz');
		expect(plan.packages.map((packageEntry) => packageEntry.name)).toContain(
			'@agent-vm/gondolin-vm-adapter',
		);
		expect(plan.packages.map((packageEntry) => packageEntry.name)).toContain(
			'@agent-vm/managed-vm',
		);
		expect(plan.packages.map((packageEntry) => packageEntry.name)).not.toContain(
			'@agent-vm/gateway-interface',
		);
		expect(plan.packages.map((packageEntry) => packageEntry.name)).not.toContain(
			'@agent-vm/gondolin-adapter',
		);
		expect(plan.packages.map((packageEntry) => packageEntry.name)).toContain(
			'@agent-vm/agent-portal-sdk',
		);
		expect(plan.packages.map((packageEntry) => packageEntry.name)).toContain(
			'@agent-vm/controller-execution-contracts',
		);
		expect(plan.packages.map((packageEntry) => packageEntry.name)).toContain(
			'@agent-vm/tool-portal',
		);
		expect(plan.packages.map((packageEntry) => packageEntry.name)).toContain(
			'@agent-vm/gateway-runtime',
		);
		expect(plan.packages.map((packageEntry) => packageEntry.name)).toContain(
			'@agent-vm/hermes-gateway',
		);
		expect(plan.hermesGatewayPackages.map((packageEntry) => packageEntry.name)).toContain(
			'@agent-vm/gateway-runtime',
		);
		expect(plan.toolVmPackages.map((packageEntry) => packageEntry.name)).not.toContain(
			'@agent-vm/gateway-runtime',
		);
	});

	it('renders pnpm-workspace.yaml with overrides in the pnpm v10 location', () => {
		const plan = createBetaTarballSyncPlan({
			cacheKey: 'abc123ef',
			tarballDirectoryReference: '../agent-vm/tmp/beta-tarballs-abc123ef',
			version: '0.0.82',
		});

		const workspaceYaml = renderBetaPnpmWorkspace({
			onlyBuiltDependencies: ['@google/genai', 'ssh2'],
			plan,
		});

		expect(workspaceYaml).toContain('packages: []');
		expect(workspaceYaml).not.toContain('patchedDependencies:');
		expect(workspaceYaml).not.toContain('@earendil-works/gondolin');
		expect(workspaceYaml).toContain('  - "@google/genai"');
		expect(workspaceYaml).toContain(
			"  '@agent-vm/hermes-gateway': file:../agent-vm/tmp/beta-tarballs-abc123ef/agent-vm-hermes-gateway-0.0.82.tgz",
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
				name: 'beta-deployment',
				dependencies: { '@agent-vm/agent-vm': '0.0.81' },
				pnpm: { onlyBuiltDependencies: ['ssh2'] },
			},
			plan,
		});

		expect(manifest).toEqual({
			name: 'beta-deployment',
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
			'../beta-deployment',
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
		expect(options.deploymentDirectory).toContain('beta-deployment');
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
					'agent-vm-mcp-portal-0.0.82-oldhash.tgz',
					'agent-vm-local-packages-tool-vm-oldhash.json',
					'README.md',
				],
				packageEntries: plan.toolVmPackages,
			}),
		).toEqual([
			'agent-vm-mcp-portal-0.0.82-oldhash.tgz',
			'agent-vm-local-packages-tool-vm-oldhash.json',
		]);
	});
});

describe('beta tarball deployment artifact refresh', () => {
	it('updates host manifests and VM overlays before install is required', async () => {
		const workspaceDirectory = await createTemporaryDirectory('agent-vm-beta-sync-');
		const deploymentDirectory = path.join(workspaceDirectory, 'beta-deployment');
		const tarballDirectory = path.join(
			workspaceDirectory,
			'agent-vm',
			'tmp',
			'beta-tarballs-newhash01',
		);
		const toolVmOverlayDirectory = path.join(
			deploymentDirectory,
			'vm-images',
			'tool-vms',
			'default',
		);
		const hermesImageDirectory = path.join(deploymentDirectory, 'vm-images', 'gateways', 'hermes');
		const agentPortalSdkWheelPath = path.join(
			workspaceDirectory,
			'dist',
			'agent_vm_agent_portal_sdk-0.0.110-py3-none-any.whl',
		);
		const hermesAdapterWheelPath = path.join(
			workspaceDirectory,
			'dist',
			'agent_vm_hermes_adapter-0.0.110-py3-none-any.whl',
		);
		const plan = createBetaTarballSyncPlan({
			cacheKey: 'newhash01',
			tarballDirectoryReference: '../agent-vm/tmp/beta-tarballs-newhash01',
			version: '0.0.110',
		});

		await mkdir(tarballDirectory, { recursive: true });
		await mkdir(path.dirname(agentPortalSdkWheelPath), { recursive: true });
		await Promise.all([
			...plan.packages.map((packageEntry) =>
				writeFile(path.join(tarballDirectory, packageEntry.fileName), 'fake package'),
			),
			writeFile(agentPortalSdkWheelPath, 'fake sdk wheel'),
			writeFile(hermesAdapterWheelPath, 'fake adapter wheel'),
		]);
		await writeJsonFixture(path.join(deploymentDirectory, 'package.json'), {
			dependencies: {
				'@agent-vm/agent-vm':
					'file:../agent-vm/tmp/beta-tarballs-oldhash/agent-vm-agent-vm-0.0.110.tgz',
			},
			name: 'beta-deployment',
			pnpm: {
				onlyBuiltDependencies: ['ssh2'],
			},
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
		await mkdir(path.join(toolVmOverlayDirectory, 'local-agent-vm'), { recursive: true });
		await mkdir(path.join(hermesImageDirectory, 'local-agent-vm'), { recursive: true });
		await writeFile(
			path.join(
				toolVmOverlayDirectory,
				'local-agent-vm',
				'agent-vm-mcp-portal-0.0.110-oldhash00.tgz',
			),
			'stale tool package',
		);
		await Promise.all([
			writeFile(
				path.join(
					hermesImageDirectory,
					'local-agent-vm',
					'agent-vm-gateway-runtime-0.0.109-oldhash00.tgz',
				),
				'stale Hermes package',
			),
			writeFile(
				path.join(
					hermesImageDirectory,
					'local-agent-vm',
					'agent_vm_hermes_adapter-0.0.109-py3-none-any.whl',
				),
				'stale Hermes wheel',
			),
			writeFile(
				path.join(hermesImageDirectory, 'local-agent-vm', 'agent-vm-custom-input.tgz'),
				'deployment-owned Hermes input',
			),
		]);

		await refreshBetaDeploymentTarballArtifacts({
			deploymentDirectory,
			hermesImage: {
				buildTarget: {
					architecture: 'x86_64',
					kind: 'gondolin-custom-dockerfile',
					ociImage: 'agent-vm-hermes:newhash01',
					rootfsSizeMb: 4096,
				},
				pythonWheels: {
					agentPortalSdk: {
						fileName: path.basename(agentPortalSdkWheelPath),
						sourcePath: agentPortalSdkWheelPath,
					},
					hermesAdapter: {
						fileName: path.basename(hermesAdapterWheelPath),
						sourcePath: hermesAdapterWheelPath,
					},
				},
			},
			plan,
			tarballDirectory,
		});

		const packageJson = await readFile(path.join(deploymentDirectory, 'package.json'), 'utf8');
		const workspaceYaml = await readFile(
			path.join(deploymentDirectory, 'pnpm-workspace.yaml'),
			'utf8',
		);
		const toolVmOverlayJson = await readFile(
			path.join(toolVmOverlayDirectory, 'overlay.jsonc'),
			'utf8',
		);
		const hermesDockerfile = await readFile(path.join(hermesImageDirectory, 'Dockerfile'), 'utf8');
		const hermesBuildConfig = await readFile(
			path.join(hermesImageDirectory, 'build-config.jsonc'),
			'utf8',
		);
		const hermesLocalPackageManifestText = await readFile(
			path.join(hermesImageDirectory, 'local-agent-vm', 'package.json'),
			'utf8',
		);
		const hermesLocalPackageManifest = JSON.parse(hermesLocalPackageManifestText) as {
			readonly dependencies: Readonly<Record<string, string>>;
			readonly pnpm: { readonly overrides: Readonly<Record<string, string>> };
		};
		const hermesLocalFileNames = await readdir(path.join(hermesImageDirectory, 'local-agent-vm'));
		const toolVmLocalFileNames = await readdir(path.join(toolVmOverlayDirectory, 'local-agent-vm'));
		expect(packageJson).toContain(
			'../agent-vm/tmp/beta-tarballs-newhash01/agent-vm-agent-vm-0.0.110.tgz',
		);
		expect(packageJson).not.toContain('oldhash');
		expect(workspaceYaml).toContain(
			"'@agent-vm/hermes-gateway': file:../agent-vm/tmp/beta-tarballs-newhash01/agent-vm-hermes-gateway-0.0.110.tgz",
		);
		expect(workspaceYaml).not.toContain('patchedDependencies:');
		expect(toolVmOverlayJson).toContain('local-agent-vm/agent-vm-mcp-portal-0.0.110-newhash01.tgz');
		expect(toolVmOverlayJson).not.toContain('oldhash00');
		expect(toolVmLocalFileNames).toContain('agent-vm-mcp-portal-0.0.110-newhash01.tgz');
		expect(toolVmLocalFileNames).not.toContain('agent-vm-mcp-portal-0.0.110-oldhash00.tgz');
		expect(hermesDockerfile).toContain('/usr/local/bin/agent-vm-hermes-gateway');
		expect(hermesDockerfile).toContain('/usr/local/bin/agent-vm-gateway-runtime');
		expect(hermesDockerfile).toContain(
			'local-agent-vm/agent-vm-gateway-runtime-0.0.110-newhash01.tgz',
		);
		expect(hermesBuildConfig).toContain('agent-vm-hermes:newhash01');
		expect(hermesLocalPackageManifest.dependencies).toEqual({
			'@agent-vm/gateway-runtime': 'file:./agent-vm-gateway-runtime-0.0.110-newhash01.tgz',
		});
		expect(Object.keys(hermesLocalPackageManifest.pnpm.overrides).toSorted()).toEqual(
			HERMES_GATEWAY_TARBALL_PACKAGE_NAMES.toSorted(),
		);
		expect(hermesLocalFileNames).toContain('agent_vm_agent_portal_sdk-0.0.110-py3-none-any.whl');
		expect(hermesLocalFileNames).toContain('agent_vm_hermes_adapter-0.0.110-py3-none-any.whl');
		expect(hermesLocalFileNames).toContain('agent-vm-gateway-runtime-0.0.110-newhash01.tgz');
		expect(hermesLocalFileNames).not.toContain('agent-vm-gateway-runtime-0.0.109-oldhash00.tgz');
		expect(hermesLocalFileNames).not.toContain('agent_vm_hermes_adapter-0.0.109-py3-none-any.whl');
		expect(hermesLocalFileNames).toContain('agent-vm-custom-input.tgz');
	});
});

describe('Tool VM overlay rendering', () => {
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
