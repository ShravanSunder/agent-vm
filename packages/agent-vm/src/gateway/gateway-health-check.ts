import type { GatewayHealthCheck } from '@agent-vm/gateway-interface';

export interface GatewayHealthProbeResult {
	readonly exitCode: number;
	readonly observation: string;
	readonly ok: boolean;
	readonly stderr: string;
	readonly stdout: string;
}

export type GatewayHealthCheckExecutor = (command: string) => Promise<{
	readonly exitCode: number;
	readonly stderr: string;
	readonly stdout: string;
}>;

export function buildGatewayHealthCommand(healthCheck: GatewayHealthCheck): string {
	return healthCheck.type === 'http'
		? `curl -sS -o /dev/null -w "%{http_code}" --max-time 2 http://127.0.0.1:${healthCheck.port}${healthCheck.path} 2>/dev/null || true`
		: healthCheck.command;
}

export async function runGatewayHealthCheck(options: {
	readonly exec: GatewayHealthCheckExecutor;
	readonly healthCheck: GatewayHealthCheck;
}): Promise<GatewayHealthProbeResult> {
	const result = await options.exec(buildGatewayHealthCommand(options.healthCheck));
	const stdout = result.stdout.trim();
	const observation =
		options.healthCheck.type === 'http' ? `http ${stdout || '(empty)'}` : `exit ${result.exitCode}`;
	const ok = options.healthCheck.type === 'http' ? stdout.startsWith('2') : result.exitCode === 0;

	return {
		exitCode: result.exitCode,
		observation,
		ok,
		stderr: result.stderr,
		stdout: result.stdout,
	};
}
