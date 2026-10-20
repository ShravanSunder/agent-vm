import type { PortalServerLogger } from '#node-host/observability/server-log-events';

export function createNodeHostDiagnosticLogger(
	logger: PortalServerLogger,
): (event: string) => void {
	return (event) => {
		if (event === 'authentication-allowed' || event === 'authentication-denied') {
			logger.log({
				event: 'mcp_proxy_auth',
				agentId: 'configured-caller',
				clientAddress: 'direct-client',
				decision: event === 'authentication-allowed' ? 'allow' : 'deny',
				level: event === 'authentication-allowed' ? 'info' : 'warn',
				timeMs: Date.now(),
			});
			return;
		}
		if (event === 'operation-store-capacity' || event === 'operation-store-storage-failed') {
			logger.log({
				event: 'server_error',
				reason: event,
				level: 'error',
				message:
					event === 'operation-store-capacity'
						? 'Operation store capacity exhausted.'
						: 'Operation store storage failed.',
			});
			return;
		}
		if (event === 'upstream-close-failed') {
			logger.log({
				event: 'upstream_close_error',
				agentScopeId: 'configured-caller',
				level: 'warn',
				message: 'Upstream close failed.',
			});
			return;
		}
		logger.log({ event: 'server_error', level: 'error', message: 'Node host operation failed.' });
	};
}
