import { describe, expect, it } from 'vitest';

import {
	auditManagedVmBoundaries,
	type ManagedVmBoundaryAuditSource,
} from './audit-managed-vm-boundaries.js';

const validSources: readonly ManagedVmBoundaryAuditSource[] = [
	{
		content: JSON.stringify({
			name: '@agent-vm/managed-vm',
		}),
		filePath: 'packages/managed-vm/package.json',
	},
	{
		content: JSON.stringify({
			dependencies: { '@agent-vm/managed-vm': 'workspace:*' },
			name: '@agent-vm/gateway-lifecycle',
		}),
		filePath: 'packages/gateway-lifecycle/package.json',
	},
	{
		content: JSON.stringify({
			dependencies: {
				'@agent-vm/managed-vm': 'workspace:*',
				'@earendil-works/gondolin': '0.12.0',
			},
			name: '@agent-vm/gondolin-vm-adapter',
		}),
		filePath: 'packages/gondolin-vm-adapter/package.json',
	},
	{
		content: JSON.stringify({
			dependencies: { '@agent-vm/gateway-lifecycle': 'workspace:*' },
			name: '@agent-vm/openclaw-gateway',
		}),
		filePath: 'packages/openclaw-gateway/package.json',
	},
	{
		content: JSON.stringify({
			dependencies: { '@agent-vm/gateway-lifecycle': 'workspace:*' },
			name: '@agent-vm/worker-gateway',
		}),
		filePath: 'packages/worker-gateway/package.json',
	},
	{
		content: JSON.stringify({
			dependencies: {
				'@agent-vm/gondolin-vm-adapter': 'workspace:*',
				'@agent-vm/managed-vm': 'workspace:*',
			},
			name: '@agent-vm/agent-vm',
		}),
		filePath: 'packages/agent-vm/package.json',
	},
	{
		content: "import { createGondolinManagedVmProvider } from '@agent-vm/gondolin-vm-adapter';",
		filePath: 'packages/agent-vm/src/composition/gondolin-managed-vm-provider.ts',
	},
	{
		content: "export { resolveGondolinPackageSpec } from '@agent-vm/gondolin-vm-adapter';",
		filePath: 'packages/agent-vm/src/build/gondolin-managed-vm-build-tooling.ts',
	},
	{
		content: "import { validateBuildConfig } from '@earendil-works/gondolin';",
		filePath: 'packages/gondolin-vm-adapter/src/managed-vm-provider.ts',
	},
];

