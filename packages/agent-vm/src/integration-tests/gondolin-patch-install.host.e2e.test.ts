import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, '../../../..');
const patchRelativePath = 'patches/@earendil-works__gondolin@0.12.0.patch';
const expectedPatchSha256 = 'c061b9111ee82d9beda83a36202da7637b8d04f3cffcb2c1ecb6dfb54f499400';
const expectedInstalledFileSha256 = {
	'dist/src/index.d.ts': '32e86acfd85cedd2b1e956abc719f4e5fcfadc8fc2943e0b112b3cdcc0fc1be0',
	'dist/src/index.js': 'd4b6e9c5a2bff324e84a3ef249922496be3a484e8e20caa3e74614f64a78a754',
	'dist/src/vm/exact-lifecycle-contracts.d.ts':
		'c804f6f51617bd27461e35eb607d45c50ca52d0926784753f589baca37aafc95',
	'dist/src/vm/exact-lifecycle-contracts.js':
		'c549c7d9a95b56e85d83152d33d53d75e8327c8eafdfeec7c71d03fcb66d6e76',
	'dist/src/vm/exact-lifecycle.d.ts':
		'5a3859226a1963b686e92679bdd08a599c2ced011359386ef594b8f76acac676',
	'dist/src/vm/exact-lifecycle.js':
		'5bfc6e182eebff4e7746187ec966ab8d5a91384d19c532f484ae5cd6de1c06e7',
} as const;

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((temporaryDirectory) => rm(temporaryDirectory, { force: true, recursive: true })),
	);
});

function sha256(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

async function createTemporaryProject(): Promise<string> {
	const projectDirectory = await mkdtemp(path.join(tmpdir(), 'agent-vm-gondolin-patch-'));
	temporaryDirectories.push(projectDirectory);
	await writeFile(
		path.join(projectDirectory, 'package.json'),
		`${JSON.stringify(
			{
				dependencies: { '@earendil-works/gondolin': '0.12.0' },
				private: true,
				type: 'module',
			},
			null,
			'\t',
		)}\n`,
	);
	await writeFile(
		path.join(projectDirectory, 'pnpm-workspace.yaml'),
		`packages: []

patchedDependencies:
  '@earendil-works/gondolin@0.12.0': ${patchRelativePath}
`,
	);
	await mkdir(path.join(projectDirectory, path.dirname(patchRelativePath)), { recursive: true });
	await copyFile(
		path.join(repositoryRoot, patchRelativePath),
		path.join(projectDirectory, patchRelativePath),
	);
	return projectDirectory;
}

describe('published Gondolin exact-VM patch installation', () => {
	it('reproduces the corrected JS, declarations, contract, and detached destroy from a frozen install', async () => {
		const projectDirectory = await createTemporaryProject();
		const patchPath = path.join(projectDirectory, patchRelativePath);
		const patchBytes = await readFile(patchPath);
		const patchText = patchBytes.toString('utf8');
		const patchEntries = patchText.match(/^diff --git .+$/gmu) ?? [];

		expect(sha256(patchBytes)).toBe(expectedPatchSha256);
		expect(patchEntries).toHaveLength(68);
		expect(
			patchEntries.every((entry) =>
				/^diff --git a\/dist\/.+\.(?:js|js\.map|d\.ts|d\.ts\.map) b\/dist\//u.test(entry),
			),
		).toBe(true);
		expect(patchText).not.toMatch(/^diff --git a\/(?:src|bin|package\.json)/mu);

		const installEnvironment = {
			...process.env,
			CI: 'true',
			PNPM_CONFIG_CONFIRM_MODULES_PURGE: 'false',
		};
		await execFileAsync('pnpm', ['install', '--lockfile-only', '--ignore-scripts'], {
			cwd: projectDirectory,
			env: installEnvironment,
		});
		await execFileAsync('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'], {
			cwd: projectDirectory,
			env: installEnvironment,
		});

		const lockfile = await readFile(path.join(projectDirectory, 'pnpm-lock.yaml'), 'utf8');
		expect(lockfile).toContain(`hash: ${expectedPatchSha256}`);
		const installedPackageRoot = path.join(
			projectDirectory,
			'node_modules',
			'@earendil-works',
			'gondolin',
		);
		await Promise.all(
			Object.entries(expectedInstalledFileSha256).map(async ([relativePath, expectedSha256]) => {
				const installedBytes = await readFile(path.join(installedPackageRoot, relativePath));
				expect(sha256(installedBytes), relativePath).toBe(expectedSha256);
			}),
		);

		await writeFile(
			path.join(projectDirectory, 'contract-proof.ts'),
			`import {
  GONDOLIN_EXACT_VM_LIFECYCLE_CONTRACT_VERSION,
  createVmOwnershipReservation,
  destroyVmExact,
  readVmDestroyTarget,
  readVmOwnershipReservation,
  type VmDestroyReceiptV1,
  type VmDestroyTargetV1,
  type VmOwnershipReservationV1,
} from '@earendil-works/gondolin';

const contractVersion: 1 = GONDOLIN_EXACT_VM_LIFECYCLE_CONTRACT_VERSION;
void contractVersion;
void createVmOwnershipReservation;
void destroyVmExact;
void readVmDestroyTarget;
void readVmOwnershipReservation;
const receipt: VmDestroyReceiptV1 | undefined = undefined;
const target: VmDestroyTargetV1 | undefined = undefined;
const reservation: VmOwnershipReservationV1 | undefined = undefined;
void receipt;
void target;
void reservation;
`,
		);
		await execFileAsync(
			path.join(repositoryRoot, 'node_modules', '.bin', 'tsc'),
			[
				'contract-proof.ts',
				'--noEmit',
				'--module',
				'NodeNext',
				'--moduleResolution',
				'NodeNext',
				'--skipLibCheck',
				'--strict',
				'--target',
				'ES2022',
			],
			{ cwd: projectDirectory },
		);

		const runtimeProof = await execFileAsync(
			process.execPath,
			[
				'--input-type=module',
				'--eval',
				`import {
  GONDOLIN_EXACT_VM_LIFECYCLE_CONTRACT_VERSION,
  createVmOwnershipReservation,
  destroyVmExact,
  readVmDestroyTarget,
  readVmOwnershipReservation,
} from '@earendil-works/gondolin';
const created = await createVmOwnershipReservation({
  reservationRoot: './ownership',
  reservationId: 'reservation-clean-install',
  vmId: 'vm-clean-install',
  controllerEpoch: 'controller-clean-install',
  parentGateway: null,
  role: 'standalone',
  sessionLabel: 'clean-install',
});
const reservation = await readVmOwnershipReservation(created.reservationPath);
const target = await readVmDestroyTarget(created.reservationPath);
const receipt = await destroyVmExact(target);
process.stdout.write(JSON.stringify({
  contractVersion: GONDOLIN_EXACT_VM_LIFECYCLE_CONTRACT_VERSION,
  reservationId: reservation.reservationId,
  targetVmId: target.vmId,
  receiptComplete: receipt.complete,
  receiptVersion: receipt.contractVersion,
}));`,
			],
			{ cwd: projectDirectory },
		);

		expect(JSON.parse(runtimeProof.stdout)).toEqual({
			contractVersion: 1,
			receiptComplete: true,
			receiptVersion: 1,
			reservationId: 'reservation-clean-install',
			targetVmId: 'vm-clean-install',
		});
	}, 60_000);
});
