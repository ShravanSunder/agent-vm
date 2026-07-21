import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

import type {
	ManagedVm,
	ManagedVmCanonicalDirectoryIdentity,
	ManagedVmCreateRequest,
	ManagedVmFactory,
	ManagedVmFilteredWorkspacePolicy,
	ManagedVmOwnedDirectoryCapability,
	OwnedHostDirectory,
} from '@agent-vm/managed-vm';

const MANAGED_AGENT_WORKSPACE_GUEST_ROOT = '/workspace';
const MANAGED_AGENT_GIT_DIRECTORIES_GUEST_ROOT = '/gitdirs';

const managedAgentToolVmOptionKeys = new Set([
	'factory',
	'hostGitDirectoryRoot',
	'hostWorkspaceRoot',
	'ownedDirectories',
	'request',
	'workspacePolicy',
]);

async function readCanonicalDirectoryIdentity(
	directoryPath: string,
): Promise<ManagedVmCanonicalDirectoryIdentity> {
	const canonicalPath = await realpath(directoryPath);
	const status = await lstat(canonicalPath);
	if (!status.isDirectory() || status.isSymbolicLink()) {
		throw new Error(`Managed agent root '${directoryPath}' must be a real directory.`);
	}
	return { canonicalPath, device: status.dev, inode: status.ino };
}

function identitiesEqual(
	leftIdentity: ManagedVmCanonicalDirectoryIdentity,
	rightIdentity: ManagedVmCanonicalDirectoryIdentity,
): boolean {
	return (
		leftIdentity.canonicalPath === rightIdentity.canonicalPath &&
		leftIdentity.device === rightIdentity.device &&
		leftIdentity.inode === rightIdentity.inode
	);
}

function closeAcquiredDirectories(ownedDirectories: readonly OwnedHostDirectory[]): void {
	const cleanupErrors: unknown[] = [];
	for (const ownedDirectory of ownedDirectories) {
		if (ownedDirectory.state !== 'acquired') {
			continue;
		}
		try {
			ownedDirectory.close();
		} catch (error) {
			cleanupErrors.push(error);
		}
	}
	if (cleanupErrors.length > 0) {
		throw new AggregateError(cleanupErrors, 'Failed to close managed agent root capabilities.');
	}
}

function assertNoUnsupportedOptions(options: object): void {
	for (const optionKey of Object.keys(options)) {
		if (!managedAgentToolVmOptionKeys.has(optionKey)) {
			throw new Error(`Managed agent Tool VM options contain unsupported option '${optionKey}'.`);
		}
	}
}

