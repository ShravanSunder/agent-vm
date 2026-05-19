import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';

import type { SecretRef, SecretResolver } from '@agent-vm/secrets';

import type { SystemConfig } from '../../config/system-config.js';
import { parseAgentScopeKey } from './lease-scope.js';

type ZoneConfig = SystemConfig['zones'][number];
type AgentSandboxSeed = NonNullable<ZoneConfig['agentSandboxSeeds']>[string][number];

export type SandboxSeedingErrorKind =
	| 'parent-not-directory'
	| 'parent-resolves-outside-work-mount'
	| 'parent-symlink'
	| 'target-outside-work-mount';

export class SandboxSeedingError extends Error {
	readonly kind: SandboxSeedingErrorKind;

	constructor(kind: SandboxSeedingErrorKind, message: string) {
		super(message);
		this.kind = kind;
	}
}

export type AgentSandboxSeedResult =
	| {
			readonly kind: 'not-openclaw-zone';
			readonly zoneId: string;
	  }
	| {
			readonly kind: 'non-agent-scope';
			readonly scopeKey: string;
			readonly zoneId: string;
	  }
	| {
			readonly kind: 'malformed-agent-scope';
			readonly reason: string;
			readonly scopeKey: string;
			readonly zoneId: string;
	  }
	| {
			readonly agentId: string;
			readonly kind: 'no-seeds-configured';
			readonly scopeKey: string;
			readonly zoneId: string;
	  }
	| {
			readonly agentId: string;
			readonly kind: 'sandbox-root-missing';
			readonly sandboxRoot: string;
			readonly scopeKey: string;
			readonly zoneId: string;
	  }
	| {
			readonly agentId: string;
			readonly kind: 'work-mount-missing';
			readonly scopeKey: string;
			readonly hostWorkMountDir: string;
			readonly zoneId: string;
	  }
	| {
			readonly agentId: string;
			readonly kind: 'work-mount-outside-sandbox';
			readonly sandboxRoot: string;
			readonly scopeKey: string;
			readonly hostWorkMountDir: string;
			readonly zoneId: string;
	  }
	| {
			readonly agentId: string;
			readonly alreadyExisted: number;
			readonly hostWorkMountDir: string;
			readonly kind: 'seeded';
			readonly scopeKey: string;
			readonly written: number;
			readonly zoneId: string;
	  };

function isNodeErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && 'code' in error && error.code === code;
}

function isPathWithin(candidatePath: string, rootPath: string): boolean {
	const relativePath = path.relative(rootPath, candidatePath);
	return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function toSecretRef(seed: AgentSandboxSeed): SecretRef {
	return seed.source.source === 'environment'
		? {
				source: 'environment',
				ref: seed.source.envVar,
			}
		: {
				source: '1password',
				ref: seed.source.ref,
			};
}

async function writeSeedFileIfAbsent(options: {
	readonly content: string;
	readonly mode: number;
	readonly targetPath: string;
	readonly hostWorkMountDir: string;
}): Promise<'already-existed' | 'written'> {
	let fileHandle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		const targetParentPath = await ensureSeedParentDirectoryInsideWorkspace({
			targetPath: options.targetPath,
			hostWorkMountDir: options.hostWorkMountDir,
		});
		const safeTargetPath = path.join(targetParentPath, path.basename(options.targetPath));
		fileHandle = await open(safeTargetPath, 'wx', options.mode);
		await fileHandle.chmod(options.mode);
		await fileHandle.writeFile(options.content, 'utf8');
		await fileHandle.close();
		fileHandle = undefined;
		return 'written';
	} catch (error) {
		if (fileHandle) {
			await fileHandle.close();
		}
		if (isNodeErrorCode(error, 'EEXIST')) {
			return 'already-existed';
		}
		throw error;
	}
}

