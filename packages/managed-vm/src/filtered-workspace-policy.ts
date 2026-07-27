import path from 'node:path';

import type {
	ManagedVmFilteredWorkspacePolicy,
	ManagedVmFilteredWorkspaceReadonlyInput,
} from './managed-vm-contracts.js';

function assertNormalizedRelativePath(
	relativePath: string,
	fieldName: string,
	allowWorkspaceRoot = false,
): void {
	if (relativePath.length === 0) {
		if (allowWorkspaceRoot) {
			return;
		}
		throw new Error(`${fieldName} must be a normalized workspace-relative path: ${relativePath}`);
	}
	if (
		relativePath.includes('\0') ||
		relativePath.includes('\\') ||
		relativePath.endsWith('/') ||
		path.posix.isAbsolute(relativePath) ||
		path.posix.normalize(relativePath) !== relativePath ||
		relativePath.split('/').some((segment) => segment === '.' || segment === '..')
	) {
		throw new Error(`${fieldName} must be a normalized workspace-relative path: ${relativePath}`);
	}
}

function isEqualOrDescendant(candidatePath: string, ancestorPath: string): boolean {
	return (
		ancestorPath.length === 0 ||
		candidatePath === ancestorPath ||
		candidatePath.startsWith(`${ancestorPath}/`)
	);
}

function pathsOverlap(firstPath: string, secondPath: string): boolean {
	return isEqualOrDescendant(firstPath, secondPath) || isEqualOrDescendant(secondPath, firstPath);
}

function validatePathSet(
	paths: readonly string[],
	label: string,
	allowWorkspaceRoot = false,
): void {
	for (const relativePath of paths) {
		assertNormalizedRelativePath(relativePath, label, allowWorkspaceRoot);
	}
	const seenPaths = new Set<string>();
	for (const relativePath of paths) {
		if (seenPaths.has(relativePath)) {
			throw new Error(
				`Managed filtered workspace policy has a duplicate ${label}: ${relativePath}`,
			);
		}
		seenPaths.add(relativePath);
	}
	for (let pathIndex = 0; pathIndex < paths.length; pathIndex += 1) {
		const firstPath = paths[pathIndex];
		if (!firstPath) {
			continue;
		}
		for (let comparedIndex = pathIndex + 1; comparedIndex < paths.length; comparedIndex += 1) {
			const secondPath = paths[comparedIndex];
			if (secondPath && pathsOverlap(firstPath, secondPath)) {
				throw new Error(
					`Managed filtered workspace policy has overlapping ${label}s: ${firstPath} and ${secondPath}`,
				);
			}
		}
	}
}

function validateReadonlyInputs(
	readonlyInputs: readonly ManagedVmFilteredWorkspaceReadonlyInput[],
): void {
	for (const readonlyInput of readonlyInputs) {
		assertNormalizedRelativePath(readonlyInput.sourceRelativePath, 'Read-only input source path');
		assertNormalizedRelativePath(
			readonlyInput.destinationRelativePath,
			'Read-only input destination path',
		);
	}
	const destinationPaths = readonlyInputs.map(
		(readonlyInput) => readonlyInput.destinationRelativePath,
	);
	const seenDestinations = new Set<string>();
	for (const destinationPath of destinationPaths) {
		if (seenDestinations.has(destinationPath)) {
			throw new Error(
				`Managed filtered workspace policy has a duplicate read-only destination: ${destinationPath}`,
			);
		}
		seenDestinations.add(destinationPath);
	}
	for (let inputIndex = 0; inputIndex < destinationPaths.length; inputIndex += 1) {
		const firstDestination = destinationPaths[inputIndex];
		if (!firstDestination) {
			continue;
		}
		for (
			let comparedIndex = inputIndex + 1;
			comparedIndex < destinationPaths.length;
			comparedIndex += 1
		) {
			const secondDestination = destinationPaths[comparedIndex];
			if (secondDestination && pathsOverlap(firstDestination, secondDestination)) {
				throw new Error(
					`Managed filtered workspace policy has overlapping read-only destinations: ${firstDestination} and ${secondDestination}`,
				);
			}
		}
	}
}

