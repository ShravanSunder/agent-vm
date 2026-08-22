export type PortableRefinementKind =
	| 'canonical-normalization'
	| 'cross-field-validation'
	| 'default'
	| 'structural-validation';

export type PortableRefinementOperation =
	| {
			readonly kind: 'aggregate-status';
			readonly itemsField: string;
			readonly okField: string;
	  }
	| { readonly kind: 'decoded-base64-byte-length' }
	| {
			readonly collectionPaths: readonly string[];
			readonly fieldName: string;
			readonly kind: 'unique-field';
	  }
	| {
			readonly kind: 'default-values';
			readonly values: Readonly<Record<string, boolean | number | string>>;
	  }
	| {
			readonly kind: 'canonical-json';
			readonly maximumArrayItems: number;
			readonly maximumObjectEntries: number;
			readonly maximumObjectKeyCharacters: number;
			readonly maximumStringCharacters: number;
	  }
	| {
			readonly kind: 'maximum-object-entries';
			readonly maximum: number;
	  }
	| {
			readonly fieldNames: readonly string[];
			readonly kind: 'maximum-utf8-bytes';
			readonly maximum: number;
	  }
	| {
			readonly fieldNames: readonly string[];
			readonly kind: 'reject-reserved-values';
			readonly values: readonly string[];
	  }
	| {
			readonly kind: 'safe-integer';
			readonly maximum: number;
			readonly minimum: number;
	  }
	| {
			readonly fieldName: string;
			readonly kind: 'sorted-unique-object-field-items';
			readonly path: string;
	  }
	| { readonly kind: 'sorted-unique-string-items'; readonly path: string }
	| { readonly kind: 'terminal-outcome-algebra' }
	| { readonly kind: 'unique-string-items'; readonly path: string }
	| { readonly fieldNames: readonly string[]; readonly kind: 'work-relative-path' };

export interface PortableRefinementDescriptor {
	readonly description: string;
	readonly errorCode?: string;
	readonly identity: string;
	readonly kind: PortableRefinementKind;
	readonly operation: PortableRefinementOperation;
}

