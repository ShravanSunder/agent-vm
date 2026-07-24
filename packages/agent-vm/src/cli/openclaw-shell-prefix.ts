export const openClawShellEnvFilePath = '/etc/profile.d/openclaw-env.sh';
export const openClawRuntimeSecretsEnvFilePath =
	'/run/agent-vm/managed-gateway-environment/openclaw-all-secrets.environment.sh';
export const openClawGatewayTokenEnvFilePath =
	'/run/agent-vm/managed-gateway-environment/openclaw-gateway-token.environment.sh';

export function shellQuote(value: string): string {
	return `'${value.replace(/'/gu, `'\\''`)}'`;
}

export function wrapWithOpenClawShellEnvironment(command: string): string {
	return `bash -lc ${shellQuote(`source ${openClawShellEnvFilePath} && ${command}`)}`;
}

export function buildOpenClawGatewayTokenShellPrefix(): string {
	return `source ${openClawShellEnvFilePath} && set -a && . ${openClawGatewayTokenEnvFilePath} && set +a && `;
}

export function buildOpenClawAllSecretsShellPrefix(): string {
	return `set -a && . ${openClawRuntimeSecretsEnvFilePath} && set +a && source ${openClawShellEnvFilePath} && `;
}

export function wrapWithOpenClawGatewayTokenShellEnvironment(command: string): string {
	return `bash -lc ${shellQuote(`${buildOpenClawGatewayTokenShellPrefix()}${command}`)}`;
}

export function wrapWithOpenClawAllSecretsShellEnvironment(command: string): string {
	return `bash -lc ${shellQuote(`${buildOpenClawAllSecretsShellPrefix()}${command}`)}`;
}
