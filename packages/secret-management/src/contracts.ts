export interface MediatedSecretSpec {
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
	  }
	| {
			readonly source: 'config';
			readonly ref?: never;
			readonly value: string;
	  };

export interface SecretResolver {
	resolve(ref: SecretRef): Promise<string>;
	resolveAll(refs: Record<string, SecretRef>): Promise<Record<string, string>>;
}
