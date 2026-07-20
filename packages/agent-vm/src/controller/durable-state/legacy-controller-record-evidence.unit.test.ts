import {
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readlink,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
	scanLegacyControllerRecordEvidence,
	type LegacyControllerRecordEvidenceKind,
	type LegacyControllerRecordFamily,
} from './legacy-controller-record-evidence.js';

const temporaryDirectories: string[] = [];

async function createGatewayStateDirectory(): Promise<string> {
	const gatewayStateDirectoryPath = await mkdtemp(
		path.join(os.tmpdir(), 'agent-vm-legacy-controller-records-'),
	);
	temporaryDirectories.push(gatewayStateDirectoryPath);
	return gatewayStateDirectoryPath;
}

async function createFilesystemEntry(
	absolutePath: string,
	kind: 'directory' | 'file' | 'symbolic-link',
): Promise<void> {
	await mkdir(path.dirname(absolutePath), { recursive: true });
	switch (kind) {
		case 'directory':
			await mkdir(absolutePath);
			return;
		case 'file':
			await writeFile(absolutePath, 'forensic-evidence\n', 'utf8');
			return;
		case 'symbolic-link':
			await symlink('untrusted-symlink-target', absolutePath);
	}
}

function expectedEvidence(options: {
	readonly absolutePath: string;
	readonly family: LegacyControllerRecordFamily;
	readonly kind: LegacyControllerRecordEvidenceKind;
}): Readonly<{
	readonly absolutePath: string;
	readonly family: LegacyControllerRecordFamily;
	readonly kind: LegacyControllerRecordEvidenceKind;
}> {
	return options;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(async (temporaryDirectoryPath) => {
			await rm(temporaryDirectoryPath, { force: true, recursive: true });
		}),
	);
});

