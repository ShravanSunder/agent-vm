import type { AgentClientManagement } from '@agent-collaboration/auth/cloudflare';

export type PackedRegisterAndLinkInput = Parameters<AgentClientManagement['registerAndLink']>[0];
export type PackedRegisterAndLinkResult = Awaited<
	ReturnType<AgentClientManagement['registerAndLink']>
>;
export type PackedLinkInput = Parameters<AgentClientManagement['link']>[0];
export type PackedLinkResult = Awaited<ReturnType<AgentClientManagement['link']>>;
export type PackedUnlinkInput = Parameters<AgentClientManagement['unlink']>[0];
export type PackedUnlinkResult = Awaited<ReturnType<AgentClientManagement['unlink']>>;
export type PackedDisableInput = Parameters<AgentClientManagement['disable']>[0];
export type PackedDisableResult = Awaited<ReturnType<AgentClientManagement['disable']>>;
export type PackedGeneratedDatabase = AuthWorkerEnv['DB'];

// @ts-expect-error The monolithic management API was removed at the workspace cutover.
export type RemovedPackedManagementMethod = AgentClientManagement['changeClient'];

export function callPackedRegisterAndLink(
	binding: AgentClientManagement,
	input: PackedRegisterAndLinkInput,
): Promise<PackedRegisterAndLinkResult> {
	return binding.registerAndLink(input);
}

export function callPackedLink(
	binding: AgentClientManagement,
	input: PackedLinkInput,
): Promise<PackedLinkResult> {
	return binding.link(input);
}

export function callPackedUnlink(
	binding: AgentClientManagement,
	input: PackedUnlinkInput,
): Promise<PackedUnlinkResult> {
	return binding.unlink(input);
}

export function callPackedDisable(
	binding: AgentClientManagement,
	input: PackedDisableInput,
): Promise<PackedDisableResult> {
	return binding.disable(input);
}
