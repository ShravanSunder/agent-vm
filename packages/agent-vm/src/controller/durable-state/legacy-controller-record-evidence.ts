import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

export type LegacyControllerRecordFamily =
	| 'approvals'
	| 'gateway-runtime'
	| 'gateway-state-root'
	| 'tool-leases'
	| 'worker-task-gateway-runtime';

export type LegacyControllerRecordEvidenceKind =
	| 'directory'
	| 'file'
	| 'missing'
	| 'other'
	| 'symbolic-link'
	| 'unreadable-directory';

export interface LegacyControllerRecordEvidence {
	readonly absolutePath: string;
	readonly family: LegacyControllerRecordFamily;
	readonly kind: LegacyControllerRecordEvidenceKind;
}

type FilesystemStatus = Awaited<ReturnType<typeof lstat>>;

function isMissingPathError(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

async function lstatIfPresent(absolutePath: string): Promise<FilesystemStatus | null> {
	try {
		return await lstat(absolutePath);
	} catch (error: unknown) {
		if (isMissingPathError(error)) {
			return null;
		}
		throw error;
	}
}

function evidenceKindForStatus(status: FilesystemStatus): LegacyControllerRecordEvidenceKind {
	if (status.isSymbolicLink()) {
		return 'symbolic-link';
	}
	if (status.isDirectory()) {
		return 'directory';
	}
	if (status.isFile()) {
		return 'file';
	}
	return 'other';
}

function createEvidence(options: {
	readonly absolutePath: string;
	readonly family: LegacyControllerRecordFamily;
	readonly kind: LegacyControllerRecordEvidenceKind;
}): LegacyControllerRecordEvidence {
	return Object.freeze({
		absolutePath: options.absolutePath,
		family: options.family,
		kind: options.kind,
	});
}

async function appendEvidenceWhenPresent(options: {
	readonly absolutePath: string;
	readonly evidence: LegacyControllerRecordEvidence[];
	readonly family: LegacyControllerRecordFamily;
}): Promise<void> {
	const status = await lstatIfPresent(options.absolutePath);
	if (status === null) {
		return;
	}
	options.evidence.push(
		createEvidence({
			absolutePath: options.absolutePath,
			family: options.family,
			kind: evidenceKindForStatus(status),
		}),
	);
}

async function readDirectoryNamesFailClosed(options: {
	readonly absolutePath: string;
	readonly evidence: LegacyControllerRecordEvidence[];
	readonly family: LegacyControllerRecordFamily;
}): Promise<readonly string[] | null> {
	try {
		return (await readdir(options.absolutePath)).toSorted();
	} catch {
		options.evidence.push(
			createEvidence({
				absolutePath: options.absolutePath,
				family: options.family,
				kind: 'unreadable-directory',
			}),
		);
		return null;
	}
}

async function appendWorkerTaskLegacyEvidence(options: {
	readonly evidence: LegacyControllerRecordEvidence[];
	readonly gatewayStateDirectoryPath: string;
}): Promise<void> {
	const family = 'worker-task-gateway-runtime' as const;
	const tasksDirectoryPath = path.join(options.gatewayStateDirectoryPath, 'tasks');
	const tasksDirectoryStatus = await lstatIfPresent(tasksDirectoryPath);
	if (tasksDirectoryStatus === null) {
		return;
	}
	if (!tasksDirectoryStatus.isDirectory() || tasksDirectoryStatus.isSymbolicLink()) {
		options.evidence.push(
			createEvidence({
				absolutePath: tasksDirectoryPath,
				family,
				kind: evidenceKindForStatus(tasksDirectoryStatus),
			}),
		);
		return;
	}

	const taskDirectoryNames = await readDirectoryNamesFailClosed({
		absolutePath: tasksDirectoryPath,
		evidence: options.evidence,
		family,
	});
	if (taskDirectoryNames === null) {
		return;
	}

	for (const taskDirectoryName of taskDirectoryNames) {
		const taskDirectoryPath = path.join(tasksDirectoryPath, taskDirectoryName);
		// oxlint-disable-next-line no-await-in-loop -- bounded one-level forensic inspection is intentionally ordered.
		const taskDirectoryStatus = await lstatIfPresent(taskDirectoryPath);
		if (taskDirectoryStatus === null) {
			options.evidence.push(
				createEvidence({ absolutePath: taskDirectoryPath, family, kind: 'missing' }),
			);
			continue;
		}
		if (!taskDirectoryStatus.isDirectory() || taskDirectoryStatus.isSymbolicLink()) {
			options.evidence.push(
				createEvidence({
					absolutePath: taskDirectoryPath,
					family,
					kind: evidenceKindForStatus(taskDirectoryStatus),
				}),
			);
			continue;
		}

		const workerStateDirectoryPath = path.join(taskDirectoryPath, 'state');
		// oxlint-disable-next-line no-await-in-loop -- bounded one-level forensic inspection is intentionally ordered.
		const workerStateDirectoryStatus = await lstatIfPresent(workerStateDirectoryPath);
		if (workerStateDirectoryStatus === null) {
			options.evidence.push(
				createEvidence({ absolutePath: workerStateDirectoryPath, family, kind: 'missing' }),
			);
			continue;
		}
		if (!workerStateDirectoryStatus.isDirectory() || workerStateDirectoryStatus.isSymbolicLink()) {
			options.evidence.push(
				createEvidence({
					absolutePath: workerStateDirectoryPath,
					family,
					kind: evidenceKindForStatus(workerStateDirectoryStatus),
				}),
			);
			continue;
		}

		const workerRuntimeRecordPath = path.join(workerStateDirectoryPath, 'gateway-runtime.json');
		// oxlint-disable-next-line no-await-in-loop -- bounded one-level forensic inspection is intentionally ordered.
		await appendEvidenceWhenPresent({
			absolutePath: workerRuntimeRecordPath,
			evidence: options.evidence,
			family,
		});
	}
}

export async function scanLegacyControllerRecordEvidence(options: {
	readonly gatewayStateDirectoryPath: string;
}): Promise<readonly LegacyControllerRecordEvidence[]> {
	if (!path.isAbsolute(options.gatewayStateDirectoryPath)) {
		throw new Error('Legacy controller record evidence scanning requires an absolute stateDir.');
	}

	const gatewayStateDirectoryStatus = await lstatIfPresent(options.gatewayStateDirectoryPath);
	if (gatewayStateDirectoryStatus === null) {
		return Object.freeze([]);
	}
	if (!gatewayStateDirectoryStatus.isDirectory() || gatewayStateDirectoryStatus.isSymbolicLink()) {
		return Object.freeze([
			createEvidence({
				absolutePath: options.gatewayStateDirectoryPath,
				family: 'gateway-state-root',
				kind: evidenceKindForStatus(gatewayStateDirectoryStatus),
			}),
		]);
	}

	const evidence: LegacyControllerRecordEvidence[] = [];
	await appendEvidenceWhenPresent({
		absolutePath: path.join(options.gatewayStateDirectoryPath, 'gateway-runtime.json'),
		evidence,
		family: 'gateway-runtime',
	});
	await appendEvidenceWhenPresent({
		absolutePath: path.join(options.gatewayStateDirectoryPath, 'approvals'),
		evidence,
		family: 'approvals',
	});
	await appendEvidenceWhenPresent({
		absolutePath: path.join(options.gatewayStateDirectoryPath, 'tool-leases'),
		evidence,
		family: 'tool-leases',
	});
	await appendWorkerTaskLegacyEvidence({
		evidence,
		gatewayStateDirectoryPath: options.gatewayStateDirectoryPath,
	});

	return Object.freeze(
		evidence.toSorted((left, right) =>
			left.absolutePath === right.absolutePath
				? left.family.localeCompare(right.family) || left.kind.localeCompare(right.kind)
				: left.absolutePath.localeCompare(right.absolutePath),
		),
	);
}
