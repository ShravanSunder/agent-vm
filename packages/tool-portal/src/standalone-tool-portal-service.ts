import { createHash } from 'node:crypto';

import {
	PortalCallRequestSchema,
	PortalDescribeRequestSchema,
	PortalListRequestSchema,
	PortalSearchRequestSchema,
	type PortalCallRequest,
} from '@agent-vm/agent-portal-sdk';
import {
	compileToolPortalNamespaceDiscoveryByProfile,
	toolPortalConfigSchema,
} from '@agent-vm/config-contracts';

import {
	deriveStandaloneToolPortalApprovalBatchFingerprint,
	type StandaloneToolPortalApprovalBatchIntent,
	type StandaloneToolPortalApprovalCoordinator,
} from './standalone-entrypoint/standalone-tool-portal-approval.js';
import {
	ToolPortalStandaloneSemanticSnapshotSchema,
	ToolPortalStandaloneServiceInvocationOptionsSchema,
	type ToolPortalStandaloneSemanticSnapshot,
	type ToolPortalStandaloneServiceInvocationOptions,
} from './standalone-tool-portal-invocation-contracts.js';
import {
	mergeToolPortalDescribe,
	mergeToolPortalList,
	mergeToolPortalSearch,
	type ToolPortalBackendEntry,
} from './tool-portal-result-router.js';
import {
	ambiguousDispatchItem,
	approvalRequiredItem,
	callPolicyDecision,
	canonicalJson,
	capabilityDeniedItem,
	deepFreeze,
	deterministicOperationId,
	directDispatchFingerprint,
	notDispatchedItem,
	type PortalCallItem,
	type ToolPortalCallPolicyDecision,
} from './tool-portal-service-common.js';
import type {
	CreateStandaloneV1ToolPortalServiceProps,
	ToolPortalCapabilityCore,
	ToolPortalService,
	ToolPortalStandaloneMcpBackendInvocationOptions,
	ToolPortalStandaloneMcpBackendReadOptions,
	ToolPortalStandaloneMcpDispatchAuthority,
} from './tool-portal-service.js';

interface ResolvedStandaloneInvocation {
	readonly approvalToken?: string;
	readonly operationOptions: ToolPortalStandaloneMcpBackendReadOptions;
	readonly profileId: string;
	readonly stablePrincipal: string;
}

interface StandaloneCallPlan {
	readonly call: PortalCallRequest['calls'][number];
	readonly operationId: string;
	readonly policyDecision: ToolPortalCallPolicyDecision;
}

function resolveStandaloneInvocation(props: {
	readonly config: CreateStandaloneV1ToolPortalServiceProps['config'];
	readonly options: ToolPortalStandaloneServiceInvocationOptions;
	readonly semanticSnapshot: ToolPortalStandaloneSemanticSnapshot;
}): ResolvedStandaloneInvocation {
	const parsedOptions = ToolPortalStandaloneServiceInvocationOptionsSchema.parse(props.options);
	if (props.semanticSnapshot.desiredRevision !== props.semanticSnapshot.activeRevision) {
		throw new Error('Tool Portal semantic snapshot is not active.');
	}
	const principal = parsedOptions.origin.authenticatedEnvelope.principal;
	const configAssignment = props.config.agents[principal.agentId];
	const snapshotProjection = props.semanticSnapshot.agentProjections[principal.agentId];
	if (configAssignment === undefined || snapshotProjection === undefined) {
		throw new Error(`Tool Portal agent "${principal.agentId}" is not configured.`);
	}
	if (
		configAssignment.profile !== principal.toolPortalProfileId ||
		snapshotProjection.agentId !== principal.agentId ||
		snapshotProjection.credentialVersion !== principal.credentialVersion ||
		snapshotProjection.profileAssignmentRevision !== principal.profileAssignmentRevision ||
		snapshotProjection.toolPortalProfileId !== principal.toolPortalProfileId
	) {
		throw new Error(`Tool Portal standalone identity does not match agent "${principal.agentId}".`);
	}
	return {
		...(parsedOptions.approvalToken === undefined
			? {}
			: { approvalToken: parsedOptions.approvalToken }),
		operationOptions: {
			correlation: parsedOptions.correlation,
			origin: parsedOptions.origin,
			...(parsedOptions.signal === undefined ? {} : { signal: parsedOptions.signal }),
			surfaceClass: parsedOptions.surfaceClass,
		},
		profileId: principal.toolPortalProfileId,
		stablePrincipal: [
			'standalone-v1',
			principal.agentId,
			principal.toolPortalProfileId,
			principal.profileAssignmentRevision,
			String(principal.credentialVersion),
		].join('\u0000'),
	};
}

