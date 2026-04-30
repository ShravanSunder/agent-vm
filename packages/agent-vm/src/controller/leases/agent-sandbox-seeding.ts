import { mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';

import type { SecretRef, SecretResolver } from '@agent-vm/gondolin-adapter';

import type { SystemConfig } from '../../config/system-config.js';
import { parseAgentScopeKey } from './lease-scope.js';

type ZoneConfig = SystemConfig['zones'][number];
type AgentSandboxSeed = NonNullable<ZoneConfig['agentSandboxSeeds']>[string][number];

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
			readonly kind: 'workspace-missing';
			readonly scopeKey: string;
			readonly workspaceDir: string;
			readonly zoneId: string;
	  }
	| {
			readonly agentId: string;
			readonly kind: 'workspace-outside-sandbox';
			readonly sandboxRoot: string;
			readonly scopeKey: string;
			readonly workspaceDir: string;
			readonly zoneId: string;
	  }
	| {
			readonly agentId: string;
			readonly alreadyExisted: number;
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
}): Promise<'already-existed' | 'written'> {
	await mkdir(path.dirname(options.targetPath), { recursive: true, mode: 0o700 });
	let fileHandle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		fileHandle = await open(options.targetPath, 'wx', options.mode);
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

export async function seedAgentSandboxWorkspace(options: {
	readonly scopeKey: string;
	readonly secretResolver: SecretResolver;
	readonly workspaceDir: string;
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
	let workspaceDir: string;
	try {
		workspaceDir = await realpath(options.workspaceDir);
	} catch (error) {
		if (isNodeErrorCode(error, 'ENOENT')) {
			return {
				agentId,
				kind: 'workspace-missing',
				scopeKey: options.scopeKey,
				workspaceDir: options.workspaceDir,
				zoneId: options.zone.id,
			};
		}
		throw error;
	}
	if (!isPathWithin(workspaceDir, sandboxRoot)) {
		return {
			agentId,
			kind: 'workspace-outside-sandbox',
			sandboxRoot,
			scopeKey: options.scopeKey,
			workspaceDir,
			zoneId: options.zone.id,
		};
	}

	const seedResults = await Promise.all(
		seeds.map(async (seed) => {
			const targetPath = path.resolve(workspaceDir, seed.target);
			if (!isPathWithin(targetPath, workspaceDir)) {
				throw new Error(
					`Agent sandbox seed target '${seed.target}' resolves outside workspace '${workspaceDir}'.`,
				);
			}
			const content = await options.secretResolver.resolve(toSecretRef(seed));
			return await writeSeedFileIfAbsent({
				content,
				mode: seed.mode,
				targetPath,
			});
		}),
	);
	return {
		agentId,
		alreadyExisted: seedResults.filter((result) => result === 'already-existed').length,
		kind: 'seeded',
		scopeKey: options.scopeKey,
		written: seedResults.filter((result) => result === 'written').length,
		zoneId: options.zone.id,
	};
}