export async function createManagedVmWithFilteredAgentWorkspace(
	options: {
		readonly factory: ManagedVmFactory;
		readonly hostGitDirectoryRoot?: string | undefined;
		readonly hostWorkspaceRoot: string;
		readonly ownedDirectories: ManagedVmOwnedDirectoryCapability;
		readonly request: Omit<ManagedVmCreateRequest, 'mounts'>;
		readonly workspacePolicy: ManagedVmFilteredWorkspacePolicy;
	},
	dependencies: {
		readonly readDirectoryIdentity?: typeof readCanonicalDirectoryIdentity;
	} = {},
): Promise<ManagedVm> {
	assertNoUnsupportedOptions(options);
	if ('mounts' in options.request) {
		throw new Error('Managed agent Tool VM request must not provide additional mounts.');
	}
	if (!path.isAbsolute(options.hostWorkspaceRoot)) {
		throw new Error('Managed agent workspace root must be absolute.');
	}
	if (
		options.hostGitDirectoryRoot !== undefined &&
		!path.isAbsolute(options.hostGitDirectoryRoot)
	) {
		throw new Error('Managed agent Git directory root must be absolute.');
	}
	if (
		options.hostGitDirectoryRoot !== undefined &&
		options.hostGitDirectoryRoot === options.hostWorkspaceRoot
	) {
		throw new Error('Managed agent workspace and Git directory roots must be distinct.');
	}
	const readDirectoryIdentity =
		dependencies.readDirectoryIdentity ?? readCanonicalDirectoryIdentity;
	const expectedWorkspaceIdentity = await readDirectoryIdentity(options.hostWorkspaceRoot);
	const expectedGitDirectoryIdentity =
		options.hostGitDirectoryRoot === undefined
			? undefined
			: await readDirectoryIdentity(options.hostGitDirectoryRoot);
	if (
		expectedGitDirectoryIdentity !== undefined &&
		expectedWorkspaceIdentity.device === expectedGitDirectoryIdentity.device &&
		expectedWorkspaceIdentity.inode === expectedGitDirectoryIdentity.inode
	) {
		throw new Error(
			'Managed agent workspace and Git directory roots resolve to the same directory identity.',
		);
	}

	const openedDirectories: OwnedHostDirectory[] = [];
	let retainAcquiredDirectoriesOnFailure = false;
	let toolVm: ManagedVm | undefined;
	try {
		const workspaceDirectory = options.ownedDirectories.openHostDirectory(
			expectedWorkspaceIdentity.canonicalPath,
		);
		openedDirectories.push(workspaceDirectory);
		const gitDirectory =
			expectedGitDirectoryIdentity === undefined
				? undefined
				: options.ownedDirectories.openHostDirectory(expectedGitDirectoryIdentity.canonicalPath);
		if (gitDirectory !== undefined) {
			openedDirectories.push(gitDirectory);
		}

		const revalidatedWorkspaceIdentity = await readDirectoryIdentity(options.hostWorkspaceRoot);
		const revalidatedGitDirectoryIdentity =
			options.hostGitDirectoryRoot === undefined
				? undefined
				: await readDirectoryIdentity(options.hostGitDirectoryRoot);
		if (
			!identitiesEqual(workspaceDirectory.identity, expectedWorkspaceIdentity) ||
			!identitiesEqual(workspaceDirectory.identity, revalidatedWorkspaceIdentity)
		) {
			throw new Error(
				'Managed agent workspace capability has a stale canonical path or directory identity.',
			);
		}
		if (
			gitDirectory !== undefined &&
			expectedGitDirectoryIdentity !== undefined &&
			revalidatedGitDirectoryIdentity !== undefined &&
			(!identitiesEqual(gitDirectory.identity, expectedGitDirectoryIdentity) ||
				!identitiesEqual(gitDirectory.identity, revalidatedGitDirectoryIdentity))
		) {
			throw new Error(
				'Managed agent Git directory capability has a stale canonical path or directory identity.',
			);
		}

		toolVm = await options.factory.createManagedVm({
			...options.request,
			mounts: {
				[MANAGED_AGENT_WORKSPACE_GUEST_ROOT]: {
					directory: workspaceDirectory,
					kind: 'owned-filtered-workspace',
					policy: options.workspacePolicy,
				},
				...(gitDirectory === undefined
					? {}
					: {
							[MANAGED_AGENT_GIT_DIRECTORIES_GUEST_ROOT]: {
								access: 'read-write' as const,
								directory: gitDirectory,
								kind: 'owned-host-directory' as const,
							},
						}),
			},
		});
		if (
			workspaceDirectory.state !== 'adapter-owned' ||
			(gitDirectory !== undefined && gitDirectory.state !== 'adapter-owned')
		) {
			const unexpectedHostProcessId = toolVm.getHostProcessId();
			if (unexpectedHostProcessId !== null) {
				retainAcquiredDirectoriesOnFailure = true;
				throw new Error(
					`Managed VM provider returned live runner pid ${String(unexpectedHostProcessId)} without captured process identity or consuming every managed agent directory; refusing raw close and capability release.`,
				);
			}
			await toolVm.close();
			toolVm = undefined;
			closeAcquiredDirectories(openedDirectories);
			throw new Error(
				gitDirectory === undefined
					? 'Managed VM provider must transfer the managed agent workspace directory.'
					: 'Managed VM provider must transfer the managed agent workspace and Git directories.',
			);
		}
		return toolVm;
	} catch (error) {
		if (retainAcquiredDirectoriesOnFailure) {
			throw error;
		}
		try {
			closeAcquiredDirectories(openedDirectories);
		} catch (cleanupError) {
			// oxlint-disable-next-line preserve-caught-error -- AggregateError.errors and cause preserve both failures.
			throw new AggregateError(
				[error, cleanupError],
				'Managed agent root admission and cleanup both failed.',
				{ cause: error },
			);
		}
		throw error;
	}
}
