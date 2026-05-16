export const openClawShellEnvFilePath = '/etc/profile.d/openclaw-env.sh';
export const openClawRuntimeSecretsEnvFilePath = '/run/openclaw/secrets.env';

export function shellQuote(value: string): string {
	return `'${value.replace(/'/gu, `'\\''`)}'`;
}

export function wrapWithOpenClawShellEnvironment(command: string): string {
	return `bash -lc ${shellQuote(`source ${openClawShellEnvFilePath} && ${command}`)}`;
}

export function buildOpenClawSecretShellPrefix(): string {
	return `source ${openClawShellEnvFilePath} && set -a && . ${openClawRuntimeSecretsEnvFilePath} && set +a && `;
}

export function wrapWithOpenClawSecretShellEnvironment(command: string): string {
	return `bash -lc ${shellQuote(`${buildOpenClawSecretShellPrefix()}${command}`)}`;
}
