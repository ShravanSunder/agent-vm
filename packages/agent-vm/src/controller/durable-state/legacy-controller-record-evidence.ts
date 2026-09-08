import { lstat } from 'node:fs/promises';
import path from 'node:path';

export type LegacyControllerRecordFamily =
	| 'approvals'
	| 'gateway-runtime'
	| 'gateway-state-root'
	| 'tool-leases';

export type LegacyControllerRecordEvidenceKind =
	| 'directory'
	| 'file'
	| 'missing'
	| 'other'
	| 'symbolic-link';

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
	return Object.freeze(
		evidence.toSorted((left, right) =>
			left.absolutePath === right.absolutePath
				? left.family.localeCompare(right.family) || left.kind.localeCompare(right.kind)
				: left.absolutePath.localeCompare(right.absolutePath),
		),
	);
}
