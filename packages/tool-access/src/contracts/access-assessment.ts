import {
	googleAccountInvocationPolicyResultSchema,
	googleOperationEffectSchema,
	oauthAccountActivityAvailabilitySchema,
	oauthAccountIdSchema,
	oauthServiceIdSchema,
} from '@agent-vm/oauth-broker-contracts';
import { z } from 'zod';

import {
	configuredCliArgvTokenSchema,
	configuredCliPolicySchema,
} from '#tool-access/contracts/cli-allowance-policy';
import { compiledGoogleCommandSetSchema } from '#tool-access/contracts/compiled-google-command-set';
import { jsonValueSchema } from '#tool-access/contracts/json-value';
import {
	toolPortalBackendKindSchema,
	toolPortalToolSelectorSchema,
	toolPortalCallPolicySchema,
} from '#tool-access/contracts/tool-selectors';

import {
	CapabilityNameSchema,
	NamespaceNameSchema,
} from './portal-contracts/contract-primitives/models/capability-reference-schema.js';

const boundedId = z.string().min(1).max(256);
export const revisionRef = z.strictObject({ owner: boundedId, revision: boundedId });
export const accountRef = z.strictObject({ oauthAccountId: oauthAccountIdSchema });
export const capabilityRef = z.strictObject({
	namespace: NamespaceNameSchema,
	tool: CapabilityNameSchema,
});
export const callDigest = z.string().regex(/^[a-f0-9]{64}$/u);
export const hostAccessBinding = z.strictObject({
	workspaceLayer: z.enum(['not-configured', 'configured']),
	config: revisionRef,
});
export const inputRevisions = z.strictObject({
	hostConfig: revisionRef,
	registration: revisionRef.nullable(),
	workspaceAllowance: revisionRef.nullable(),
	profile: revisionRef,
	assignment: revisionRef,
	surfaceSnapshot: revisionRef,
	upstreamBinding: revisionRef,
	accounts: z
		.array(
			z.strictObject({
				account: accountRef,
				grant: revisionRef,
				policy: revisionRef.nullable(),
				consent: revisionRef,
			}),
		)
		.readonly(),
});
export const policyRuleRef = z.strictObject({
	source: z.enum([
		'workspace-allowance',
		'profile-selector',
		'mcp-approval-policy',
		'cli-allowance',
		'account-policy',
	]),
	ruleId: CapabilityNameSchema,
});
export const operationClassRef = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('cli-command'),
		commandPath: z.array(configuredCliArgvTokenSchema).min(1).readonly(),
	}),
	z.strictObject({
		kind: z.literal('google-effect'),
		serviceId: oauthServiceIdSchema,
		effect: googleOperationEffectSchema,
	}),
]);
export const surfaceClass = z.enum(['mcp', 'protected_uds']);
export const accessNamespacePolicy = z.strictObject({
	backendKind: toolPortalBackendKindSchema,
	tools: toolPortalToolSelectorSchema,
	calls: z.discriminatedUnion('kind', [
		toolPortalCallPolicySchema.safeExtend({ kind: z.literal('selectors') }),
		z.strictObject({ kind: z.literal('account-policy') }),
	]),
	operations: z.record(
		CapabilityNameSchema,
		z.strictObject({
			cliPolicy: configuredCliPolicySchema.nullable(),
			googleCommands: compiledGoogleCommandSetSchema.nullable(),
		}),
	),
});
export const accessProfileProjection = z.strictObject({
	profileId: boundedId,
	namespaces: z.record(NamespaceNameSchema, accessNamespacePolicy),
});
export const accountFact = z
	.strictObject({
		account: accountRef,
		granted: z.boolean(),
		grantRevision: revisionRef,
		policySnapshotState: z.enum(['applying', 'active']).nullable(),
		policyRevision: revisionRef.nullable(),
		consentRevision: revisionRef,
		availability: oauthAccountActivityAvailabilitySchema,
		decisions: z
			.array(
				z.strictObject({
					operationClass: operationClassRef.options[1],
					result: googleAccountInvocationPolicyResultSchema,
				}),
			)
			.readonly(),
		boundToCall: callDigest.nullable(),
	})
	.refine((fact) => (fact.policySnapshotState === null) === (fact.policyRevision === null), {
		message: 'A policy revision and its verified snapshot state must be present together.',
	});
export const accessFacts = z.strictObject({
	workspace: z.discriminatedUnion('kind', [
		z.strictObject({ kind: z.literal('not-configured') }),
		z.strictObject({
			kind: z.literal('configured'),
			registration: z.strictObject({
				status: z.enum(['active', 'revoked']),
				revision: revisionRef,
			}),
			allowance: z.strictObject({
				allowed: z.boolean(),
				rule: policyRuleRef,
				revision: revisionRef,
			}),
		}),
	]),
	assignment: z.strictObject({
		profile: accessProfileProjection,
		profileRevision: revisionRef,
		revision: revisionRef,
	}),
	surface: z.strictObject({ eligible: z.array(surfaceClass).readonly(), snapshot: revisionRef }),
	accounts: z.array(accountFact).readonly(),
	upstream: z.strictObject({
		status: z.enum(['available', 'unavailable']),
		credentialNeed: z.enum(['none', 'met', 'unmet']),
		binding: revisionRef,
	}),
});
export const assessAccessInput = z.strictObject({
	capability: capabilityRef,
	facts: accessFacts,
	surface: surfaceClass,
	call: z
		.strictObject({
			arguments: jsonValueSchema,
			account: accountRef.nullable(),
			digest: callDigest,
		})
		.nullable(),
});
export const unmetCondition = z.enum([
	'registration-revoked',
	'not-allowed-in-workspace',
	'not-given-to-agent',
	'account-not-granted',
	'account-policy-paused',
	'consent-missing-or-expired',
	'service-unavailable',
]);
export const accessState = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('usable') }),
	z.strictObject({ kind: z.literal('approval-each-call') }),
	z.strictObject({ kind: z.literal('blocked-by-policy'), rule: policyRuleRef }),
	z.strictObject({ kind: z.literal('not-usable'), firstUnmet: unmetCondition }),
]);
export const accessAssessment = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('fixed'),
		surface: surfaceClass,
		revisions: inputRevisions,
		state: accessState,
	}),
	z.strictObject({
		kind: z.literal('call-dependent'),
		surface: surfaceClass,
		revisions: inputRevisions,
		entries: z
			.array(
				z.strictObject({
					operationClass: operationClassRef.nullable(),
					account: accountRef.nullable(),
					state: accessState,
				}),
			)
			.readonly(),
		perCallRule: policyRuleRef,
	}),
]);
export const assessAccessResult = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('assessed'), assessment: accessAssessment }),
	z.strictObject({
		kind: z.literal('facts-rejected'),
		reason: z.enum(['workspace-layer-mismatch', 'account-decision-unbound']),
	}),
]);

export type HostAccessBinding = z.infer<typeof hostAccessBinding>;
export type InputRevisions = z.infer<typeof inputRevisions>;
export type PolicyRuleRef = z.infer<typeof policyRuleRef>;
export type OperationClassRef = z.infer<typeof operationClassRef>;
export type AccountFact = z.infer<typeof accountFact>;
export type AccessNamespacePolicy = z.infer<typeof accessNamespacePolicy>;
export type AssessAccessInput = z.infer<typeof assessAccessInput>;
export type AccessState = z.infer<typeof accessState>;
export type AccessAssessment = z.infer<typeof accessAssessment>;
export type AssessAccessResult = z.infer<typeof assessAccessResult>;
