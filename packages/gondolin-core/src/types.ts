export interface SecretSpec {
	readonly hosts: readonly string[];
	readonly value: string;
}

export interface SecretRef {
	readonly source: '1password';
	readonly ref: string;
}
