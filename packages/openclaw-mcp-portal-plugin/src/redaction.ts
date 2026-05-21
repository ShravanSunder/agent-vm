import { redactCredentialText } from '@agent-vm/mcp-portal/core';

export function redactPortalSecrets(text: string, secretValues: readonly string[] = []): string {
	return secretValues
		.filter((secretValue) => secretValue.length > 0)
		.reduce(
			(current, secretValue) => current.split(secretValue).join('[REDACTED]'),
			redactCredentialText(text),
		);
}
