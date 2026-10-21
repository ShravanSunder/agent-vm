import {
	accessState,
	callDigest,
	capabilityRef,
	jsonObjectSchema,
	jsonValueSchema,
	revisionRef,
	inputRevisions,
	surfaceClass,
	toolPortalBackendKindSchema,
	type AssessAccessInput,
} from '@agent-collaboration/tool-access/contracts';
import { z } from 'zod';

const boundedReference = z.string().min(1).max(1024);
export const operationKeySchema = z.strictObject({
	authority: boundedReference,
	principal: boundedReference,
	item: boundedReference,
});
export const dispatchInvocationSchema = z.strictObject({
	version: z.literal('tool-dispatch-v1'),
	authority: boundedReference,
	operationKey: operationKeySchema,
	capability: capabilityRef,
	arguments: jsonObjectSchema,
	backendKind: toolPortalBackendKindSchema,
	bindingRevision: revisionRef,
	admissionRevisions: inputRevisions,
	verifiedContextRef: boundedReference,
	approvalReceiptRef: boundedReference.nullable(),
	surface: surfaceClass,
	correlation: jsonObjectSchema,
	intentDigest: callDigest,
});
export const operationRecordSchema = z.strictObject({
	version: z.literal('tool-operation-v1'),
	key: operationKeySchema,
	intentDigest: callDigest,
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
	revision: boundedReference,
	state: z.discriminatedUnion('kind', [
		z.strictObject({ kind: z.literal('ready') }),
		z.strictObject({ kind: z.literal('pending'), reference: boundedReference }),
		z.strictObject({ kind: z.literal('armed') }),
		z.strictObject({ kind: z.literal('completed'), result: jsonValueSchema }),
		z.strictObject({ kind: z.literal('ambiguous'), reason: boundedReference }),
		z.strictObject({ kind: z.literal('result-expired') }),
	]),
});
export const approvalReceiptSchema = z.strictObject({
	reference: boundedReference,
	decision: z.literal('approve'),
	authoritativeRevision: revisionRef,
	operationKey: operationKeySchema,
	intentDigest: callDigest,
	backendKind: toolPortalBackendKindSchema,
	bindingRevision: revisionRef,
	admissionRevisions: inputRevisions,
	verifiedContextRef: boundedReference,
	expiresAt: z.iso.datetime(),
});
export const approvalChallengeSchema = z.strictObject({
	authority: boundedReference,
	approvalId: boundedReference,
	operationKey: operationKeySchema,
	intentDigest: callDigest,
	callerDisplay: boundedReference,
	targetDisplay: boundedReference,
	revisions: inputRevisions,
	expiresAt: z.iso.datetime(),
	permittedDecisions: z
		.array(z.enum(['approve', 'deny']))
		.min(1)
		.max(2)
		.readonly(),
});
export const resourceResultSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('completed'), result: jsonValueSchema }),
	z.strictObject({
		kind: z.literal('pending'),
		reference: boundedReference,
		detail: jsonValueSchema,
	}),
	z.strictObject({ kind: z.literal('denied'), state: accessState }),
	z.strictObject({ kind: z.literal('not-dispatched'), reason: boundedReference }),
	z.strictObject({ kind: z.literal('failed'), reason: boundedReference }),
	z.strictObject({ kind: z.literal('ambiguous'), reason: boundedReference }),
	z.strictObject({ kind: z.literal('result-expired') }),
]);
export type OperationKey = z.infer<typeof operationKeySchema>;
export type DispatchInvocation = z.infer<typeof dispatchInvocationSchema>;
export type OperationRecord = z.infer<typeof operationRecordSchema>;
export type ApprovalReceipt = z.infer<typeof approvalReceiptSchema>;
export type ApprovalChallenge = z.infer<typeof approvalChallengeSchema>;
export type ResourceResult = z.infer<typeof resourceResultSchema>;
export type BackendKind = DispatchInvocation['backendKind'];
export type OperationRefusal = {
	readonly kind: 'conflict' | 'denied' | 'unavailable' | 'unsupported-version';
};
export type OperationCreateResult =
	| OperationRefusal
	// Any host may decline recording only when requiresApproval is false.
	| { readonly kind: 'untracked' }
	| { readonly kind: 'created' | 'existing'; readonly record: OperationRecord };
export type OperationLookupResult =
	| OperationRefusal
	| { readonly kind: 'not-found' }
	| { readonly kind: 'found'; readonly record: OperationRecord };
export interface OperationPort {
	readonly createOrRead: (request: {
		readonly invocation: DispatchInvocation;
		readonly requiresApproval: boolean;
	}) => Promise<OperationCreateResult>;
	readonly lookup: (request: {
		readonly version: string;
		readonly key: OperationKey;
		readonly verifiedContextRef: string;
	}) => Promise<OperationLookupResult>;
	readonly transition: (request: {
		readonly invocation: DispatchInvocation;
		readonly expectedRevision: string;
		readonly next: OperationRecord['state'];
	}) => Promise<OperationLookupResult>;
}
export type ApprovalResult =
	| { readonly kind: 'approved'; readonly receipt: ApprovalReceipt }
	| {
			readonly kind: 'pending';
			readonly challenge: ApprovalChallenge;
	  }
	| { readonly kind: 'denied' | 'unavailable' | 'expired' };
export interface ApprovalPort {
	readonly challenge: (invocation: DispatchInvocation) => Promise<ApprovalResult>;
	readonly decision: (request: {
		readonly approvalId: string;
		readonly decision: 'approve' | 'deny';
		readonly authenticatedApproverContextRef: string;
	}) => Promise<
		| {
				readonly kind: 'recorded';
				readonly approvalId: string;
				readonly decision: 'approve' | 'deny';
		  }
		| { readonly kind: 'denied' | 'expired' | 'unavailable' }
	>;
	readonly receipt: (request: {
		readonly invocation: DispatchInvocation;
		readonly reference: string;
	}) => Promise<ApprovalResult>;
}
export interface BackendDiscoveryRequest {
	readonly request: z.infer<typeof jsonValueSchema>;
	readonly verifiedContextRef: string;
}
export interface ToolBackend<TBackendKind extends BackendKind> {
	readonly backendKind: TBackendKind;
	readonly list: (request: BackendDiscoveryRequest) => Promise<z.infer<typeof jsonValueSchema>>;
	readonly describe: (request: BackendDiscoveryRequest) => Promise<z.infer<typeof jsonValueSchema>>;
	readonly search: (request: BackendDiscoveryRequest) => Promise<z.infer<typeof jsonValueSchema>>;
	readonly invoke: (
		invocation: DispatchInvocation & { readonly backendKind: TBackendKind },
	) => Promise<ResourceResult>;
}
export interface DispatchRequest {
	readonly authority: string;
	readonly principal: string;
	readonly item: string;
	readonly verifiedContextRef: string;
	readonly correlation: DispatchInvocation['correlation'];
	readonly access: AssessAccessInput;
}
