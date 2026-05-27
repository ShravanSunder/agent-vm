import { describe, expect, it } from 'vitest';

import {
	AGENT_VM_PACKAGE_NAMES,
	OPENCLAW_GATEWAY_TARBALL_PACKAGE_NAMES,
	createBetaTarballSyncPlan,
	parseCliOptions,
	renderBetaPnpmWorkspace,
	renderOpenClawGatewayOverlay,
	resolvePnpmPackArgs,
	updateBetaPackageManifest,
} from './sync-local-tarballs-to-deployment.ts';

describe('beta tarball sync planning', () => {
	it('pins the host install and every workspace override to one tarball directory', () => {
		const plan = createBetaTarballSyncPlan({
			cacheKey: 'abc123ef',
			tarballDirectoryReference: '../agent-vm/tmp/beta-tarballs-abc123ef',
			version: '0.0.82',
		});

		expect(plan.packages.map((packageEntry) => packageEntry.name)).toEqual(AGENT_VM_PACKAGE_NAMES);
		expect(plan.hostPackageSpecifier).toBe(
			'file:../agent-vm/tmp/beta-tarballs-abc123ef/agent-vm-agent-vm-0.0.82.tgz',
		);
		expect(
			plan.packages.find((packageEntry) => packageEntry.name === '@agent-vm/gateway-interface')
				?.specifier,
		).toBe('file:../agent-vm/tmp/beta-tarballs-abc123ef/agent-vm-gateway-interface-0.0.82.tgz');
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
		expect(workspaceYaml).toContain('  - "@google/genai"');
		expect(workspaceYaml).toContain('  - "openclaw"');
		expect(workspaceYaml).toContain(
			"  '@agent-vm/openclaw-agent-vm-plugin': file:../agent-vm/tmp/beta-tarballs-abc123ef/agent-vm-openclaw-agent-vm-plugin-0.0.82.tgz",
		);
		expect(workspaceYaml).not.toContain('pnpm:');
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
});

describe('openclaw gateway overlay rendering', () => {
	it('installs local gateway packages through a pnpm project with transitive overrides', () => {
		const plan = createBetaTarballSyncPlan({
			cacheKey: 'abc123ef',
			tarballDirectoryReference: '../agent-vm/tmp/beta-tarballs-abc123ef',
			version: '0.0.82',
		});

		const overlay = renderOpenClawGatewayOverlay({
			existingOverlay: {
				extraAptPackages: ['ffmpeg'],
				extraOpenClawPackages: ['openclaw@2026.5.20'],
			},
			plan,
		});
		const overlayJson = JSON.stringify(overlay, null, 2);

		expect(overlay.copy.map((copyEntry) => copyEntry.from)).toEqual(
			OPENCLAW_GATEWAY_TARBALL_PACKAGE_NAMES.map(
				(packageName) =>
					`local-agent-vm/${packageName.replace('@agent-vm/', 'agent-vm-')}-0.0.82-abc123ef.tgz`,
			),
		);
		expect(overlay.runAfterBase).toEqual([
			'mkdir -p /opt/agent-vm/local-packages',
			expect.stringContaining(
				'"@agent-vm/gateway-interface": "file:/tmp/agent-vm-gateway-interface-0.0.82-abc123ef.tgz"',
			),
			'cd /opt/agent-vm/local-packages && pnpm install --prod --ignore-scripts',
			expect.stringContaining(
				'ln -sfn /opt/agent-vm/local-packages/node_modules/@agent-vm/openclaw-agent-vm-plugin',
			),
			expect.stringContaining('rm -f /tmp/agent-vm-config-contracts-0.0.82-abc123ef.tgz'),
		]);
		expect(overlayJson).not.toContain('npm install --prefix');
		expect(overlayJson).not.toContain('pnpm add -g');
		expect(overlayJson).not.toContain('rm -rf');
		expect(overlayJson).not.toContain('cp -R');
		expect(overlay.extraOpenClawPackages).toEqual(['openclaw@2026.5.20']);
	});
});
