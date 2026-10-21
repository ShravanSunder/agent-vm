import { type FormattedSecretValue } from '#node-host/host-configuration/models/secret-value';

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
