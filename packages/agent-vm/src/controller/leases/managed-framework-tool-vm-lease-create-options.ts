import { realpath } from 'node:fs/promises';

import type { GatewayRuntimeTrustedInvocationPrincipal } from '@agent-vm/gateway-control-contracts';

import type { LoadedSystemConfig } from '../../config/system-config.js';
import {
	resolveManagedAgentGitDirectoryRoot,
	resolveManagedAgentRootPaths,
} from '../../gateway/managed-agent-root-storage.js';
import type { GatewayEpochIdentity } from '../vm-ownership/vm-ownership-contracts.js';
import {
	defaultToolVmLeaseIdleTtlMs,
	resolveToolVmLeaseIdleTtlMs,
	type ToolVmLeaseIdleTtlPolicy,
} from './lease-idle-policy.js';
import type { LeaseManager } from './lease-manager.js';

const defaultGatewayControlLeaseIdleTtlPolicy = {
	defaultMs: defaultToolVmLeaseIdleTtlMs,
	maxRequestedMs: 24 * 60 * 60 * 1000,
	minRequestedMs: 1_000,
} satisfies ToolVmLeaseIdleTtlPolicy;

type LeaseCreateOptions = Parameters<LeaseManager['createLease']>[0];

export interface ManagedFrameworkToolVmLeaseAuthorityContext {
	readonly agentId: string;
	readonly bootId: string;
	readonly connectionId: string;
	readonly controllerEpoch: string;
	readonly peerId: string;
	readonly principal: GatewayRuntimeTrustedInvocationPrincipal;
	readonly sessionId: string;
	readonly zoneId: string;
}

export interface ResolveManagedFrameworkToolVmLeaseCreateOptionsInput {
	readonly authorityContext: ManagedFrameworkToolVmLeaseAuthorityContext;
	readonly expectedGateway: GatewayEpochIdentity;
	readonly requestedIdleTtlMs?: number | undefined;
}

export interface ManagedFrameworkToolVmLeaseCreateOptionsResolverOptions {
	readonly leaseIdleTtlPolicy?: ToolVmLeaseIdleTtlPolicy;
	readonly systemConfig: LoadedSystemConfig;
}

export type ManagedFrameworkToolVmLeaseCreateOptionsResolver = (
	input: ResolveManagedFrameworkToolVmLeaseCreateOptionsInput,
) => Promise<LeaseCreateOptions>;

export function createManagedFrameworkToolVmLeaseCreateOptionsResolver(
	options: ManagedFrameworkToolVmLeaseCreateOptionsResolverOptions,
): ManagedFrameworkToolVmLeaseCreateOptionsResolver {
	const zonesById = new Map(options.systemConfig.zones.map((zone) => [zone.id, zone]));
	const leaseIdleTtlPolicy =
		options.leaseIdleTtlPolicy ??
		options.systemConfig.leaseIdleTtl ??
		defaultGatewayControlLeaseIdleTtlPolicy;
	return async ({ authorityContext, expectedGateway, requestedIdleTtlMs }) => {
		const zone = zonesById.get(authorityContext.zoneId);
		if (!zone) {
			throw new Error(`Unknown zone '${authorityContext.zoneId}'`);
		}
		if (zone.gateway.type === 'worker') {
			throw new Error(
				`Zone '${authorityContext.zoneId}' does not support managed framework Tool VM leases.`,
			);
		}
		const configuredAgent = (zone.agents ?? []).find(
			(agent) => agent.id === authorityContext.agentId,
		);
		if (configuredAgent === undefined) {
			throw new Error(
				`Zone '${authorityContext.zoneId}' does not declare managed agent '${authorityContext.agentId}'.`,
			);
		}
		const rootPaths = resolveManagedAgentRootPaths({
			agentId: authorityContext.agentId,
			zoneFilesDir: zone.gateway.zoneFilesDir,
		});
		const resolvedProfileId =
			zone.agentToolVmProfiles?.[authorityContext.agentId] ?? zone.defaultToolVmProfile;
		if (!resolvedProfileId) {
			throw new Error(
				`Zone '${authorityContext.zoneId}' does not have a tool VM profile configured`,
			);
		}
		const profile = options.systemConfig.toolVmProfiles[resolvedProfileId];
		if (!profile) {
			throw new Error(`Unknown tool VM profile '${resolvedProfileId}'`);
		}
		const [hostGitDirectoryRoot, hostWorkspaceRoot] = await Promise.all([
			configuredAgent.workspaceGit === undefined
				? undefined
				: realpath(
						resolveManagedAgentGitDirectoryRoot({
							agentId: authorityContext.agentId,
							runtimeDir: options.systemConfig.runtimeDir,
							zoneId: authorityContext.zoneId,
						}),
					),
			realpath(rootPaths.hostWorkspaceRoot),
		]);
		const effectiveIdleTtl = resolveToolVmLeaseIdleTtlMs({
			policy: leaseIdleTtlPolicy,
			requestedIdleTtlMs,
		});
		if (effectiveIdleTtl.kind === 'invalid') {
			throw new Error(effectiveIdleTtl.message);
		}
		return {
			agentId: authorityContext.agentId,
			effectiveIdleTtlMs: effectiveIdleTtl.value,
			expectedGateway,
			guestWorkdir: '/work',
			...(hostGitDirectoryRoot === undefined ? {} : { hostGitDirectoryRoot }),
			hostWorkspaceRoot,
			profile,
			profileId: resolvedProfileId,
			principal: authorityContext.principal,
			zoneId: authorityContext.zoneId,
		};
	};
}