export const PORTABLE_REFINEMENT_DESCRIPTORS = [
	{
		description: 'Artifact reads default omitted truncation state to false.',
		identity: 'portal.artifact-read.default-truncated',
		kind: 'default',
		operation: { kind: 'default-values', values: { '/truncated': false } },
	},
	{
		description: 'Every item id in one portal batch must be unique.',
		errorCode: 'portal.batch.unique-item-ids',
		identity: 'portal.batch.unique-item-ids',
		kind: 'cross-field-validation',
		operation: { collectionPaths: ['calls', 'requests'], fieldName: 'id', kind: 'unique-field' },
	},
	{
		description: 'Describe requests apply the portable inclusion defaults.',
		identity: 'portal.describe.default-includes',
		kind: 'default',
		operation: {
			kind: 'default-values',
			values: {
				'/requests/*/includeJsonSchema': true,
				'/requests/*/includeRelated': true,
				'/requests/*/includeTypescriptHelper': false,
				'/requests/*/includeZod': false,
			},
		},
	},
	{
		description: 'JSON values use sorted object keys and normalize negative zero.',
		identity: 'portal.json.canonical',
		kind: 'canonical-normalization',
		operation: {
			kind: 'canonical-json',
			maximumArrayItems: 1_000,
			maximumObjectEntries: 1_000,
			maximumObjectKeyCharacters: 256,
			maximumStringCharacters: 64 * 1_024,
		},
	},
	{
		description: 'JSON objects cannot contain more than one thousand entries.',
		errorCode: 'portable.object.above-maximum',
		identity: 'portal.json.max-object-entries',
		kind: 'structural-validation',
		operation: { kind: 'maximum-object-entries', maximum: 1_000 },
	},
	{
		description: 'List requests default omitted limits to twenty items.',
		identity: 'portal.list.default-limit',
		kind: 'default',
		operation: { kind: 'default-values', values: { '/requests/*/limit': 20 } },
	},
	{
		description: 'Portable integer values remain inside the interoperable safe-integer range.',
		errorCode: 'portable.number.unsafe-integer',
		identity: 'portal.number.safe-integer',
		kind: 'structural-validation',
		operation: {
			kind: 'safe-integer',
			maximum: Number.MAX_SAFE_INTEGER,
			minimum: Number.MIN_SAFE_INTEGER,
		},
	},
	{
		description: 'Portal request ids cannot use reserved object property names.',
		errorCode: 'portal.request-id.not-reserved',
		identity: 'portal.request-id.not-reserved',
		kind: 'structural-validation',
		operation: {
			fieldNames: ['id', 'requestId'],
			kind: 'reject-reserved-values',
			values: ['__proto__', 'constructor', 'prototype'],
		},
	},
	{
		description: 'Aggregate success must equal the success of every result item.',
		errorCode: 'portal.result.aggregate-status',
		identity: 'portal.result.aggregate-status',
		kind: 'cross-field-validation',
		operation: { itemsField: 'items', kind: 'aggregate-status', okField: 'ok' },
	},
	{
		description: 'Call results use the normative terminal outcome algebra.',
		errorCode: 'portal.result.outcome-algebra',
		identity: 'portal.result.outcome-algebra',
		kind: 'structural-validation',
		operation: { kind: 'terminal-outcome-algebra' },
	},
	{
		description: 'Search requests default omitted limits to ten items.',
		identity: 'portal.search.default-limit',
		kind: 'default',
		operation: { kind: 'default-values', values: { '/requests/*/limit': 10 } },
	},
	{
		description: 'Search requests default omitted schema detail to summary.',
		identity: 'portal.search.default-schema-detail',
		kind: 'default',
		operation: {
			kind: 'default-values',
			values: { '/requests/*/schemaDetail': 'summary' },
		},
	},
	{
		description: 'Gateway approval argument previews remain inside the portable UTF-8 byte bound.',
		errorCode: 'gateway.approval.arguments-preview.above-maximum',
		identity: 'gateway.approval.arguments-preview.utf8-bytes',
		kind: 'structural-validation',
		operation: { fieldNames: ['argumentsPreview'], kind: 'maximum-utf8-bytes', maximum: 4_096 },
	},
	{
		description: 'Gateway attachment metadata cannot repeat an admitted agent identity.',
		errorCode: 'gateway.attachment.duplicate-agent-id',
		identity: 'gateway.attachment.unique-agent-ids',
		kind: 'cross-field-validation',
		operation: { kind: 'unique-string-items', path: 'configuredAgentIds' },
	},
	{
		description: 'Managed Agent Projection namespaces must be sorted and unique by namespace.',
		errorCode: 'gateway.managed-agent-projection.namespaces',
		identity: 'gateway.managed-agent-projection.namespaces',
		kind: 'cross-field-validation',
		operation: {
			fieldName: 'namespace',
			kind: 'sorted-unique-object-field-items',
			path: 'toolPortalNamespaces',
		},
	},
	{
		description: 'Binary chunk byte length equals the decoded canonical base64 payload length.',
		errorCode: 'sandbox.binary-chunk.byte-length-mismatch',
		identity: 'sandbox.binary-chunk.byte-length',
		kind: 'cross-field-validation',
		operation: { kind: 'decoded-base64-byte-length' },
	},
	{
		description: 'Direct Sandbox environment variable names must be unique.',
		errorCode: 'sandbox.environment-variable.duplicate-name',
		identity: 'sandbox.environment-variable.unique-names',
		kind: 'cross-field-validation',
		operation: {
			collectionPaths: ['environmentVariables'],
			fieldName: 'name',
			kind: 'unique-field',
		},
	},
	{
		description: 'Sandbox paths are relative to the server-selected work root.',
		errorCode: 'sandbox.path.not-work-relative',
		identity: 'sandbox.path.work-relative',
		kind: 'structural-validation',
		operation: {
			fieldNames: ['destinationPath', 'logicalCwd', 'path', 'sourcePath'],
			kind: 'work-relative-path',
		},
	},
] as const satisfies readonly PortableRefinementDescriptor[];

export const PORTABLE_REFINEMENT_IDENTITIES: readonly string[] =
	PORTABLE_REFINEMENT_DESCRIPTORS.map((descriptor) => descriptor.identity).toSorted(
		(leftIdentity, rightIdentity) => leftIdentity.localeCompare(rightIdentity),
	);