describe('legacy controller record evidence scanner', () => {
	it('returns no evidence when every bounded legacy path is absent', async () => {
		// Arrange
		const gatewayStateDirectoryPath = await createGatewayStateDirectory();

		// Act
		const evidence = await scanLegacyControllerRecordEvidence({ gatewayStateDirectoryPath });

		// Assert
		expect(evidence).toEqual([]);
		expect(Object.isFrozen(evidence)).toBe(true);
	});

	it('reports a symbolic-link Gateway state root without following it', async () => {
		// Arrange
		const temporaryDirectoryPath = await createGatewayStateDirectory();
		const externalStateDirectoryPath = path.join(temporaryDirectoryPath, 'external-state');
		const gatewayStateDirectoryPath = path.join(temporaryDirectoryPath, 'gateway-state-link');
		await mkdir(externalStateDirectoryPath);
		await writeFile(
			path.join(externalStateDirectoryPath, 'gateway-runtime.json'),
			'outside-root\n',
			'utf8',
		);
		await symlink(externalStateDirectoryPath, gatewayStateDirectoryPath);

		// Act
		const evidence = await scanLegacyControllerRecordEvidence({ gatewayStateDirectoryPath });

		// Assert
		expect(evidence).toEqual([
			expectedEvidence({
				absolutePath: gatewayStateDirectoryPath,
				family: 'gateway-state-root',
				kind: 'symbolic-link',
			}),
		]);
	});

	it.each([
		['gateway-runtime', 'gateway-runtime.json', 'file', 'file'],
		['gateway-runtime', 'gateway-runtime.json', 'directory', 'directory'],
		['gateway-runtime', 'gateway-runtime.json', 'symbolic-link', 'symbolic-link'],
		['approvals', 'approvals', 'file', 'file'],
		['approvals', 'approvals', 'directory', 'directory'],
		['approvals', 'approvals', 'symbolic-link', 'symbolic-link'],
		['tool-leases', 'tool-leases', 'file', 'file'],
		['tool-leases', 'tool-leases', 'directory', 'directory'],
		['tool-leases', 'tool-leases', 'symbolic-link', 'symbolic-link'],
	] as const)(
		'reports %s legacy evidence when the bounded path is a %s entry',
		async (family, relativePath, entryKind, evidenceKind) => {
			// Arrange
			const gatewayStateDirectoryPath = await createGatewayStateDirectory();
			const absolutePath = path.join(gatewayStateDirectoryPath, relativePath);
			await createFilesystemEntry(absolutePath, entryKind);

			// Act
			const evidence = await scanLegacyControllerRecordEvidence({ gatewayStateDirectoryPath });

			// Assert
			expect(evidence).toEqual([expectedEvidence({ absolutePath, family, kind: evidenceKind })]);
			expect(Object.isFrozen(evidence[0])).toBe(true);
		},
	);

	it.each(['file', 'directory', 'symbolic-link'] as const)(
		'reports Worker legacy runtime evidence when the exact record path is a %s entry',
		async (entryKind) => {
			// Arrange
			const gatewayStateDirectoryPath = await createGatewayStateDirectory();
			const absolutePath = path.join(
				gatewayStateDirectoryPath,
				'tasks',
				'task-a',
				'state',
				'gateway-runtime.json',
			);
			await createFilesystemEntry(absolutePath, entryKind);

			// Act
			const evidence = await scanLegacyControllerRecordEvidence({ gatewayStateDirectoryPath });

			// Assert
			expect(evidence).toEqual([
				expectedEvidence({
					absolutePath,
					family: 'worker-task-gateway-runtime',
					kind: entryKind,
				}),
			]);
		},
	);

	it('sorts evidence deterministically across legacy families and Worker tasks', async () => {
		// Arrange
		const gatewayStateDirectoryPath = await createGatewayStateDirectory();
		const evidencePaths = [
			path.join(gatewayStateDirectoryPath, 'tasks', 'task-z', 'state', 'gateway-runtime.json'),
			path.join(gatewayStateDirectoryPath, 'tool-leases'),
			path.join(gatewayStateDirectoryPath, 'gateway-runtime.json'),
			path.join(gatewayStateDirectoryPath, 'tasks', 'task-a', 'state', 'gateway-runtime.json'),
			path.join(gatewayStateDirectoryPath, 'approvals'),
		];
		await Promise.all(
			evidencePaths.map(async (evidencePath) => {
				await createFilesystemEntry(evidencePath, 'file');
			}),
		);

		// Act
		const evidence = await scanLegacyControllerRecordEvidence({ gatewayStateDirectoryPath });

		// Assert
		expect(evidence.map((record) => record.absolutePath)).toEqual(evidencePaths.toSorted());
	});

	it('reports unsafe Worker task topology without following symbolic links', async () => {
		// Arrange
		const gatewayStateDirectoryPath = await createGatewayStateDirectory();
		const tasksDirectoryPath = path.join(gatewayStateDirectoryPath, 'tasks');
		const missingStatePath = path.join(tasksDirectoryPath, 'missing-state', 'state');
		const symbolicTaskPath = path.join(tasksDirectoryPath, 'symbolic-task');
		const symbolicStatePath = path.join(tasksDirectoryPath, 'symbolic-state', 'state');
		await mkdir(path.join(tasksDirectoryPath, 'missing-state'), { recursive: true });
		await symlink('missing-state', symbolicTaskPath);
		await mkdir(path.dirname(symbolicStatePath), { recursive: true });
		await symlink('../missing-state', symbolicStatePath);

		// Act
		const evidence = await scanLegacyControllerRecordEvidence({ gatewayStateDirectoryPath });

		// Assert
		expect(evidence).toEqual(
			[
				expectedEvidence({
					absolutePath: missingStatePath,
					family: 'worker-task-gateway-runtime',
					kind: 'missing',
				}),
				expectedEvidence({
					absolutePath: symbolicStatePath,
					family: 'worker-task-gateway-runtime',
					kind: 'symbolic-link',
				}),
				expectedEvidence({
					absolutePath: symbolicTaskPath,
					family: 'worker-task-gateway-runtime',
					kind: 'symbolic-link',
				}),
			].toSorted((left, right) => left.absolutePath.localeCompare(right.absolutePath)),
		);
	});

	it.each(['file', 'symbolic-link'] as const)(
		'reports an unsafe %s tasks root without traversing it',
		async (entryKind) => {
			// Arrange
			const gatewayStateDirectoryPath = await createGatewayStateDirectory();
			const tasksDirectoryPath = path.join(gatewayStateDirectoryPath, 'tasks');
			await createFilesystemEntry(tasksDirectoryPath, entryKind);

			// Act
			const evidence = await scanLegacyControllerRecordEvidence({ gatewayStateDirectoryPath });

			// Assert
			expect(evidence).toEqual([
				expectedEvidence({
					absolutePath: tasksDirectoryPath,
					family: 'worker-task-gateway-runtime',
					kind: entryKind,
				}),
			]);
		},
	);

	it('does not mutate legacy record content, metadata, or symbolic-link targets', async () => {
		// Arrange
		const gatewayStateDirectoryPath = await createGatewayStateDirectory();
		const runtimeRecordPath = path.join(gatewayStateDirectoryPath, 'gateway-runtime.json');
		const approvalsPath = path.join(gatewayStateDirectoryPath, 'approvals');
		await writeFile(runtimeRecordPath, '{"forensic":"record"}\n', {
			encoding: 'utf8',
			mode: 0o640,
		});
		await symlink('untrusted-approval-target', approvalsPath);
		const beforeContent = await readFile(runtimeRecordPath, 'utf8');
		const beforeMetadata = await lstat(runtimeRecordPath);
		const beforeLinkTarget = await readlink(approvalsPath);

		// Act
		await scanLegacyControllerRecordEvidence({ gatewayStateDirectoryPath });

		// Assert
		const afterMetadata = await lstat(runtimeRecordPath);
		expect(await readFile(runtimeRecordPath, 'utf8')).toBe(beforeContent);
		expect({
			mode: afterMetadata.mode,
			mtimeMs: afterMetadata.mtimeMs,
			size: afterMetadata.size,
		}).toEqual({
			mode: beforeMetadata.mode,
			mtimeMs: beforeMetadata.mtimeMs,
			size: beforeMetadata.size,
		});
		expect(await readlink(approvalsPath)).toBe(beforeLinkTarget);
	});
});
