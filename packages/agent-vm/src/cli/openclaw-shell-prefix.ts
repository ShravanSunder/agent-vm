export const openClawShellEnvFilePath = '/etc/profile.d/openclaw-env.sh';
export const openClawRuntimeSecretsEnvFilePath = '/run/openclaw/secrets.env';
export const openClawGatewayTokenEnvFilePath = '/run/openclaw/gateway-token.env';

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
	return `source ${openClawShellEnvFilePath} && set -a && . ${openClawRuntimeSecretsEnvFilePath} && set +a && `;
}

export function wrapWithOpenClawGatewayTokenShellEnvironment(command: string): string {
	return `bash -lc ${shellQuote(`${buildOpenClawGatewayTokenShellPrefix()}${command}`)}`;
}

export function wrapWithOpenClawAllSecretsShellEnvironment(command: string): string {
	return `bash -lc ${shellQuote(`${buildOpenClawAllSecretsShellPrefix()}${command}`)}`;
}
