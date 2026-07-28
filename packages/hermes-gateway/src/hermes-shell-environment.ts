export const managedHermesShellEnvironmentPath = '/etc/profile.d/hermes-env.sh';

function shellQuote(value: string): string {
	return `'${value.replace(/'/gu, `'\\''`)}'`;
}

export function wrapWithHermesShellEnvironment(command: string): string {
	return `bash -lc ${shellQuote(`source ${managedHermesShellEnvironmentPath} && ${command}`)}`;
}
