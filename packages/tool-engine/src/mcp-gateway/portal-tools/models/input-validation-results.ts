import type { JsonValue } from '@agent-collaboration/tool-access/contracts';

export interface InputValidationIssue {
	readonly code: string;
	readonly expected?: string;
	readonly keys?: readonly string[];
	readonly message: string;
	readonly path: readonly (number | string)[];
	readonly received?: {
		readonly preview?: string;
		readonly type: string;
	};
	readonly values?: readonly JsonValue[];
}

export interface InputValidationError {
	readonly kind: 'input_validation';
	readonly issues: readonly InputValidationIssue[];
}

export interface SchemaValidationUnavailableError {
	readonly feature: string;
	readonly kind: 'schema_validation_unavailable';
	readonly message: string;
	readonly path: readonly (number | string)[];
}

export type PortalValidationResult =
	| { readonly ok: true; readonly value: unknown }
	| { readonly error: InputValidationError; readonly ok: false };

export type BuiltZodValidator =
	| {
			readonly ok: true;
			readonly validate: (value: unknown) => PortalValidationResult;
	  }
	| {
			readonly error: SchemaValidationUnavailableError;
			readonly ok: false;
	  };

export interface UnsupportedFeature {
	readonly feature: string;
	readonly path: readonly (number | string)[];
}

export type JsonStringParseResult =
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false };
