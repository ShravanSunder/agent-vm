import type { VfsMountSpec } from '@agent-vm/gondolin-adapter';

import type {
	ExternalResources,
	ResolvedRepoResourcesFinal,
} from '../config/resource-contracts/index.js';
import { RESERVED_RESOURCE_ENV_KEYS } from '../config/resource-contracts/index.js';

export interface RepoResourceFinalization {
	readonly final: ResolvedRepoResourcesFinal;
	readonly outputDir: string;
	readonly repoId: string;
}

export interface ResourceOverlay {
	readonly environment: Record<string, string>;
	readonly tcpHosts: Record<string, string>;
	readonly vfsMounts: Record<string, VfsMountSpec>;
}

export interface CompileResourceOverlayOptions {
	readonly externalResources: ExternalResources;
	readonly repoFinalizations: readonly RepoResourceFinalization[];
}

function toTcpHostKey(resource: {
	readonly binding: { readonly host: string; readonly port: number };
}): string {
	return `${resource.binding.host}:${resource.binding.port}`;
}

function toTcpHostTarget(resource: {
	readonly target: { readonly host: string; readonly port: number };
}): string {
	return `${resource.target.host}:${resource.target.port}`;
}

function assignResourceEnvironment(
	environment: Record<string, string>,
	resourceEnv: Record<string, string>,
): void {
	for (const [key, value] of Object.entries(resourceEnv)) {
		if (RESERVED_RESOURCE_ENV_KEYS.has(key)) {
			throw new Error(`Resource env contains reserved environment key '${key}'.`);
		}
		const existingValue = environment[key];
		if (existingValue !== undefined && existingValue !== value) {
			throw new Error(`Resource env contains conflicting environment key '${key}'.`);
		}
		environment[key] = value;
	}
}

function assignTcpHost(tcpHosts: Record<string, string>, key: string, target: string): void {
	const existingTarget = tcpHosts[key];
	if (existingTarget !== undefined && existingTarget !== target) {
		throw new Error(`Resource overlay contains conflicting TCP binding '${key}'.`);
	}
	tcpHosts[key] = target;
}

export function compileResourceOverlay(options: CompileResourceOverlayOptions): ResourceOverlay {
	const tcpHosts: Record<string, string> = {};
	const environment: Record<string, string> = {};
	const vfsMounts: Record<string, VfsMountSpec> = {};

	for (const resource of Object.values(options.externalResources)) {
		assignTcpHost(tcpHosts, toTcpHostKey(resource), toTcpHostTarget(resource));
		assignResourceEnvironment(environment, resource.env);
	}

	for (const finalization of options.repoFinalizations) {
		vfsMounts[`/agent-vm/resources/${finalization.repoId}`] = {
			hostPath: finalization.outputDir,
			kind: 'realfs-readonly',
		};
		for (const resource of Object.values(finalization.final.resources)) {
			assignTcpHost(tcpHosts, toTcpHostKey(resource), toTcpHostTarget(resource));
			assignResourceEnvironment(environment, resource.env);
		}
	}

	return {
		environment,
		tcpHosts,
		vfsMounts,
	};
}
