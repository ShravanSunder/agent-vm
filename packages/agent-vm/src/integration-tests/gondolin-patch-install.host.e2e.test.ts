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
const expectedPatchSha256 = '842d798fa671945669a1a2150ba39bdd04f4d00ec610963b8df397c84ceeba7b';
const expectedInstalledFileSha256 = {
	'dist/src/index.d.ts': '1e880e35b3bce2caf1591f9929b4eb6d313f0176dbfb85a6a91a1d72f5409052',
	'dist/src/index.js': '611beb906628529eff6518ae99ccf88a87d7591ff9b29655f1a6d84f0df46a1b',
	'dist/src/vm/core.d.ts': 'd9479abe77398b544954db9318a854615a22d82a7648b46fa74d819c9ed92996',
	'dist/src/vm/core.js': 'caf273be423e81119129b420539eef3af58645ed858a2ff455127df7d5b0e217',
	'dist/src/vm/exact-lifecycle-contracts.d.ts':
		'697180ee4660efb0c85f36a08535120d32dee81e8fe9ea081f61cd6eb1e43e7e',
	'dist/src/vm/exact-lifecycle-contracts.js':
		'3bec4953bef6bfbb3e87e8c6d9349b2ba46ae298fcdd831a1507c201444aa083',
	'dist/src/vm/exact-lifecycle.d.ts':
		'5a3859226a1963b686e92679bdd08a599c2ced011359386ef594b8f76acac676',
	'dist/src/vm/exact-lifecycle.js':
		'5bfc6e182eebff4e7746187ec966ab8d5a91384d19c532f484ae5cd6de1c06e7',
	'dist/src/vm/ssh-access.d.ts': '743369475891d4122d23119106664be9f9f3bc9f8684d32a10f86c3c214fcee3',
	'dist/src/vm/ssh-access.js': 'aa3b267ee27e4d6fcf8b68727c3d5f5cb734b0f4ab7729c9c176cdea13e3e9ce',
	'dist/src/vm/vm-exact-destruction.js':
		'6d4b54918cad48c93753b607fb5b60fce5a57762b18624e3725816712b695eef',
	'dist/src/vm/vm-ownership-reservation.d.ts':
		'212004175dc42017dfbec622640a04fa458a7fea6399eb4bff0ca0fc6ea623fb',
	'dist/src/vm/vm-ownership-reservation.js':
		'15ad7e7a8a54d924ae143a0a97ba3d494e71a1b3e57de82fc1deb655b863d2bb',
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
		expect(patchEntries).toHaveLength(72);
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
  GONDOLIN_VM_OWNERSHIP_PRINCIPAL_MAX_CODE_UNITS,
  createVmOwnershipReservation,
  destroyVmExact,
  readVmDestroyTarget,
  readVmOwnershipReservation,
  type VmDestroyReceiptV1,
  type VmDestroyTargetV1,
  type VmOwnershipReservationV1,
  type SshServerHostKey,
} from '@earendil-works/gondolin';

const contractVersion: 1 = GONDOLIN_EXACT_VM_LIFECYCLE_CONTRACT_VERSION;
const principalMaxCodeUnits: 65536 = GONDOLIN_VM_OWNERSHIP_PRINCIPAL_MAX_CODE_UNITS;
void contractVersion;
void principalMaxCodeUnits;
void createVmOwnershipReservation;
void destroyVmExact;
void readVmDestroyTarget;
void readVmOwnershipReservation;
const receipt: VmDestroyReceiptV1 | undefined = undefined;
const target: VmDestroyTargetV1 | undefined = undefined;
const reservation: VmOwnershipReservationV1 | undefined = undefined;
const sshServerHostKey: SshServerHostKey | undefined = undefined;
void receipt;
void target;
void reservation;
void sshServerHostKey;
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
				`import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  GONDOLIN_EXACT_VM_LIFECYCLE_CONTRACT_VERSION,
  createVmOwnershipReservation,
  destroyVmExact,
  readVmDestroyTarget,
  readVmOwnershipReservation,
} from '@earendil-works/gondolin';
const sessionIpcPath = path.resolve('reused-session-ipc.sock');
const qmpSocketPath = path.resolve('reused-qmp.sock');
const disposableStoragePath = path.resolve('reused-storage.img');
await Promise.all([
  writeFile(sessionIpcPath, 'old-owner'),
  writeFile(qmpSocketPath, 'old-owner'),
  writeFile(disposableStoragePath, 'old-owner'),
]);
const created = await createVmOwnershipReservation({
  reservationRoot: './ownership',
  reservationId: 'reservation-clean-install',
  vmId: 'vm-clean-install',
  controllerEpoch: 'controller-clean-install',
  parentGateway: null,
  role: 'standalone',
  sessionLabel: 'clean-install',
  resources: {
    sessionIpcPath,
    qmpSocketPath,
    disposableStoragePaths: [disposableStoragePath],
  },
});
const reservation = await readVmOwnershipReservation(created.reservationPath);
const target = await readVmDestroyTarget(created.reservationPath);
const receipt = await destroyVmExact(target);
const destroyedReservation = await readVmOwnershipReservation(created.reservationPath);
await Promise.all([
  writeFile(sessionIpcPath, 'successor-owner'),
  writeFile(qmpSocketPath, 'successor-owner'),
  writeFile(disposableStoragePath, 'successor-owner'),
]);
const replayReceipt = await destroyVmExact(target);
const successorContents = await Promise.all([
  readFile(sessionIpcPath, 'utf8'),
  readFile(qmpSocketPath, 'utf8'),
  readFile(disposableStoragePath, 'utf8'),
]);
process.stdout.write(JSON.stringify({
  contractVersion: GONDOLIN_EXACT_VM_LIFECYCLE_CONTRACT_VERSION,
  reservationId: reservation.reservationId,
  targetVmId: target.vmId,
  receiptComplete: receipt.complete,
  receiptVersion: receipt.contractVersion,
  replayComplete: replayReceipt.complete,
  reservationState: destroyedReservation.state,
  successorContents,
}));`,
			],
			{ cwd: projectDirectory },
		);

		expect(JSON.parse(runtimeProof.stdout)).toEqual({
			contractVersion: 1,
			receiptComplete: true,
			receiptVersion: 1,
			replayComplete: true,
			reservationState: 'destroyed',
			reservationId: 'reservation-clean-install',
			successorContents: ['successor-owner', 'successor-owner', 'successor-owner'],
			targetVmId: 'vm-clean-install',
		});
	}, 60_000);
});
