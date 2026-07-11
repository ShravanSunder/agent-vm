import type { SecretResolver } from '@agent-vm/secret-management';

import type { LoadedSystemConfig } from '../../config/system-config.js';
import type { GatewayEpochIdentity } from '../vm-ownership/vm-ownership-contracts.js';
import { type AgentSandboxSeedResult, seedAgentSandboxWorkspace } from './agent-sandbox-seeding.js';
import {
	defaultToolVmLeaseIdleTtlMs,
	resolveToolVmLeaseIdleTtlMs,
	type ToolVmLeaseIdleTtlPolicy,
} from './lease-idle-policy.js';
import type { LeaseManager } from './lease-manager.js';
import { resolveLeaseWorkMountDir } from './lease-work-mount-paths.js';
import { assertCanonicalOpenClawAgentWorkspaceDir } from './openclaw-agent-workspace-paths.js';

const defaultGatewayControlLeaseIdleTtlPolicy = {
	defaultMs: defaultToolVmLeaseIdleTtlMs,
	maxRequestedMs: 24 * 60 * 60 * 1000,
	minRequestedMs: 1_000,
} satisfies ToolVmLeaseIdleTtlPolicy;

type LeaseCreateOptions = Parameters<LeaseManager['createLease']>[0];

export interface OpenClawToolVmLeaseAuthorityContext {
	readonly agentId: string;
	readonly agentWorkspaceDir: string;
	readonly bootId: string;
	readonly connectionId: string;
	readonly controllerEpoch: string;
	readonly peerId: string;
	readonly sessionId: string;
	readonly workMountDir: string;
	readonly zoneId: string;
}

export interface ResolveOpenClawToolVmLeaseCreateOptionsInput {
	readonly authorityContext: OpenClawToolVmLeaseAuthorityContext;
	readonly expectedGateway: GatewayEpochIdentity;
	readonly requestedIdleTtlMs?: number | undefined;
}

export interface OpenClawToolVmLeaseCreateOptionsResolverOptions {
	readonly leaseIdleTtlPolicy?: ToolVmLeaseIdleTtlPolicy;
	readonly systemConfig: LoadedSystemConfig;
}

export interface OpenClawToolVmLeaseWorkspaceSeederOptions {
	readonly onSandboxSeedResult?: (result: AgentSandboxSeedResult) => void;
	readonly secretResolver: SecretResolver;
	readonly systemConfig: LoadedSystemConfig;
}

export type OpenClawToolVmLeaseCreateOptionsResolver = (
	input: ResolveOpenClawToolVmLeaseCreateOptionsInput,
) => Promise<LeaseCreateOptions>;

export type OpenClawToolVmLeaseWorkspaceSeeder = (
	leaseCreateOptions: LeaseCreateOptions,
) => Promise<void>;

export function createOpenClawToolVmLeaseWorkspaceSeeder(
	options: OpenClawToolVmLeaseWorkspaceSeederOptions,
): OpenClawToolVmLeaseWorkspaceSeeder {
	const zonesById = new Map(options.systemConfig.zones.map((zone) => [zone.id, zone]));
	return async (leaseCreateOptions): Promise<void> => {
		const zone = zonesById.get(leaseCreateOptions.zoneId);
		if (zone === undefined) {
			throw new Error(`Unknown zone '${leaseCreateOptions.zoneId}'`);
		}
		options.onSandboxSeedResult?.(
			await seedAgentSandboxWorkspace({
				agentId: leaseCreateOptions.agentId,
				hostWorkMountDir: leaseCreateOptions.hostWorkMountDir,
				secretResolver: options.secretResolver,
				zone,
			}),
		);
	};
}

export function createOpenClawToolVmLeaseCreateOptionsResolver(
	options: OpenClawToolVmLeaseCreateOptionsResolverOptions,
): OpenClawToolVmLeaseCreateOptionsResolver {
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
		if (zone.gateway.type !== 'openclaw') {
			throw new Error(
				`Zone '${authorityContext.zoneId}' does not support OpenClaw tool VM leases.`,
			);
		}
		const configuredAgentIds = new Set((zone.agents ?? []).map((agent) => agent.id));
		if (configuredAgentIds.size === 0 || !configuredAgentIds.has(authorityContext.agentId)) {
			throw new Error(
				`Zone '${authorityContext.zoneId}' does not declare OpenClaw agent '${authorityContext.agentId}'.`,
			);
		}
		assertCanonicalOpenClawAgentWorkspaceDir({
			agentId: authorityContext.agentId,
			agentWorkspaceDir: authorityContext.agentWorkspaceDir,
			context: `OpenClaw tool VM lease for zone '${authorityContext.zoneId}'`,
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
		const resolvedWorkMount = await resolveLeaseWorkMountDir({
			agentId: authorityContext.agentId,
			runtimeDir: options.systemConfig.runtimeDir,
			workMountDir: authorityContext.workMountDir,
			zone,
		});
		const effectiveIdleTtl = resolveToolVmLeaseIdleTtlMs({
			policy: leaseIdleTtlPolicy,
			requestedIdleTtlMs,
		});
		if (effectiveIdleTtl.kind === 'invalid') {
			throw new Error(effectiveIdleTtl.message);
		}
		return {
			agentId: authorityContext.agentId,
			agentWorkspaceDir: authorityContext.agentWorkspaceDir,
			gatewayWorkMountDir: authorityContext.workMountDir,
			effectiveIdleTtlMs: effectiveIdleTtl.value,
			expectedGateway,
			guestWorkdir: resolvedWorkMount.guestWorkdir,
			hostWorkMountDir: resolvedWorkMount.hostWorkMountDir,
			profile,
			profileId: resolvedProfileId,
			...(resolvedWorkMount.zoneGitMount ? { zoneGitMount: resolvedWorkMount.zoneGitMount } : {}),
			zoneId: authorityContext.zoneId,
		};
	};
}