function backendEntriesForInvocation(props: {
	readonly backendPort: CreateStandaloneV1ToolPortalServiceProps['backendPorts']['mcpProvider'];
	readonly config: CreateStandaloneV1ToolPortalServiceProps['config'];
	readonly operationOptions: ToolPortalStandaloneMcpBackendReadOptions;
	readonly profileId: string;
	readonly semanticSnapshot: ToolPortalStandaloneSemanticSnapshot;
}): readonly ToolPortalBackendEntry<
	ToolPortalStandaloneMcpBackendInvocationOptions,
	ToolPortalStandaloneMcpBackendReadOptions
>[] {
	const profileConfig = props.config.profiles[props.profileId];
	if (profileConfig === undefined) {
		throw new Error(`Tool Portal profile "${props.profileId}" is not configured.`);
	}
	const surfaceEligibility =
		props.semanticSnapshot.surfaceEligibilityByProfile[props.profileId] ?? {};
	const namespaces = new Set<string>();
	for (const [namespace, namespacePolicy] of Object.entries(profileConfig.namespaces)) {
		if (
			namespacePolicy.backend.kind === 'mcp_provider' &&
			(surfaceEligibility[namespace] ?? []).includes(props.operationOptions.surfaceClass)
		) {
			namespaces.add(namespace);
		}
	}
	return [
		{
			backend: props.backendPort,
			namespaceDiscovery: (
				props.semanticSnapshot.namespaceDiscoveryByProfile[props.profileId] ?? []
			).filter((entry) => namespaces.has(entry.namespace)),
			namespaces,
		},
	];
}

function approvalAdmissionItem(props: {
	readonly admission: Exclude<
		ReturnType<StandaloneToolPortalApprovalCoordinator['reserveDispatch']>,
		{ readonly kind: 'dispatch-reserved' }
	>;
	readonly callId: string;
	readonly operationId: string;
	readonly owningGeneration: string;
}): PortalCallItem {
	switch (props.admission.kind) {
		case 'approval-required':
			return approvalRequiredItem({
				challengeId: props.admission.challenge.challengeId,
				expiresAt: props.admission.challenge.expiresAt,
				id: props.callId,
				operationId: props.operationId,
				owningGeneration: props.owningGeneration,
			});
		case 'not-dispatched':
			return notDispatchedItem({
				id: props.callId,
				operationId: props.operationId,
				owningGeneration: props.owningGeneration,
				reason: props.admission.reason,
			});
		case 'ambiguous':
			return ambiguousDispatchItem({
				id: props.callId,
				operationId: props.operationId,
				owningGeneration: props.owningGeneration,
			});
	}
}

function deriveStandaloneRevision(domain: string, material: object): string {
	const digest = createHash('sha256')
		.update(`${domain}\0`, 'utf8')
		.update(canonicalJson(material), 'utf8')
		.digest('hex');
	return `${domain}:${digest}`;
}

