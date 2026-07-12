import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
	assertExpectedHead,
	assertFreshBuildArtifacts,
	buildPackedTarMemberReceipts,
	deriveAffectedPublishableClosure,
	inspectPackedPackage,
	parseInspectManagedVmPackageCutArgs,
	prepareCleanBuildDirectories,
	readWorkspacePackages,
	validateTarMemberNames,
	type PackedPackageInput,
	type WorkspacePackage,
	type WorkspacePackageManifest,
} from './inspect-managed-vm-package-cut.ts';

const requiredPackageNames = [
	'@agent-vm/managed-vm',
	'@agent-vm/gateway-lifecycle',
	'@agent-vm/gondolin-vm-adapter',
	'@agent-vm/openclaw-gateway',
	'@agent-vm/worker-gateway',
	'@agent-vm/openclaw-agent-vm-plugin',
	'@agent-vm/agent-vm',
] as const;

function manifest(
	name: string,
	dependencies: Readonly<Record<string, string>> = {},
): WorkspacePackageManifest {
	return { dependencies, name, version: '1.2.3' };
}

function workspacePackage(
	name: string,
	dependencies: Readonly<Record<string, string>> = {},
): WorkspacePackage {
	return {
		directory: `/workspace/packages/${name.split('/').at(-1)}`,
		manifest: manifest(name, dependencies),
	};
}

function completeWorkspace(): readonly WorkspacePackage[] {
	return [
		workspacePackage('@agent-vm/managed-vm'),
		workspacePackage('@agent-vm/gateway-lifecycle', { '@agent-vm/managed-vm': 'workspace:*' }),
		workspacePackage('@agent-vm/gondolin-vm-adapter', { '@agent-vm/managed-vm': 'workspace:*' }),
		workspacePackage('@agent-vm/openclaw-gateway', {
			'@agent-vm/gateway-lifecycle': 'workspace:*',
		}),
		workspacePackage('@agent-vm/worker-gateway', {
			'@agent-vm/gateway-lifecycle': 'workspace:*',
		}),
		workspacePackage('@agent-vm/openclaw-agent-vm-plugin', {
			'@agent-vm/gateway-lifecycle': 'workspace:*',
		}),
		workspacePackage('@agent-vm/agent-vm', {
			'@agent-vm/gondolin-vm-adapter': 'workspace:*',
			'@agent-vm/openclaw-agent-vm-plugin': 'workspace:*',
			'@agent-vm/openclaw-gateway': 'workspace:*',
			'@agent-vm/worker-gateway': 'workspace:*',
		}),
	];
}

