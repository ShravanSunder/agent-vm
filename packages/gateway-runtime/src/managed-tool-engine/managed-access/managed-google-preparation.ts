import { Buffer } from 'node:buffer';

import {
	resolveCompiledGoogleCommand,
	validateCliAllowanceInvocation,
} from '@agent-collaboration/tool-access/authorization';
import {
	controllerConfiguredCliInputSchema,
	hashCallArguments,
	type AccountFact,
} from '@agent-collaboration/tool-access/contracts';
import type { PortalCallRequest, PortalCallResult } from '@agent-vm/agent-portal-sdk';
import { type GatewayRuntimeManagedToolPortalConfig } from '@agent-vm/config-contracts';
import { resolveManagedGoogleBinding } from '@agent-vm/gateway-runtime/managed-tool-engine/managed-access/managed-google-binding.js';
import {
	capabilityDeniedItem,
	notDispatchedItem,
} from '@agent-vm/gateway-runtime/managed-tool-engine/managed-call-results/managed-call-results.js';
import type {
	ToolPortalInvocationOptions,
	ToolPortalOAuthAvailabilityPort,
} from '@agent-vm/gateway-runtime/managed-tool-engine/models/managed-portal-ports.js';
import {
	managedGooglePreflightResultSchema,
	type ManagedGoogleReadyPreflight,
} from '@agent-vm/oauth-broker-contracts';
export type ManagedGooglePreparation =
	| {
			readonly kind: 'ready';
			readonly accounts: readonly AccountFact[];
			readonly managedGoogle?: ManagedGoogleReadyPreflight;
	  }
	| { readonly kind: 'refused'; readonly item: PortalCallResult['items'][number] };
/** Convert the existing controller preflight into Access facts, preserving the managed display/binding. */
export async function prepareManagedGoogleCall(props: {
	readonly call: PortalCallRequest['calls'][number];
	readonly config: GatewayRuntimeManagedToolPortalConfig;
	readonly profileId: string;
	readonly options: ToolPortalInvocationOptions;
	readonly port: ToolPortalOAuthAvailabilityPort | undefined;
	readonly operationId: string;
	readonly owningGeneration: string;
}): Promise<ManagedGooglePreparation> {
	const common = {
		id: props.call.id,
		operationId: props.operationId,
		owningGeneration: props.owningGeneration,
	};
	const policy = props.config.profiles[props.profileId]?.namespaces[props.call.namespace];
	if (policy === undefined || !('source' in policy.calls)) return { kind: 'ready', accounts: [] };
	try {
		const operation =
			policy.backend.kind === 'controller_execution'
				? policy.backend.operations[props.call.name]
				: undefined;
		if (
			operation?.kind !== 'configured_cli' ||
			operation.targetKind !== 'ephemeral_managed_vm' ||
			operation.compiledGoogle === undefined ||
			props.port?.preflight === undefined
		)
			throw new Error('Google command table/preflight unavailable.');
		const input = controllerConfiguredCliInputSchema.parse(props.call.arguments);
		const local = resolveCompiledGoogleCommand(operation.compiledGoogle, input.argv);
		const validation = validateCliAllowanceInvocation({ allowance: operation, input });
		if (!validation.ok || validation.matchedDenyRule || local.kind === 'denied')
			return { kind: 'refused', item: capabilityDeniedItem(common) };
		const result = managedGooglePreflightResultSchema.parse(
			await props.port.preflight({
				request: { capability: { name: props.call.name, namespace: props.call.namespace }, input },
				trustedContext: props.options.trustedContext,
				...(props.options.signal === undefined ? {} : { signal: props.options.signal }),
			}),
		);
		if (result.kind === 'denied') return { kind: 'refused', item: capabilityDeniedItem(common) };
		if (result.kind === 'consent-required' || result.kind === 'unavailable')
			return {
				kind: 'refused',
				item: notDispatchedItem({
					...common,
					reason:
						result.kind === 'consent-required'
							? 'Google account-owner consent is required'
							: 'Google account policy is unavailable',
				}),
			};
		if (result.kind === 'no-oauth') {
			if (
				local.kind !== 'no-oauth' ||
				result.commandTableRevision !== operation.compiledGoogle.revision
			)
				throw new Error('Google preflight classification mismatch.');
			return { kind: 'ready', accounts: [] };
		}
		resolveManagedGoogleBinding({
			config: props.config,
			profileId: props.profileId,
			call: props.call,
			preflight: result,
		});
		if (local.kind !== 'oauth') throw new Error('Google preflight classification mismatch.');
		const owner = 'agent-vm-controller';
		const revision = {
			owner,
			revision: `${result.binding.configRevision}:${result.binding.overrideRevision}:${result.binding.defaultsRevision}`,
		};
		return {
			kind: 'ready',
			managedGoogle: result,
			accounts: [
				{
					account: { oauthAccountId: result.binding.accountId },
					granted: true,
					grantRevision: {
						owner,
						revision: `${result.binding.authorizationId}:${result.binding.generation}`,
					},
					consentRevision: {
						owner,
						revision: String(result.binding.authorizationMetadataRevision),
					},
					policySnapshotState: 'active',
					policyRevision: revision,
					availability: {
						kind: 'ready',
						disposition: result.disposition,
						overrideRevision: result.binding.overrideRevision,
						defaultsRevision: result.binding.defaultsRevision,
					},
					boundToCall: Buffer.from(
						await hashCallArguments(props.call.arguments),
						'base64url',
					).toString('hex'),
					decisions: local.requirements.flatMap((requirement) =>
						requirement.effects.map((effect) => ({
							operationClass: { kind: 'google-effect', serviceId: requirement.serviceId, effect },
							result: {
								kind: 'allowed',
								disposition: result.disposition,
								overrideRevision: result.binding.overrideRevision,
							},
						})),
					),
				},
			],
		};
	} catch {
		return {
			kind: 'refused',
			item: notDispatchedItem({ ...common, reason: 'Google account policy could not be verified' }),
		};
	}
}
