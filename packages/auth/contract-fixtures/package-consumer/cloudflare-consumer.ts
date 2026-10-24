import type { AgentClientManagement } from '@agent-collaboration/auth/cloudflare';

export type PackedManagementInput = Parameters<AgentClientManagement['changeClient']>[0];
export type PackedManagementResult = Awaited<ReturnType<AgentClientManagement['changeClient']>>;
export type PackedGeneratedDatabase = AuthWorkerEnv['DB'];

export function callPackedManagement(
	binding: AgentClientManagement,
	input: PackedManagementInput,
): Promise<PackedManagementResult> {
	return binding.changeClient(input);
}
