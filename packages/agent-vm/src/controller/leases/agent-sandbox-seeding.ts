import { mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';

import type { SecretRef, SecretResolver } from '@agent-vm/gondolin-adapter';

import type { SystemConfig } from '../../config/system-config.js';
import { parseAgentIdFromScopeKey } from './lease-scope.js';

type ZoneConfig = SystemConfig['zones'][number];
type AgentSandboxSeed = NonNullable<ZoneConfig['agentSandboxSeeds']>[string][number];

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
}): Promise<void> {
	await mkdir(path.dirname(options.targetPath), { recursive: true, mode: 0o700 });
	let fileHandle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		fileHandle = await open(options.targetPath, 'wx', options.mode);
		await fileHandle.chmod(options.mode);
		await fileHandle.writeFile(options.content, 'utf8');
		await fileHandle.close();
		fileHandle = undefined;
	} catch (error) {
		if (fileHandle) {
			await fileHandle.close();
		}
		if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
			return;
		}
		throw error;
	}
}

export async function seedAgentSandboxWorkspace(options: {
	readonly scopeKey: string;
	readonly secretResolver: SecretResolver;
	readonly workspaceDir: string;
	readonly zone: ZoneConfig;
}): Promise<void> {
	if (options.zone.gateway.type !== 'openclaw') {
		return;
	}
	const agentId = parseAgentIdFromScopeKey(options.scopeKey);
	if (!agentId) {
		return;
	}
	const seeds = options.zone.agentSandboxSeeds?.[agentId] ?? [];
	if (seeds.length === 0) {
		return;
	}
	let sandboxRoot: string;
	try {
		sandboxRoot = await realpath(path.join(options.zone.gateway.stateDir, 'sandboxes'));
	} catch (error) {
		if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
			return;
		}
		throw error;
	}
	const workspaceDir = await realpath(options.workspaceDir);
	if (!isPathWithin(workspaceDir, sandboxRoot)) {
		return;
	}

	await Promise.all(
		seeds.map(async (seed) => {
			const targetPath = path.resolve(workspaceDir, seed.target);
			if (!isPathWithin(targetPath, workspaceDir)) {
				throw new Error(
					`Agent sandbox seed target '${seed.target}' resolves outside workspace '${workspaceDir}'.`,
				);
			}
			const content = await options.secretResolver.resolve(toSecretRef(seed));
			await writeSeedFileIfAbsent({
				content,
				mode: seed.mode,
				targetPath,
			});
		}),
	);
}
