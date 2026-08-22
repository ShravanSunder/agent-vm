import { z } from 'zod';

import {
	ApprovalPresentationOutcomeSchema,
	GatewayApprovalDecisionRequestSchema,
	GatewayApprovalDecisionResultSchema,
	GatewayApprovalPresentationRequestSchema,
} from '../approval-surface/index.js';
import {
	ArtifactReferenceSchema,
	PortalArtifactReadRequestSchema,
	PortalArtifactReadResultSchema,
} from '../artifact-surface/index.js';
import { JsonValueSchema } from '../contract-primitives/index.js';
import {
	GatewayRuntimeAttachmentMetadataSchema,
	GatewayRuntimeTrustedInvocationContextSchema,
	ManagedAgentProjectionSchema,
	SANDBOX_METHOD_CONTRACTS,
	SandboxOperationControlResultSchema,
	SandboxOperationIdentitySchema,
	SandboxRetainedResultLookupRequestSchema,
	SandboxRetainedResultLookupResultSchema,
} from '../contracts/index.js';
import {
	PortalCallItemResultSchema,
	PortalCallRequestSchema,
	PortalCallResultSchema,
	PortalDescribeRequestSchema,
	PortalDescribeResultSchema,
	PortalListRequestSchema,
	PortalListResultSchema,
	PortalSearchRequestSchema,
	PortalSearchResultSchema,
} from '../portal-call-surface/index.js';
import { PortalProgressEventSchema } from '../portal-event-surface/index.js';
import { portableRefinementIdentityForCheck } from './portable-refinement-authoring.js';
import { PORTABLE_REFINEMENT_IDENTITIES } from './portable-refinement-descriptors.js';
export {
	PORTABLE_REFINEMENT_DESCRIPTORS,
	PORTABLE_REFINEMENT_IDENTITIES,
} from './portable-refinement-descriptors.js';

interface PortableAcceptedContractParseResult {
	readonly kind: 'accepted';
	readonly normalized: unknown;
	readonly refinementIdentities: readonly string[];
}

interface PortableRejectedContractParseResult {
	readonly errorCodes: readonly string[];
	readonly kind: 'rejected';
	readonly refinementIdentities: readonly string[];
}

export type PortableContractParseResult =
	| PortableAcceptedContractParseResult
	| PortableRejectedContractParseResult;

export interface PortableContractAdapter {
	readonly parse: (input: unknown) => PortableContractParseResult;
}

export const PORTABLE_CONTRACT_PROTOCOL_VERSION = 1;

interface PortableContractDefinition {
	readonly refinementIdentities: readonly string[];
	readonly resolveRefinementIdentities?: (props: {
		readonly input: unknown;
		readonly parseSucceeded: boolean;
	}) => readonly string[];
	readonly schema: z.ZodType;
}

