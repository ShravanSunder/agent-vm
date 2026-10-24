import type { FormattedSecretValue } from '@agent-collaboration/tool-access/contracts';

export function formatSecretValue(secret: FormattedSecretValue, rawValue: string): string {
	if (secret.format === undefined) {
		return rawValue;
	}
	switch (secret.format.kind) {
		case 'bearer':
			return `Bearer ${rawValue}`;
		case 'prefix':
			return `${secret.format.prefix} ${rawValue}`;
		default: {
			const exhaustiveFormat: never = secret.format;
			return exhaustiveFormat;
		}
	}
}
