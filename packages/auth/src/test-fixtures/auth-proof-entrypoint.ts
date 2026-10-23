import { handleAuthProofRequest } from '#auth/test-fixtures/auth-proof-application';

export { AgentClientManagement } from '#auth/test-fixtures/management-observation-holds';

// Test-only composition preserves the production named entrypoint and adds a post-signing hold control.
export default {
	async fetch(request: Request, bindings: AuthWorkerEnv): Promise<Response> {
		return handleAuthProofRequest(request, bindings);
	},
};