function assertWithinPositiveVisibility(
	relativePath: string,
	visiblePaths: readonly string[],
	fieldName: string,
): void {
	if (!visiblePaths.some((visiblePath) => isEqualOrDescendant(relativePath, visiblePath))) {
		throw new Error(`${fieldName} '${relativePath}' is outside the positive visibility allowlist.`);
	}
}

function readonlyInputSourceIsWritable(
	readonlyInput: ManagedVmFilteredWorkspaceReadonlyInput,
	policy: ManagedVmFilteredWorkspacePolicy,
): boolean {
	const sourcePath = readonlyInput.sourceRelativePath;
	if (
		policy.hiddenPaths.some((hiddenPath) => isEqualOrDescendant(sourcePath, hiddenPath)) ||
		policy.temporaryPaths.some((temporaryPath) => isEqualOrDescendant(sourcePath, temporaryPath)) ||
		policy.readonlyInputs.some((candidateInput) =>
			isEqualOrDescendant(sourcePath, candidateInput.destinationRelativePath),
		)
	) {
		return false;
	}
	if (policy.visibility.kind === 'whole-root-writable') {
		return true;
	}
	return policy.visibility.writablePaths.some((writablePath) =>
		isEqualOrDescendant(sourcePath, writablePath),
	);
}

/**
 * Validates the complete policy before VM construction reaches a native provider.
 * Paths are rejected rather than silently normalized so one spelling has one meaning.
 */
export function validateManagedVmFilteredWorkspacePolicy(
	policy: ManagedVmFilteredWorkspacePolicy,
): ManagedVmFilteredWorkspacePolicy {
	validatePathSet(policy.hiddenPaths, 'hidden path');
	validatePathSet(policy.temporaryPaths, 'temporary path');
	validateReadonlyInputs(policy.readonlyInputs);

	if (policy.visibility.kind === 'positive-paths') {
		validatePathSet(policy.visibility.visiblePaths, 'visible path', true);
		validatePathSet(policy.visibility.writablePaths, 'writable path', true);
		if (policy.visibility.visiblePaths.length === 0) {
			throw new Error('A positive filtered workspace policy must admit at least one visible path.');
		}
		for (const writablePath of policy.visibility.writablePaths) {
			assertWithinPositiveVisibility(writablePath, policy.visibility.visiblePaths, 'Writable path');
		}
		for (const temporaryPath of policy.temporaryPaths) {
			assertWithinPositiveVisibility(
				temporaryPath,
				policy.visibility.visiblePaths,
				'Temporary path',
			);
		}
		for (const readonlyInput of policy.readonlyInputs) {
			assertWithinPositiveVisibility(
				readonlyInput.destinationRelativePath,
				policy.visibility.visiblePaths,
				'Read-only destination',
			);
		}
		for (const hiddenPath of policy.hiddenPaths) {
			if (
				!policy.visibility.visiblePaths.some((visiblePath) => pathsOverlap(hiddenPath, visiblePath))
			) {
				throw new Error(
					`Hidden path '${hiddenPath}' is outside the positive visibility allowlist.`,
				);
			}
		}
	}

	for (const readonlyInput of policy.readonlyInputs) {
		if (readonlyInputSourceIsWritable(readonlyInput, policy)) {
			throw new Error(
				`Read-only input source '${readonlyInput.sourceRelativePath}' remains writable at its original workspace path.`,
			);
		}
		for (const writablePath of policy.visibility.kind === 'positive-paths'
			? policy.visibility.writablePaths
			: []) {
			if (
				writablePath !== readonlyInput.destinationRelativePath &&
				isEqualOrDescendant(writablePath, readonlyInput.destinationRelativePath)
			) {
				throw new Error(
					`writable path '${writablePath}' has read-only ancestor '${readonlyInput.destinationRelativePath}'.`,
				);
			}
		}
	}

	return {
		hiddenPaths: [...policy.hiddenPaths],
		readonlyInputs: policy.readonlyInputs.map((readonlyInput) => ({ ...readonlyInput })),
		temporaryPaths: [...policy.temporaryPaths],
		visibility:
			policy.visibility.kind === 'whole-root-writable'
				? { kind: 'whole-root-writable' }
				: {
						kind: 'positive-paths',
						visiblePaths: [...policy.visibility.visiblePaths],
						writablePaths: [...policy.visibility.writablePaths],
					},
	};
}