async function ensureSeedParentDirectoryInsideWorkspace(options: {
	readonly targetPath: string;
	readonly hostWorkMountDir: string;
}): Promise<string> {
	const targetParentPath = path.dirname(options.targetPath);
	const relativeParentPath = path.relative(options.hostWorkMountDir, targetParentPath);
	if (
		relativeParentPath !== '' &&
		(relativeParentPath.startsWith('..') || path.isAbsolute(relativeParentPath))
	) {
		throw new SandboxSeedingError(
			'parent-resolves-outside-work-mount',
			`Agent sandbox seed target parent '${targetParentPath}' resolves outside work mount '${options.hostWorkMountDir}'.`,
		);
	}

	let currentPath = options.hostWorkMountDir;
	/* oxlint-disable no-await-in-loop -- each path segment must be validated before the next segment can be trusted */
	for (const segment of relativeParentPath.split(path.sep).filter((part) => part.length > 0)) {
		currentPath = path.join(currentPath, segment);
		let entry = await lstat(currentPath).catch((error: unknown) => {
			if (isNodeErrorCode(error, 'ENOENT')) {
				return null;
			}
			throw error;
		});
		if (!entry) {
			await mkdir(currentPath, { mode: 0o700 });
			entry = await lstat(currentPath);
		}
		if (entry.isSymbolicLink()) {
			throw new SandboxSeedingError(
				'parent-symlink',
				`Agent sandbox seed parent '${currentPath}' must not be a symlink.`,
			);
		}
		if (!entry.isDirectory()) {
			throw new SandboxSeedingError(
				'parent-not-directory',
				`Agent sandbox seed parent '${currentPath}' is not a directory.`,
			);
		}
		const resolvedPath = await realpath(currentPath);
		if (!isPathWithin(resolvedPath, options.hostWorkMountDir)) {
			throw new SandboxSeedingError(
				'parent-resolves-outside-work-mount',
				`Agent sandbox seed parent '${currentPath}' resolves outside work mount '${options.hostWorkMountDir}'.`,
			);
		}
		currentPath = resolvedPath;
	}
	/* oxlint-enable no-await-in-loop */

	return currentPath;
}

export async function seedAgentSandboxWorkspace(options: {
	readonly scopeKey: string;
	readonly secretResolver: SecretResolver;
	readonly hostWorkMountDir: string;
	readonly zone: ZoneConfig;
}): Promise<AgentSandboxSeedResult> {
	if (options.zone.gateway.type !== 'openclaw') {
		return { kind: 'not-openclaw-zone', zoneId: options.zone.id };
	}
	const parsedScope = parseAgentScopeKey(options.scopeKey);
	if (parsedScope.kind === 'non-agent-scope') {
		return { kind: 'non-agent-scope', scopeKey: options.scopeKey, zoneId: options.zone.id };
	}
	if (parsedScope.kind === 'malformed-agent-scope') {
		return {
			kind: 'malformed-agent-scope',
			reason: parsedScope.reason,
			scopeKey: options.scopeKey,
			zoneId: options.zone.id,
		};
	}
	const agentId = parsedScope.agentId;
	const seeds = options.zone.agentSandboxSeeds?.[agentId] ?? [];
	if (seeds.length === 0) {
		return {
			agentId,
			kind: 'no-seeds-configured',
			scopeKey: options.scopeKey,
			zoneId: options.zone.id,
		};
	}
	const sandboxRootPath = path.join(options.zone.gateway.stateDir, 'sandboxes');
	let sandboxRoot: string;
	try {
		sandboxRoot = await realpath(sandboxRootPath);
	} catch (error) {
		if (isNodeErrorCode(error, 'ENOENT')) {
			return {
				agentId,
				kind: 'sandbox-root-missing',
				sandboxRoot: sandboxRootPath,
				scopeKey: options.scopeKey,
				zoneId: options.zone.id,
			};
		}
		throw error;
	}
	let hostWorkMountDir: string;
	try {
		hostWorkMountDir = await realpath(options.hostWorkMountDir);
	} catch (error) {
		if (isNodeErrorCode(error, 'ENOENT')) {
			return {
				agentId,
				kind: 'work-mount-missing',
				scopeKey: options.scopeKey,
				hostWorkMountDir: options.hostWorkMountDir,
				zoneId: options.zone.id,
			};
		}
		throw error;
	}
	if (!isPathWithin(hostWorkMountDir, sandboxRoot)) {
		return {
			agentId,
			kind: 'work-mount-outside-sandbox',
			sandboxRoot,
			scopeKey: options.scopeKey,
			hostWorkMountDir,
			zoneId: options.zone.id,
		};
	}

	const seedResults = await Promise.all(
		seeds.map(async (seed) => {
			const targetPath = path.resolve(hostWorkMountDir, seed.target);
			if (!isPathWithin(targetPath, hostWorkMountDir)) {
				throw new SandboxSeedingError(
					'target-outside-work-mount',
					`Agent sandbox seed target '${seed.target}' resolves outside work mount '${hostWorkMountDir}'.`,
				);
			}
			await ensureSeedParentDirectoryInsideWorkspace({
				targetPath,
				hostWorkMountDir,
			});
			const content = await options.secretResolver.resolve(toSecretRef(seed));
			return await writeSeedFileIfAbsent({
				content,
				mode: seed.mode,
				targetPath,
				hostWorkMountDir,
			});
		}),
	);
	return {
		agentId,
		alreadyExisted: seedResults.filter((result) => result === 'already-existed').length,
		hostWorkMountDir,
		kind: 'seeded',
		scopeKey: options.scopeKey,
		written: seedResults.filter((result) => result === 'written').length,
		zoneId: options.zone.id,
	};
}
