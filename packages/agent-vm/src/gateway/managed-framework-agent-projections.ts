import type { GatewayRuntimeFrameworkIdentity } from '@agent-vm/agent-portal-sdk/contracts';
import type { ManagedToolPortalConfig } from '@agent-vm/config-contracts';
import type { ManagedAgentProjectionInput } from '@agent-vm/gateway-control-contracts';

interface BuildManagedFrameworkAgentProjectionInputsBaseProps {
	readonly configuredAgents: readonly Readonly<{ readonly id: string }>[];
	readonly toolPortalAgents: ManagedToolPortalConfig['agents'];
}

export type BuildManagedFrameworkAgentProjectionInputsProps =
	| (BuildManagedFrameworkAgentProjectionInputsBaseProps & {
			readonly frameworkKind: 'openclaw';
	  })
	| (BuildManagedFrameworkAgentProjectionInputsBaseProps & {
			readonly frameworkKind: 'hermes';
			readonly profilesByAgent: Readonly<Record<string, string>>;
	  });

function sameExactStringSet(
	leftValues: readonly string[],
	rightValues: readonly string[],
): boolean {
	const sortedLeftValues = [...leftValues].toSorted();
	const sortedRightValues = [...rightValues].toSorted();
	return (
		new Set(leftValues).size === leftValues.length &&
		new Set(rightValues).size === rightValues.length &&
		sortedLeftValues.length === sortedRightValues.length &&
		sortedLeftValues.every((value, index) => value === sortedRightValues[index])
	);
}

function assertExactAgentAssignments(props: {
	readonly configuredAgentIds: readonly string[];
	readonly toolPortalAgentIds: readonly string[];
}): void {
	if (!sameExactStringSet(props.configuredAgentIds, props.toolPortalAgentIds)) {
		throw new Error(
			'Managed framework agents must exactly match configured Tool Portal agent assignments.',
		);
	}
}

function requireExactHermesProfiles(props: {
	readonly configuredAgentIds: readonly string[];
	readonly profilesByAgent: Readonly<Record<string, string>>;
}): Readonly<Record<string, string>> {
	const profileAgentIds = Object.keys(props.profilesByAgent);
	if (!sameExactStringSet(props.configuredAgentIds, profileAgentIds)) {
		throw new Error(
			'Managed Hermes profilesByAgent must exactly match configured managed agent assignments.',
		);
	}
	const profileNames = Object.values(props.profilesByAgent);
	if (profileNames.some((profileName) => profileName.trim().length === 0)) {
		throw new Error('Managed Hermes profilesByAgent must not contain a blank profile name.');
	}
	if (new Set(profileNames).size !== profileNames.length) {
		throw new Error('Managed Hermes profilesByAgent must assign one distinct profile per agent.');
	}
	return props.profilesByAgent;
}

function requireHermesProfileName(
	profilesByAgent: Readonly<Record<string, string>> | undefined,
	agentId: string,
): string {
	const profileName = profilesByAgent?.[agentId];
	if (profileName === undefined) {
		throw new Error(`Managed Hermes agent '${agentId}' requires an authored profile assignment.`);
	}
	return profileName;
}

function buildManagedFrameworkIdentity(options: {
	readonly agentId: string;
	readonly frameworkKind: 'hermes' | 'openclaw';
	readonly hermesProfilesByAgent: Readonly<Record<string, string>> | undefined;
}): GatewayRuntimeFrameworkIdentity {
	return options.frameworkKind === 'openclaw'
		? Object.freeze({ agentId: options.agentId, kind: 'openclaw' })
		: Object.freeze({
				kind: 'hermes',
				profileName: requireHermesProfileName(options.hermesProfilesByAgent, options.agentId),
			});
}

export function buildManagedFrameworkAgentProjectionInputs(
	props: BuildManagedFrameworkAgentProjectionInputsProps,
): readonly ManagedAgentProjectionInput[] {
	const configuredAgentIds = props.configuredAgents.map((agent) => agent.id);
	assertExactAgentAssignments({
		configuredAgentIds,
		toolPortalAgentIds: Object.keys(props.toolPortalAgents),
	});
	const hermesProfilesByAgent =
		props.frameworkKind === 'hermes'
			? requireExactHermesProfiles({
					configuredAgentIds,
					profilesByAgent: props.profilesByAgent,
				})
			: undefined;

	return Object.freeze(
		[...configuredAgentIds].toSorted().map((agentId): ManagedAgentProjectionInput => {
			const toolPortalAgent = props.toolPortalAgents[agentId];
			if (toolPortalAgent === undefined) {
				throw new Error(`Managed framework agent '${agentId}' requires a Tool Portal assignment.`);
			}
			const frameworkIdentity = buildManagedFrameworkIdentity({
				agentId,
				frameworkKind: props.frameworkKind,
				hermesProfilesByAgent,
			});
			return Object.freeze({
				agentId,
				frameworkIdentity,
				toolPortalProfileId: toolPortalAgent.profile,
			});
		}),
	);
}