function bytes(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

function packedPackage(
	packageManifest: WorkspacePackageManifest,
	options: {
		readonly declaration?: string;
		readonly managedImages?: string;
		readonly memberName?: string;
		readonly packedManifest?: WorkspacePackageManifest;
	} = {},
): PackedPackageInput {
	const packedManifest = options.packedManifest ?? packageManifest;
	const members = new Map<string, Uint8Array>([
		['package/package.json', bytes(JSON.stringify(packedManifest))],
		['package/dist/index.js', bytes('export const packageContract = true;')],
		[
			'package/dist/index.d.ts',
			bytes(options.declaration ?? 'export interface NeutralContract {}'),
		],
	]);
	if (options.memberName !== undefined) members.set(options.memberName, bytes('unsafe'));
	if (options.managedImages !== undefined) {
		members.set('package/managed-images.json', bytes(options.managedImages));
	}
	return { manifest: packageManifest, members, tarballName: 'package-1.2.3.tgz' };
}

describe('managed VM exact-HEAD package inspector', () => {
	it('ignores non-package directories while discovering workspace packages', async () => {
		// Arrange
		const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'package-inspector-workspace-'));
		const packageDirectory = path.join(temporaryRoot, 'packages', 'managed-vm');
		await mkdir(packageDirectory, { recursive: true });
		await mkdir(path.join(temporaryRoot, 'packages', 'gateway-contracts'), { recursive: true });
		await writeFile(
			path.join(packageDirectory, 'package.json'),
			JSON.stringify(manifest('@agent-vm/managed-vm')),
			'utf8',
		);

		try {
			// Act
			const workspacePackages = await readWorkspacePackages(temporaryRoot);

			// Assert
			expect(workspacePackages).toMatchObject([
				{
					directory: packageDirectory,
					manifest: {
						name: '@agent-vm/managed-vm',
						version: '1.2.3',
					},
				},
			]);
		} finally {
			await rm(temporaryRoot, { force: true, recursive: true });
		}
	});

	it('parses the required exact HEAD argument and rejects stale HEAD', () => {
		// Arrange
		const options = parseInspectManagedVmPackageCutArgs(['--expected-head', 'expected-head']);

		// Act / Assert
		expect(options).toEqual({ expectedHead: 'expected-head' });
		expect(() => assertExpectedHead(options.expectedHead, 'stale-head')).toThrow(
			'Expected package inspection HEAD expected-head, but current HEAD is stale-head.',
		);
	});

	it('derives the publishable dependency closure rather than using a fixed output list', () => {
		// Arrange
		const workspace = [
			...completeWorkspace(),
			workspacePackage('@agent-vm/transitive-runtime'),
			workspacePackage('@agent-vm/downstream-runtime', {
				'@agent-vm/agent-vm': 'workspace:*',
				'@agent-vm/transitive-runtime': 'workspace:*',
			}),
		];

		// Act
		const affectedNames = deriveAffectedPublishableClosure(workspace).map(
			(candidate) => candidate.manifest.name,
		);

		// Assert
		expect(affectedNames).toEqual(
			expect.arrayContaining([
				...requiredPackageNames,
				'@agent-vm/transitive-runtime',
				'@agent-vm/downstream-runtime',
			]),
		);
	});

	it('rejects a workspace missing a required closure member', () => {
		// Arrange
		const incompleteWorkspace = completeWorkspace().filter(
			(candidate) => candidate.manifest.name !== '@agent-vm/worker-gateway',
		);

		// Act / Assert
		expect(() => deriveAffectedPublishableClosure(incompleteWorkspace)).toThrow(
			'Affected publishable package closure is missing @agent-vm/worker-gateway.',
		);
	});

	it('rejects unsafe tar members before inspecting their contents', () => {
		// Arrange
		const tarMembers = ['package/package.json', 'package/../escaped-file'];

		// Act / Assert
		expect(() => validateTarMemberNames(tarMembers, '@agent-vm/managed-vm')).toThrow(
			"contains unsafe tar member 'package/../escaped-file'",
		);
	});

	it('rejects removed package names in any packed member', () => {
		// Arrange
		const packageManifest = manifest('@agent-vm/managed-vm');
		const input = packedPackage(packageManifest, {
			declaration: "export type Legacy = import('@agent-vm/gateway-interface').GatewayLifecycle;",
		});

		// Act / Assert
		expect(() => inspectPackedPackage(input, new Map([[packageManifest.name, '1.2.3']]))).toThrow(
			'contains removed name @agent-vm/gateway-interface',
		);
	});

	it('rejects exact sibling dependency drift in the packed manifest', () => {
		// Arrange
		const packageManifest = manifest('@agent-vm/gateway-lifecycle', {
			'@agent-vm/managed-vm': 'workspace:*',
		});
		const packedManifest = manifest('@agent-vm/gateway-lifecycle', {
			'@agent-vm/managed-vm': '^1.2.3',
		});

		// Act / Assert
		expect(() =>
			inspectPackedPackage(
				packedPackage(packageManifest, { packedManifest }),
				new Map([
					['@agent-vm/gateway-lifecycle', '1.2.3'],
					['@agent-vm/managed-vm', '1.2.3'],
				]),
			),
		).toThrow(
			'dependencies.@agent-vm/managed-vm must equal sibling version 1.2.3, received ^1.2.3',
		);
	});

	it('rejects a packed manifest missing a source-declared sibling edge', () => {
		// Arrange
		const packageManifest = manifest('@agent-vm/agent-vm', {
			'@agent-vm/gondolin-vm-adapter': 'workspace:*',
		});
		const packedManifest = manifest('@agent-vm/agent-vm');
		const input = packedPackage(packageManifest, {
			managedImages: JSON.stringify({ baseImages: {} }),
			packedManifest,
		});

		// Act / Assert
		expect(() =>
			inspectPackedPackage(
				input,
				new Map([
					['@agent-vm/agent-vm', '1.2.3'],
					['@agent-vm/gondolin-vm-adapter', '1.2.3'],
				]),
			),
		).toThrow(
			'@agent-vm/agent-vm packed manifest is missing sibling edge dependencies.@agent-vm/gondolin-vm-adapter.',
		);
	});

	it('rejects moving the stock adapter from regular dependencies to peers', () => {
		// Arrange
		const packageManifest = manifest('@agent-vm/agent-vm', {
			'@agent-vm/gondolin-vm-adapter': 'workspace:*',
		});
		const packedManifest: WorkspacePackageManifest = {
			...manifest('@agent-vm/agent-vm'),
			peerDependencies: { '@agent-vm/gondolin-vm-adapter': '1.2.3' },
		};
		const input = packedPackage(packageManifest, {
			managedImages: JSON.stringify({ baseImages: {} }),
			packedManifest,
		});

		// Act / Assert
		expect(() =>
			inspectPackedPackage(
				input,
				new Map([
					['@agent-vm/agent-vm', '1.2.3'],
					['@agent-vm/gondolin-vm-adapter', '1.2.3'],
				]),
			),
		).toThrow(
			'@agent-vm/agent-vm sibling @agent-vm/gondolin-vm-adapter moved from dependencies to peerDependencies.',
		);
	});

	it('rejects packed package identity version drift', () => {
		// Arrange
		const packageManifest = manifest('@agent-vm/managed-vm');
		const packedManifest = { ...packageManifest, version: '1.2.4' };

		// Act / Assert
		expect(() =>
			inspectPackedPackage(
				packedPackage(packageManifest, { packedManifest }),
				new Map([[packageManifest.name, packageManifest.version]]),
			),
		).toThrow('packed identity drifted to @agent-vm/managed-vm@1.2.4');
	});

	it('rejects backend-native leakage from packed public declarations', () => {
		// Arrange
		const packageManifest = manifest('@agent-vm/managed-vm');
		const input = packedPackage(packageManifest, {
			declaration: 'export interface LeakedContract { getVmInstance(): object }',
		});

		// Act / Assert
		expect(() => inspectPackedPackage(input, new Map([[packageManifest.name, '1.2.3']]))).toThrow(
			'leaks forbidden fragment getVmInstance',
		);
	});

	it('rejects agent-vm npm version pins in managed image metadata', () => {
		// Arrange
		const packageManifest = manifest('@agent-vm/agent-vm');
		const input = packedPackage(packageManifest, {
			managedImages: JSON.stringify({ packageOverrides: { npm: ['@agent-vm/managed-vm@1.2.3'] } }),
		});

		// Act / Assert
		expect(() => inspectPackedPackage(input, new Map([[packageManifest.name, '1.2.3']]))).toThrow(
			'managed-images.json must not pin @agent-vm npm package versions',
		);
	});

	it('removes stale owned dist output and rejects any stale build artifact record', async () => {
		// Arrange
		const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'package-inspector-unit-'));
		const packageDirectory = path.join(temporaryRoot, 'managed-vm');
		const staleArtifactPath = path.join(packageDirectory, 'dist', 'stale.js');
		await mkdir(path.dirname(staleArtifactPath), { recursive: true });
		await writeFile(staleArtifactPath, 'stale output', 'utf8');

		try {
			// Act
			await prepareCleanBuildDirectories([
				{ directory: packageDirectory, manifest: manifest('@agent-vm/managed-vm') },
			]);

			// Assert
			await expect(access(staleArtifactPath)).rejects.toThrow();
			expect(() =>
				assertFreshBuildArtifacts('@agent-vm/managed-vm', 200, [
					{ modifiedAtMilliseconds: 199, path: staleArtifactPath },
				]),
			).toThrow('dist artifact');
		} finally {
			await rm(temporaryRoot, { force: true, recursive: true });
		}
	});

	it('emits a sorted exact hash and size receipt for every tar member', () => {
		// Arrange
		const members = new Map<string, Uint8Array>([
			['package/dist/index.js', bytes('export const packageContract = true;')],
			['package/dist/index.d.ts', bytes('export interface NeutralContract {}')],
		]);

		// Act
		const receipt = buildPackedTarMemberReceipts(members);

		// Assert
		expect(receipt).toEqual([
			{
				name: 'package/dist/index.d.ts',
				sha256: '86c6d19f35db0cd72b499444147955c26f7e9a77396ec40b00ee6045c627ed36',
				size: 35,
			},
			{
				name: 'package/dist/index.js',
				sha256: 'ae1bdf6a5c0f6ca1d0c0ee6b8fc9eba396f13d3a25d5d4ad0d2af0c82b591c85',
				size: 36,
			},
		]);
	});

	it('accepts a neutral exact-version package and returns receipt coverage', () => {
		// Arrange
		const packageManifest = manifest('@agent-vm/agent-vm', {
			'@agent-vm/managed-vm': '1.2.3',
		});
		const input = packedPackage(packageManifest, {
			managedImages: JSON.stringify({ baseImages: { worker: { tag: '2026.07.12.1' } } }),
		});

		// Act
		const receipt = inspectPackedPackage(
			input,
			new Map([
				['@agent-vm/agent-vm', '1.2.3'],
				['@agent-vm/managed-vm', '1.2.3'],
			]),
		);

		// Assert
		expect(receipt).toMatchObject({
			declarationMembers: ['package/dist/index.d.ts'],
			members: [
				{ name: 'package/dist/index.d.ts', size: 35 },
				{ name: 'package/dist/index.js', size: 36 },
				{ name: 'package/managed-images.json' },
				{ name: 'package/package.json' },
			],
			memberCount: 4,
			name: '@agent-vm/agent-vm',
			siblingDependencies: [
				{ name: '@agent-vm/managed-vm', section: 'dependencies', version: '1.2.3' },
			],
			version: '1.2.3',
		});
	});
});