function deriveEffectiveStandaloneSemanticSnapshot(options: {
	readonly baseSemanticSnapshot: ToolPortalStandaloneSemanticSnapshot;
	readonly namespaceDiscoveryByProfile: ReturnType<
		typeof compileToolPortalNamespaceDiscoveryByProfile
	>;
}): ToolPortalStandaloneSemanticSnapshot {
	const namespaceDiscoveryByProfile = Object.fromEntries(
		Object.entries(options.namespaceDiscoveryByProfile).map(([profileId, entries]) => [
			profileId,
			entries.map((entry) => ({ ...entry })),
		]),
	);
	const catalogRevision = deriveStandaloneRevision('standalone-catalog', {
		baseCatalogRevision: options.baseSemanticSnapshot.catalogRevision,
		namespaceDiscoveryByProfile,
	});
	const aggregateRevision = (baseRevision: string): string =>
		deriveStandaloneRevision('standalone-portal-admission', {
			baseRevision,
			catalogRevision,
		});
	return ToolPortalStandaloneSemanticSnapshotSchema.parse({
		...options.baseSemanticSnapshot,
		activeRevision: aggregateRevision(options.baseSemanticSnapshot.activeRevision),
		catalogRevision,
		desiredRevision: aggregateRevision(options.baseSemanticSnapshot.desiredRevision),
		namespaceDiscoveryByProfile,
	});
}