describe('auditManagedVmBoundaries', () => {
	it('accepts the closed package graph and exact production importer sets', () => {
		expect(auditManagedVmBoundaries(validSources)).toEqual([]);
	});

	it.each([
		["import '@agent-vm/gondolin-vm-adapter';", 'static import'],
		["export * from '@agent-vm/gondolin-vm-adapter';", 're-export'],
		["void import('@agent-vm/gondolin-vm-adapter');", 'dynamic import'],
		["require('@agent-vm/gondolin-vm-adapter');", 'require call'],
	] as const)('rejects a third production adapter %s', (content) => {
		const findings = auditManagedVmBoundaries([
			...validSources,
			{
				content,
				filePath: 'packages/agent-vm/src/controller/forbidden-adapter-import.ts',
			},
		]);

		expect(findings.map((finding) => finding.reason)).toContain(
			'production adapter import is forbidden outside the exact two-module allowlist',
		);
	});

	it('rejects a path-map-enabled adapter subpath bypass', () => {
		const findings = auditManagedVmBoundaries([
			...validSources,
			{
				content: JSON.stringify({
					compilerOptions: {
						paths: {
							'@internal/selected-vm': ['./packages/gondolin-vm-adapter/src/index.ts'],
						},
					},
				}),
				filePath: 'tsconfig.base.json',
			},
			{
				content: "import '@internal/selected-vm';",
				filePath: 'packages/agent-vm/src/controller/path-map-bypass.ts',
			},
		]);

		expect(findings.map((finding) => finding.reason)).toContain(
			'production adapter import is forbidden outside the exact two-module allowlist',
		);
	});

	it('rejects a package-local JSONC path-map bypass', () => {
		const findings = auditManagedVmBoundaries([
			...validSources,
			{
				content: [
					'{',
					'  // package-local alias must not hide the adapter',
					'  "compilerOptions": {',
					'    "paths": { "@selected-vm": ["../gondolin-vm-adapter/src/index.ts"] }',
					'  }',
					'}',
				].join('\n'),
				filePath: 'packages/agent-vm/tsconfig.build.jsonc',
			},
			{
				content: "import '@selected-vm';",
				filePath: 'packages/agent-vm/src/controller/package-alias-bypass.cts',
			},
		]);

		expect(findings.map((finding) => finding.reason)).toContain(
			'production adapter import is forbidden outside the exact two-module allowlist',
		);
	});

	it('rejects a relative import resolving into adapter source', () => {
		const findings = auditManagedVmBoundaries([
			...validSources,
			{
				content: "export * from '../../../gondolin-vm-adapter/src/index.js';",
				filePath: 'packages/agent-vm/src/controller/relative-bypass.ts',
			},
		]);

		expect(findings.map((finding) => finding.reason)).toContain(
			'production adapter import is forbidden outside the exact two-module allowlist',
		);
	});

	it('audits alternate production TypeScript extensions', () => {
		const findings = auditManagedVmBoundaries([
			...validSources,
			{
				content: "void import('@agent-vm/gondolin-vm-adapter');",
				filePath: 'packages/agent-vm/src/controller/alternate-extension.mts',
			},
		]);

		expect(findings.map((finding) => finding.reason)).toContain(
			'production adapter import is forbidden outside the exact two-module allowlist',
		);
	});

	it.each([
		['peerDependencies', 'workspace:*'],
		['optionalDependencies', 'workspace:*'],
		['dependencies', '^1.0.0'],
	] as const)('rejects adapter provenance through %s using %s', (dependencyField, version) => {
		const sources = validSources.map((source) =>
			source.filePath === 'packages/agent-vm/package.json'
				? {
						...source,
						content: JSON.stringify({
							[dependencyField]: { '@agent-vm/gondolin-vm-adapter': version },
							name: '@agent-vm/agent-vm',
						}),
					}
				: source,
		);

		expect(auditManagedVmBoundaries(sources).map((finding) => finding.reason)).toContain(
			"@agent-vm/agent-vm must declare '@agent-vm/gondolin-vm-adapter' as an exact workspace dependency",
		);
	});

	it('rejects forbidden gateway and adapter manifest edges', () => {
		const sources = validSources.map((source) =>
			source.filePath === 'packages/openclaw-gateway/package.json'
				? {
						...source,
						content: JSON.stringify({
							dependencies: {
								'@agent-vm/gateway-lifecycle': 'workspace:*',
								'@agent-vm/gondolin-vm-adapter': 'workspace:*',
							},
							name: '@agent-vm/openclaw-gateway',
						}),
					}
				: source,
		);

		expect(auditManagedVmBoundaries(sources).map((finding) => finding.reason)).toContain(
			"forbidden package edge '@agent-vm/openclaw-gateway' -> '@agent-vm/gondolin-vm-adapter'",
		);
	});

	it('rejects old package names and non-adapter Gondolin SDK imports', () => {
		const findings = auditManagedVmBoundaries([
			...validSources,
			{
				content: "import '@agent-vm/gondolin-adapter';",
				filePath: 'packages/agent-vm/src/controller/old-name.ts',
			},
			{
				content: "import '@earendil-works/gondolin';",
				filePath: 'packages/managed-vm/src/forbidden-sdk.ts',
			},
		]);

		expect(findings.map((finding) => finding.reason)).toEqual(
			expect.arrayContaining([
				"active old package name '@agent-vm/gondolin-adapter' is forbidden",
				'only @agent-vm/gondolin-vm-adapter may import the Gondolin SDK',
			]),
		);
	});

	it('rejects patched, overridden, locally replaced, or wrong-version Gondolin provenance', () => {
		const findings = auditManagedVmBoundaries([
			...validSources.map((source) =>
				source.filePath === 'packages/gondolin-vm-adapter/package.json'
					? {
							...source,
							content: JSON.stringify({
								dependencies: {
									'@agent-vm/managed-vm': 'workspace:*',
									'@earendil-works/gondolin': '^0.13.0',
								},
								name: '@agent-vm/gondolin-vm-adapter',
							}),
						}
					: source,
			),
			{
				content: JSON.stringify({
					pnpm: {
						overrides: { '@earendil-works/gondolin': 'file:../gondolin' },
						patchedDependencies: {
							'@earendil-works/gondolin@0.12.0': 'patches/gondolin.patch',
						},
					},
				}),
				filePath: 'package.json',
			},
		]);

		expect(findings.map((finding) => finding.reason)).toEqual(
			expect.arrayContaining([
				"Gondolin SDK dependency must be exact stock version '0.12.0'",
				'Gondolin SDK patch or override configuration is forbidden',
				'Gondolin SDK local replacement is forbidden',
			]),
		);
	});

	it('rejects managed Gateway identity projection across contracts, adapters, tests, and images', () => {
		const findings = auditManagedVmBoundaries([
			...validSources,
			{
				content:
					"export type ManagedVmGuestOwnership = { readonly kind: 'projected-guest-identity' };",
				filePath: 'packages/managed-vm/src/managed-vm-contracts.ts',
			},
			{
				content: "const request = { guestOwnership: { kind: 'preserve-host-identity' } };",
				filePath: 'packages/agent-vm/src/controller/worker-task-runner.integration.test.ts',
			},
			{
				content: 'function frameworkServiceUser() {}\nsetpriv --reuid=root',
				filePath: 'packages/gondolin-vm-adapter/src/rootfs-init-extra.ts',
			},
			{
				content:
					'groupadd --gid 1001 openclaw\nuseradd --uid 1001 --gid 1001 openclaw\nchown -R openclaw:openclaw /home/openclaw',
				filePath: 'docker/base-images/openclaw-gateway/Dockerfile',
			},
		]);

		expect(findings.map((finding) => finding.reason)).toEqual(
			expect.arrayContaining([
				'ManagedVmGuestOwnership declaration is forbidden',
				'guestOwnership mount policy is forbidden',
				'managed framework service-user selection is forbidden',
				'managed Gateway setpriv identity transition is forbidden',
				'managed OpenClaw service-account creation is forbidden',
				'managed OpenClaw service-account ownership is forbidden',
				'projected guest identity variant is forbidden',
			]),
		);
	});
});
