export interface SecretSpec {
	readonly hosts: readonly string[];
	readonly value: string;
}

export type SecretRef =
	| {
			readonly source: '1password';
			readonly ref: string;
	  }
	| {
			readonly source: 'environment';
			readonly ref: string;
	  };