export function createStandaloneV1ToolPortalService(
	props: CreateStandaloneV1ToolPortalServiceProps,
): ToolPortalService<'standalone-v1'> {
	const parsedConfig = toolPortalConfigSchema.parse(props.config);
	if (parsedConfig.mode !== 'standalone') {
		throw new Error('Standalone Tool Portal service requires standalone configuration.');
	}
	const config: CreateStandaloneV1ToolPortalServiceProps['config'] = parsedConfig;
	const baseSemanticSnapshot = ToolPortalStandaloneSemanticSnapshotSchema.parse(
		props.baseSemanticSnapshot,
	);
	const namespaceDiscoveryByProfile = compileToolPortalNamespaceDiscoveryByProfile({
		mcpConfig: props.mcpConfig,
		toolPortalConfig: config,
	});
	if (
		canonicalJson(baseSemanticSnapshot.namespaceDiscoveryByProfile) !==
		canonicalJson(namespaceDiscoveryByProfile)
	) {
		throw new Error('Standalone Tool Portal namespace discovery does not match startup config.');
	}
	const semanticSnapshot = deepFreeze(
		deriveEffectiveStandaloneSemanticSnapshot({
			baseSemanticSnapshot,
			namespaceDiscoveryByProfile,
		}),
	);

	function invocationState(options: ToolPortalStandaloneServiceInvocationOptions): {
		readonly approvalToken?: string;
		readonly entries: ReturnType<typeof backendEntriesForInvocation>;
		readonly operationOptions: ToolPortalStandaloneMcpBackendReadOptions;
		readonly profileId: string;
		readonly stablePrincipal: string;
	} {
		const invocation = resolveStandaloneInvocation({ config, options, semanticSnapshot });
		return {
			...invocation,
			entries: backendEntriesForInvocation({
				backendPort: props.backendPorts.mcpProvider,
				config,
				operationOptions: invocation.operationOptions,
				profileId: invocation.profileId,
				semanticSnapshot,
			}),
		};
	}

	async function dispatchCall(propsForCall: {
		readonly authority: ToolPortalStandaloneMcpDispatchAuthority;
		readonly call: PortalCallRequest['calls'][number];
		readonly operationOptions: ToolPortalStandaloneMcpBackendReadOptions;
		readonly operationId: string;
	}): Promise<PortalCallItem> {
		try {
			const result = await props.backendPorts.mcpProvider.call(
				{ calls: [propsForCall.call] },
				{ ...propsForCall.operationOptions, dispatchAuthority: propsForCall.authority },
			);
			if (
				result.items.length === 1 &&
				result.items[0]?.id === propsForCall.call.id &&
				result.items[0].operationId === propsForCall.operationId
			) {
				return result.items[0];
			}
		} catch {
			// The provider may have dispatched before the transport failed.
		}
		return ambiguousDispatchItem({
			id: propsForCall.call.id,
			operationId: propsForCall.operationId,
			owningGeneration: semanticSnapshot.activeRevision,
		});
	}

	function callPlans(propsForPlans: {
		readonly calls: readonly PortalCallRequest['calls'][number][];
		readonly operationOptions: ToolPortalStandaloneMcpBackendReadOptions;
		readonly profileId: string;
		readonly stablePrincipal: string;
	}): readonly StandaloneCallPlan[] {
		return propsForPlans.calls.map((call) => ({
			call,
			operationId: deterministicOperationId({
				callId: call.id,
				semanticRevision: semanticSnapshot.activeRevision,
				stablePrincipal: propsForPlans.stablePrincipal,
				surfaceClass: propsForPlans.operationOptions.surfaceClass,
			}),
			policyDecision: callPolicyDecision({
				call,
				config,
				profileId: propsForPlans.profileId,
				semanticSnapshot,
				surfaceClass: propsForPlans.operationOptions.surfaceClass,
			}),
		}));
	}

	async function dispatchBatch(propsForBatch: {
		readonly approvalToken?: string;
		readonly operationOptions: ToolPortalStandaloneMcpBackendReadOptions;
		readonly plans: readonly StandaloneCallPlan[];
	}): Promise<ReadonlyMap<string, PortalCallItem>> {
		const itemsByCallId = new Map<string, PortalCallItem>();
		const directPlans = propsForBatch.plans.filter(
			(plan) => plan.policyDecision.kind === 'without-approval',
		);
		const protectedPlans = propsForBatch.plans.filter(
			(plan) => plan.policyDecision.kind === 'requires-approval',
		);
		for (const plan of propsForBatch.plans.filter(
			(candidate) => candidate.policyDecision.kind === 'denied',
		)) {
			itemsByCallId.set(
				plan.call.id,
				capabilityDeniedItem({
					id: plan.call.id,
					operationId: plan.operationId,
					owningGeneration: semanticSnapshot.activeRevision,
				}),
			);
		}
		await Promise.all(
			directPlans.map(async (plan) => {
				itemsByCallId.set(
					plan.call.id,
					await dispatchCall({
						authority: {
							backendKind: 'mcp_provider',
							fingerprint: directDispatchFingerprint({
								backendKind: 'mcp_provider',
								call: plan.call,
								principal: propsForBatch.operationOptions.origin.authenticatedEnvelope.principal,
								semanticSnapshot,
								surfaceClass: propsForBatch.operationOptions.surfaceClass,
							}),
							kind: 'without-approval',
							operationId: plan.operationId,
						},
						call: plan.call,
						operationId: plan.operationId,
						operationOptions: propsForBatch.operationOptions,
					}),
				);
			}),
		);
		if (protectedPlans.length === 0) return itemsByCallId;

		const intent = {
			authenticatedEnvelope: propsForBatch.operationOptions.origin.authenticatedEnvelope,
			protectedCalls: protectedPlans.map(({ call, operationId }) => ({ call, operationId })),
			semanticRevisions: {
				activeRevision: semanticSnapshot.activeRevision,
				bindingRevision: semanticSnapshot.bindingRevision,
				catalogRevision: semanticSnapshot.catalogRevision,
				profilePolicyRevision: semanticSnapshot.profilePolicyRevision,
				providerRevision: semanticSnapshot.providerRevision,
				schemaRevision: semanticSnapshot.schemaRevision,
			},
			surfaceClass: propsForBatch.operationOptions.surfaceClass,
		} satisfies StandaloneToolPortalApprovalBatchIntent;
		const admission = props.approvalCoordinator.reserveDispatch(
			intent,
			propsForBatch.approvalToken,
		);
		if (admission.kind !== 'dispatch-reserved') {
			for (const plan of protectedPlans) {
				itemsByCallId.set(
					plan.call.id,
					approvalAdmissionItem({
						admission,
						callId: plan.call.id,
						operationId: plan.operationId,
						owningGeneration: semanticSnapshot.activeRevision,
					}),
				);
			}
			return itemsByCallId;
		}
		const expectedOperationIds = protectedPlans.map(({ operationId }) => operationId);
		if (
			admission.reservation.batchFingerprint !==
				deriveStandaloneToolPortalApprovalBatchFingerprint(intent) ||
			canonicalJson(admission.reservation.operationIds) !== canonicalJson(expectedOperationIds)
		) {
			props.approvalCoordinator.proveNotDispatched(admission.reservation);
			for (const plan of protectedPlans) {
				itemsByCallId.set(
					plan.call.id,
					notDispatchedItem({
						id: plan.call.id,
						operationId: plan.operationId,
						owningGeneration: semanticSnapshot.activeRevision,
						reason: 'approval reservation did not match the protected batch',
					}),
				);
			}
			return itemsByCallId;
		}
		const armResult = props.approvalCoordinator.armDispatch(admission.reservation);
		if (armResult.kind !== 'dispatch-authorized') {
			for (const plan of protectedPlans) {
				itemsByCallId.set(
					plan.call.id,
					armResult.kind === 'ambiguous'
						? ambiguousDispatchItem({
								id: plan.call.id,
								operationId: plan.operationId,
								owningGeneration: semanticSnapshot.activeRevision,
							})
						: notDispatchedItem({
								id: plan.call.id,
								operationId: plan.operationId,
								owningGeneration: semanticSnapshot.activeRevision,
								reason: armResult.reason,
							}),
				);
			}
			return itemsByCallId;
		}
		await Promise.all(
			protectedPlans.map(async (plan) => {
				itemsByCallId.set(
					plan.call.id,
					await dispatchCall({
						authority: {
							approval: armResult.authority,
							backendKind: 'mcp_provider',
							kind: 'standalone-hmac-batch',
							operationId: plan.operationId,
						},
						call: plan.call,
						operationId: plan.operationId,
						operationOptions: propsForBatch.operationOptions,
					}),
				);
			}),
		);
		return itemsByCallId;
	}

	const capabilityCore: ToolPortalCapabilityCore<'standalone-v1'> = {
		call: async (request, options) => {
			const parsedRequest = PortalCallRequestSchema.parse(request);
			const invocation = invocationState(options);
			const plans = callPlans({
				calls: parsedRequest.calls,
				operationOptions: invocation.operationOptions,
				profileId: invocation.profileId,
				stablePrincipal: invocation.stablePrincipal,
			});
			const itemsByCallId = await dispatchBatch({
				...(invocation.approvalToken === undefined
					? {}
					: { approvalToken: invocation.approvalToken }),
				operationOptions: invocation.operationOptions,
				plans,
			});
			const items = plans.map((plan) => {
				const item = itemsByCallId.get(plan.call.id);
				if (item === undefined)
					throw new Error(`Tool Portal call "${plan.call.id}" has no result.`);
				return item;
			});
			return { items, ok: items.every((item) => item.status === 'ok') };
		},
		describe: async (request, options) => {
			const invocation = invocationState(options);
			return await mergeToolPortalDescribe({
				entries: invocation.entries,
				operationOptions: invocation.operationOptions,
				request: PortalDescribeRequestSchema.parse(request),
			});
		},
		list: async (request, options) => {
			const invocation = invocationState(options);
			return await mergeToolPortalList({
				entries: invocation.entries,
				operationOptions: invocation.operationOptions,
				request: PortalListRequestSchema.parse(request),
			});
		},
		search: async (request, options) => {
			const invocation = invocationState(options);
			return await mergeToolPortalSearch({
				entries: invocation.entries,
				operationOptions: invocation.operationOptions,
				request: PortalSearchRequestSchema.parse(request),
			});
		},
		semanticSnapshot,
	};
	return Object.freeze({ capabilityCore, mode: 'standalone-v1' });
}
