import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

import { agentIdSchema } from '../../config/system-config-identifier-schemas.js';
import type { SystemConfig } from '../../config/system-config.js';

type ZoneConfig = SystemConfig['zones'][number];

export type ControllerSelectedToolVmDirectoryValidationErrorKind =
	| 'not-absolute'
	| 'not-controller-selected'
	| 'not-real-directory'
	| 'parent-traversal'
	| 'realpath-failed'
	| 'unsupported-gateway';

export class ControllerSelectedToolVmDirectoryValidationError extends Error {
	readonly kind: ControllerSelectedToolVmDirectoryValidationErrorKind;

	constructor(
		kind: ControllerSelectedToolVmDirectoryValidationErrorKind,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = 'ControllerSelectedToolVmDirectoryValidationError';
		this.kind = kind;
	}
}

type ControllerSelectedToolVmDirectory =
	| {
			readonly agentId: string;
			readonly hostDirectory: string;
			readonly kind: 'managed-agent-workspace';
			readonly zone: ZoneConfig;
	  }
	| {
			readonly hostDirectory: string;
			readonly kind: 'zone-files';
			readonly zone: ZoneConfig;
	  };

function expectedControllerSelectedDirectory(selection: ControllerSelectedToolVmDirectory): string {
	if (selection.zone.gateway.type === 'worker') {
		throw new ControllerSelectedToolVmDirectoryValidationError(
			'unsupported-gateway',
			`Zone '${selection.zone.id}' does not support managed framework Tool VM directories.`,
		);
	}
	if (selection.kind === 'zone-files') {
		return selection.zone.gateway.zoneFilesDir;
	}
	const agentId = agentIdSchema.parse(selection.agentId);
	return path.join(selection.zone.gateway.zoneFilesDir, 'agents', agentId);
}

async function requireRealDirectory(directoryPath: string): Promise<void> {
	let status: Awaited<ReturnType<typeof lstat>>;
	try {
		status = await lstat(directoryPath);
	} catch (error) {
		throw new ControllerSelectedToolVmDirectoryValidationError(
			'realpath-failed',
			`Controller-selected Tool VM directory '${directoryPath}' could not be inspected.`,
			{ cause: error },
		);
	}
	if (!status.isDirectory() || status.isSymbolicLink()) {
		throw new ControllerSelectedToolVmDirectoryValidationError(
			'not-real-directory',
			`Controller-selected Tool VM directory '${directoryPath}' must be a real directory.`,
		);
	}
}

export async function validateControllerSelectedToolVmDirectory(
	selection: ControllerSelectedToolVmDirectory,
): Promise<string> {
	if (!path.isAbsolute(selection.hostDirectory)) {
		throw new ControllerSelectedToolVmDirectoryValidationError(
			'not-absolute',
			`Controller-selected Tool VM directory '${selection.hostDirectory}' must be absolute.`,
		);
	}
	if (selection.hostDirectory.split(/[\\/]+/u).includes('..')) {
		throw new ControllerSelectedToolVmDirectoryValidationError(
			'parent-traversal',
			`Controller-selected Tool VM directory '${selection.hostDirectory}' must not contain '..' path segments.`,
		);
	}

	const expectedDirectory = expectedControllerSelectedDirectory(selection);
	await requireRealDirectory(expectedDirectory);
	let canonicalExpectedDirectory: string;
	try {
		canonicalExpectedDirectory = await realpath(expectedDirectory);
	} catch (error) {
		throw new ControllerSelectedToolVmDirectoryValidationError(
			'realpath-failed',
			`Controller-selected Tool VM directory '${expectedDirectory}' failed canonical resolution.`,
			{ cause: error },
		);
	}
	const resolvedSelection = path.resolve(selection.hostDirectory);
	if (
		resolvedSelection !== path.resolve(expectedDirectory) &&
		resolvedSelection !== canonicalExpectedDirectory
	) {
		throw new ControllerSelectedToolVmDirectoryValidationError(
			'not-controller-selected',
			`Tool VM directory '${selection.hostDirectory}' does not match controller-selected ${selection.kind} directory '${expectedDirectory}'.`,
		);
	}

	try {
		const canonicalSelection = await realpath(selection.hostDirectory);
		if (canonicalSelection !== canonicalExpectedDirectory) {
			throw new ControllerSelectedToolVmDirectoryValidationError(
				'not-controller-selected',
				`Tool VM directory '${selection.hostDirectory}' does not resolve to controller-selected ${selection.kind} directory '${canonicalExpectedDirectory}'.`,
			);
		}
		return canonicalSelection;
	} catch (error) {
		if (error instanceof ControllerSelectedToolVmDirectoryValidationError) {
			throw error;
		}
		throw new ControllerSelectedToolVmDirectoryValidationError(
			'realpath-failed',
			`Controller-selected Tool VM directory '${expectedDirectory}' failed canonical resolution.`,
			{ cause: error },
		);
	}
}