interface PortableSchemaExportabilityProps {
	readonly schema: z.ZodType;
	readonly schemaId: string;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isZodSchema(value: unknown): value is z.ZodType {
	return isUnknownRecord(value) && isUnknownRecord(value['_zod']) && 'def' in value['_zod'];
}

function containsUnsafeInteger(value: unknown): boolean {
	if (typeof value === 'number') return Number.isInteger(value) && !Number.isSafeInteger(value);
	if (Array.isArray(value)) return value.some((item) => containsUnsafeInteger(item));
	if (isUnknownRecord(value)) {
		return Object.values(value).some((childValue) => containsUnsafeInteger(childValue));
	}
	return false;
}

function inspectPortableSchemaNode(props: {
	readonly node: unknown;
	readonly schemaId: string;
	readonly visited: Set<object>;
}): void {
	if ((typeof props.node !== 'object' && typeof props.node !== 'function') || props.node === null) {
		return;
	}
	if (props.visited.has(props.node)) {
		return;
	}
	props.visited.add(props.node);

	if (isZodSchema(props.node)) {
		// oxlint-disable-next-line no-underscore-dangle -- Zod v4 core definitions are required for the portable-authoring structural guard.
		const definition: unknown = props.node._zod.def;
		if (isUnknownRecord(definition) && definition['type'] === 'transform') {
			throw new Error(
				`Portable schema ${props.schemaId} contains an anonymous or unregistered transform.`,
			);
		}
		if (isUnknownRecord(definition) && Array.isArray(definition['checks'])) {
			for (const check of definition['checks']) {
				if (
					isUnknownRecord(check) &&
					isUnknownRecord(check['_zod']) &&
					isUnknownRecord(check['_zod']['def']) &&
					check['_zod']['def']['check'] === 'custom'
				) {
					if (portableRefinementIdentityForCheck(check) !== undefined) {
						continue;
					}
					throw new Error(
						`Portable schema ${props.schemaId} contains an anonymous or unregistered refinement.`,
					);
				}
			}
		}
		inspectPortableSchemaNode({
			node: definition,
			schemaId: props.schemaId,
			visited: props.visited,
		});
		return;
	}

	if (Array.isArray(props.node)) {
		for (const child of props.node) {
			inspectPortableSchemaNode({ node: child, schemaId: props.schemaId, visited: props.visited });
		}
		return;
	}

	for (const child of Object.values(props.node)) {
		inspectPortableSchemaNode({ node: child, schemaId: props.schemaId, visited: props.visited });
	}
}

export function assertPortableContractSchemaIsExportable(
	props: PortableSchemaExportabilityProps,
): void {
	inspectPortableSchemaNode({ node: props.schema, schemaId: props.schemaId, visited: new Set() });
}

function normalizeCanonicalJsonValue(value: unknown): unknown {
	if (typeof value === 'number') {
		return Object.is(value, -0) ? 0 : value;
	}
	if (Array.isArray(value)) {
		return value.map((item) => normalizeCanonicalJsonValue(item));
	}
	if (isUnknownRecord(value)) {
		return Object.fromEntries(
			Object.entries(value)
				.toSorted(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
				.map(([key, childValue]) => [key, normalizeCanonicalJsonValue(childValue)]),
		);
	}
	return value;
}

export function encodeCanonicalJson(value: unknown): string {
	const encodedValue = JSON.stringify(normalizeCanonicalJsonValue(value));
	if (encodedValue === undefined) {
		throw new Error('Canonical JSON input must be JSON-serializable.');
	}
	return encodedValue;
}

function mapPortableIssue(props: {
	readonly input: unknown;
	readonly issue: z.core.$ZodIssue;
	readonly schemaId: string;
}): string {
	if (props.schemaId === 'portal.call.item-result') {
		const firstPathSegment = props.issue.path?.[0];
		if (
			firstPathSegment === 'outcome' ||
			firstPathSegment === 'operationId' ||
			firstPathSegment === 'owningGeneration'
		) {
			return 'portal.result.outcome-algebra';
		}
		if (props.issue.code === 'unrecognized_keys' || props.issue.code === 'invalid_union') {
			return 'portal.result.status-shape';
		}
	}

	if (props.issue.code === 'unrecognized_keys') {
		return 'portable.object.unknown-field';
	}
	if (
		props.issue.code === 'invalid_type' &&
		props.issue.path?.length === 1 &&
		isUnknownRecord(props.input) &&
		typeof props.issue.path[0] === 'string' &&
		!(props.issue.path[0] in props.input)
	) {
		return 'portable.object.missing-field';
	}
	if (
		props.issue.code === 'invalid_format' &&
		'format' in props.issue &&
		props.issue.format === 'starts_with'
	) {
		return 'portable.string.pattern';
	}
	if (props.issue.code === 'too_big' && props.issue.origin === 'number') {
		return 'portable.number.above-maximum';
	}
	if (props.issue.code === 'custom') {
		if (props.issue.message.includes('decoded canonical base64 content')) {
			return 'sandbox.binary-chunk.byte-length-mismatch';
		}
		if (props.issue.message.includes('duplicate variable name')) {
			return 'sandbox.environment-variable.duplicate-name';
		}
		if (props.issue.message.includes('duplicate configured agent id')) {
			return 'gateway.attachment.duplicate-agent-id';
		}
		if (props.issue.message.includes('Managed Agent Projection Tool Portal namespaces')) {
			return 'gateway.managed-agent-projection.namespaces';
		}
		if (props.issue.message.includes('server-selected work root')) {
			return 'sandbox.path.not-work-relative';
		}
		if (props.issue.message.startsWith('Duplicate portal item id')) {
			return 'portal.batch.unique-item-ids';
		}
		if (props.issue.message.includes('reserved object property name')) {
			return 'portal.request-id.not-reserved';
		}
		if (props.issue.message.includes('maximum number of entries')) {
			return 'portable.object.above-maximum';
		}
		if (props.issue.message.includes('ok must match item statuses')) {
			return 'portal.result.aggregate-status';
		}
	}
	return `portable.zod.${props.issue.code}`;
}

function createPortableContractAdapter(props: {
	readonly definition: PortableContractDefinition;
	readonly schemaId: string;
}): PortableContractAdapter {
	return {
		parse: (input): PortableContractParseResult => {
			if (containsUnsafeInteger(input)) {
				return {
					errorCodes: ['portable.number.unsafe-integer'],
					kind: 'rejected',
					refinementIdentities: [
						...new Set([...props.definition.refinementIdentities, 'portal.number.safe-integer']),
					].toSorted((leftIdentity, rightIdentity) => leftIdentity.localeCompare(rightIdentity)),
				};
			}
			const parsed = props.definition.schema.safeParse(input);
			const refinementIdentities = (
				props.definition.resolveRefinementIdentities?.({
					input,
					parseSucceeded: parsed.success,
				}) ?? props.definition.refinementIdentities
			).toSorted((leftIdentity, rightIdentity) => leftIdentity.localeCompare(rightIdentity));
			if (!parsed.success) {
				const errorCodes =
					props.schemaId === 'portal.call.item-result' &&
					isUnknownRecord(input) &&
					callItemHasStatusShapeConflict(input)
						? ['portal.result.status-shape']
						: [
								...new Set(
									parsed.error.issues.map((issue) =>
										mapPortableIssue({ input, issue, schemaId: props.schemaId }),
									),
								),
							].toSorted((leftCode, rightCode) => leftCode.localeCompare(rightCode));
				return {
					errorCodes,
					kind: 'rejected',
					refinementIdentities,
				};
			}
			return {
				kind: 'accepted',
				normalized: normalizeCanonicalJsonValue(parsed.data),
				refinementIdentities,
			};
		},
	};
}

function callItemHasStatusShapeConflict(input: Record<string, unknown>): boolean {
	return (
		(input['status'] === 'ok' && 'error' in input) ||
		(input['status'] === 'error' && 'value' in input)
	);
}

const portableContractDefinitions = {
	'portal.artifact.read-request': {
		refinementIdentities: [],
		schema: PortalArtifactReadRequestSchema,
	},
	'portal.artifact.read-result': {
		refinementIdentities: ['portal.artifact-read.default-truncated'],
		schema: PortalArtifactReadResultSchema,
	},
	'portal.artifact.reference': {
		refinementIdentities: [],
		schema: ArtifactReferenceSchema,
	},
	'portal.call.item-result': {
		refinementIdentities: ['portal.request-id.not-reserved', 'portal.result.outcome-algebra'],
		resolveRefinementIdentities: ({ input }): readonly string[] => {
			return isUnknownRecord(input) &&
				!callItemHasStatusShapeConflict(input) &&
				('outcome' in input || !('operationId' in input))
				? ['portal.request-id.not-reserved', 'portal.result.outcome-algebra']
				: ['portal.request-id.not-reserved'];
		},
		schema: PortalCallItemResultSchema,
	},
	'portal.call.request': {
		refinementIdentities: [
			'portal.batch.unique-item-ids',
			'portal.json.canonical',
			'portal.request-id.not-reserved',
		],
		resolveRefinementIdentities: ({ parseSucceeded }): readonly string[] => {
			return parseSucceeded
				? [
						'portal.batch.unique-item-ids',
						'portal.json.canonical',
						'portal.request-id.not-reserved',
					]
				: ['portal.batch.unique-item-ids', 'portal.request-id.not-reserved'];
		},
		schema: PortalCallRequestSchema,
	},
	'portal.call.result': {
		refinementIdentities: [
			'portal.request-id.not-reserved',
			'portal.result.aggregate-status',
			'portal.result.outcome-algebra',
		],
		schema: PortalCallResultSchema,
	},
	'portal.describe.request': {
		refinementIdentities: [
			'portal.batch.unique-item-ids',
			'portal.describe.default-includes',
			'portal.request-id.not-reserved',
		],
		schema: PortalDescribeRequestSchema,
	},
	'portal.describe.result': {
		refinementIdentities: ['portal.request-id.not-reserved', 'portal.result.aggregate-status'],
		schema: PortalDescribeResultSchema,
	},
	'portal.json-value': {
		refinementIdentities: ['portal.json.canonical', 'portal.json.max-object-entries'],
		resolveRefinementIdentities: ({ input }): readonly string[] => {
			return isUnknownRecord(input) && Object.keys(input).length > 1_000
				? ['portal.json.canonical', 'portal.json.max-object-entries']
				: ['portal.json.canonical'];
		},
		schema: JsonValueSchema,
	},
	'portal.list.request': {
		refinementIdentities: [
			'portal.batch.unique-item-ids',
			'portal.list.default-limit',
			'portal.request-id.not-reserved',
		],
		schema: PortalListRequestSchema,
	},
	'portal.list.result': {
		refinementIdentities: ['portal.request-id.not-reserved', 'portal.result.aggregate-status'],
		schema: PortalListResultSchema,
	},
	'portal.progress.event': {
		refinementIdentities: ['portal.request-id.not-reserved'],
		schema: PortalProgressEventSchema,
	},
	'portal.search.request': {
		refinementIdentities: [
			'portal.batch.unique-item-ids',
			'portal.request-id.not-reserved',
			'portal.search.default-limit',
			'portal.search.default-schema-detail',
		],
		schema: PortalSearchRequestSchema,
	},
	'portal.search.result': {
		refinementIdentities: ['portal.request-id.not-reserved', 'portal.result.aggregate-status'],
		schema: PortalSearchResultSchema,
	},
} as const satisfies Readonly<Record<string, PortableContractDefinition>>;

const canonicalGatewayContractDefinitions = {
	'gateway.approval.decision-request': {
		refinementIdentities: [],
		schema: GatewayApprovalDecisionRequestSchema,
	},
	'gateway.approval.decision-result': {
		refinementIdentities: [],
		schema: GatewayApprovalDecisionResultSchema,
	},
	'gateway.approval.presentation-outcome': {
		refinementIdentities: [],
		schema: ApprovalPresentationOutcomeSchema,
	},
	'gateway.approval.presentation-request': {
		refinementIdentities: ['gateway.approval.arguments-preview.utf8-bytes'],
		schema: GatewayApprovalPresentationRequestSchema,
	},
	'gateway.attachment.metadata': {
		refinementIdentities: ['gateway.attachment.unique-agent-ids'],
		schema: GatewayRuntimeAttachmentMetadataSchema,
	},
	'gateway.managed-agent-projection': {
		refinementIdentities: ['gateway.managed-agent-projection.namespaces'],
		schema: ManagedAgentProjectionSchema,
	},
	'gateway.trusted-invocation-context': {
		refinementIdentities: [],
		schema: GatewayRuntimeTrustedInvocationContextSchema,
	},
	'sandbox.operation.control-result': {
		refinementIdentities: ['portal.result.outcome-algebra'],
		schema: SandboxOperationControlResultSchema,
	},
	'sandbox.operation.identity': {
		refinementIdentities: [],
		schema: SandboxOperationIdentitySchema,
	},
	'sandbox.retained-result.lookup-request': {
		refinementIdentities: [],
		schema: SandboxRetainedResultLookupRequestSchema,
	},
	'sandbox.retained-result.lookup-result': {
		refinementIdentities: ['portal.result.outcome-algebra'],
		schema: SandboxRetainedResultLookupResultSchema,
	},
} as const satisfies Readonly<Record<string, PortableContractDefinition>>;

interface SandboxMethodPortableContractMetadata {
	readonly requestRefinementIdentities: readonly string[];
	readonly requestSchemaId: string;
	readonly resultRefinementIdentities: readonly string[];
	readonly resultSchemaId: string;
}

function resolveSandboxMethodPortableContractMetadata(props: {
	readonly method: string;
	readonly requestOnlyRefinementIdentities: readonly string[];
	readonly sharedRefinementIdentities: readonly string[];
}): SandboxMethodPortableContractMetadata {
	if (props.method === 'sandbox.retained-result.lookup') {
		return {
			requestRefinementIdentities: [
				...props.sharedRefinementIdentities,
				...props.requestOnlyRefinementIdentities,
			],
			requestSchemaId: 'sandbox.retained-result.lookup-request',
			resultRefinementIdentities: [
				...props.sharedRefinementIdentities,
				'portal.result.outcome-algebra',
			],
			resultSchemaId: 'sandbox.retained-result.lookup-result',
		};
	}
	return {
		requestRefinementIdentities: [
			...props.sharedRefinementIdentities,
			...props.requestOnlyRefinementIdentities,
		],
		requestSchemaId: `${props.method}.request`,
		resultRefinementIdentities: props.sharedRefinementIdentities,
		resultSchemaId: `${props.method}.result`,
	};
}

function createSandboxMethodContractDefinitions(): Readonly<
	Record<string, PortableContractDefinition>
> {
	const contractDefinitions: Record<string, PortableContractDefinition> = {};
	for (const [method, contracts] of Object.entries(SANDBOX_METHOD_CONTRACTS)) {
		const refinementIdentities: string[] = method.startsWith('sandbox.environment.')
			? ['sandbox.path.work-relative']
			: [];
		const requestOnlyRefinementIdentities =
			method === 'sandbox.exec.start' || method === 'sandbox.process.start'
				? ['sandbox.environment-variable.unique-names']
				: [];
		if (
			[
				'sandbox.fs.read',
				'sandbox.fs.write',
				'sandbox.process.logs',
				'sandbox.stream.read',
				'sandbox.stream.write',
			].includes(method)
		) {
			refinementIdentities.push('sandbox.binary-chunk.byte-length');
		}
		const metadata = resolveSandboxMethodPortableContractMetadata({
			method,
			requestOnlyRefinementIdentities,
			sharedRefinementIdentities: refinementIdentities,
		});
		contractDefinitions[metadata.requestSchemaId] = {
			refinementIdentities: metadata.requestRefinementIdentities,
			schema: contracts.request,
		};
		contractDefinitions[metadata.resultSchemaId] = {
			refinementIdentities: metadata.resultRefinementIdentities,
			schema: contracts.result,
		};
	}
	return contractDefinitions;
}

const sandboxMethodContractDefinitions = createSandboxMethodContractDefinitions();

const allPortableContractDefinitions: Readonly<Record<string, PortableContractDefinition>> = {
	...portableContractDefinitions,
	...canonicalGatewayContractDefinitions,
	...sandboxMethodContractDefinitions,
};

for (const [schemaId, definition] of Object.entries(allPortableContractDefinitions)) {
	assertPortableContractSchemaIsExportable({ schema: definition.schema, schemaId });
}

export function createPortableContractSchemaManifest(): Readonly<Record<string, unknown>> {
	return {
		protocolVersion: PORTABLE_CONTRACT_PROTOCOL_VERSION,
		refinements: PORTABLE_REFINEMENT_IDENTITIES,
		schemas: Object.fromEntries(
			Object.entries(allPortableContractDefinitions).map(([schemaId, definition]) => [
				schemaId,
				{
					jsonSchema: z.toJSONSchema(definition.schema, {
						io: 'input',
						unrepresentable: 'any',
					}),
					refinementIdentities: definition.refinementIdentities.toSorted(
						(leftIdentity, rightIdentity) => leftIdentity.localeCompare(rightIdentity),
					),
				},
			]),
		),
	};
}

export const PORTABLE_CONTRACT_ADAPTERS = Object.fromEntries(
	Object.entries(allPortableContractDefinitions).map(([schemaId, definition]) => [
		schemaId,
		createPortableContractAdapter({ definition, schemaId }),
	]),
) satisfies Readonly<Record<string, PortableContractAdapter>>;
