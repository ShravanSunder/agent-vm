import {
	mcpPortalProfileDefinitionSchema,
	type McpPortalProfileDefinition,
} from '@agent-collaboration/tool-access/contracts';
import { expect, it } from 'vitest';

import {
	assessedProxyProfile,
	resolveHostedProxyProfile,
	resolveHostedCallerProfiles,
} from '#tool-host-core/workspace-engines/proxy-profile-policy';

function profile(
	available: readonly string[],
	withoutApproval: readonly string[],
): McpPortalProfileDefinition {
	return mcpPortalProfileDefinitionSchema.parse({
		namespaces: {
			provider: {
				tools: { allow: available },
				calls: {
					withoutApproval: { allow: withoutApproval },
					requiresApproval: { allow: available.filter((tool) => !withoutApproval.includes(tool)) },
				},
			},
		},
	});
}
function decision(profiles: readonly McpPortalProfileDefinition[], tool: string): unknown {
	return assessedProxyProfile({
		profileId: 'effective',
		profiles: profiles.map((entry) => ({
			profile: entry,
			resolved: resolveHostedProxyProfile(entry),
		})),
		tool: { namespace: 'provider', toolName: tool, inputSchema: { type: 'object' } },
		capability: { namespace: 'provider', tool },
	});
}
function expectedProfile(available: boolean, withoutApproval: boolean, tool: string): unknown {
	return {
		profileId: 'effective',
		namespaces: {
			provider: {
				backendKind: 'mcp_provider',
				tools: { allow: available ? [tool] : [], deny: [] },
				calls: {
					kind: 'selectors',
					withoutApproval: { allow: available && withoutApproval ? [tool] : [], deny: [] },
					requiresApproval: { allow: available && !withoutApproval ? [tool] : [], deny: [] },
				},
				operations: {},
			},
		},
	};
}
it('clips a partly wider persona on a shared tool and its exclusive tool, keeping either approval requirement', () => {
	// Arrange: the named persona adds exclusive and waives approval on shared.
	const defaultProfile = profile(['shared'], []);
	const namedProfile = profile(['shared', 'exclusive'], ['shared', 'exclusive']);
	// Act / Assert: both independent bounds apply to every effective call.
	expect(decision([defaultProfile, namedProfile], 'shared')).toEqual(
		expectedProfile(true, false, 'shared'),
	);
	expect(decision([defaultProfile, namedProfile], 'exclusive')).toEqual(
		expectedProfile(false, false, 'exclusive'),
	);
	expect(decision([namedProfile, defaultProfile], 'shared')).toEqual(
		expectedProfile(true, false, 'shared'),
	);
});
it('never widens either randomly generated profile over available tools and approval-free calls', () => {
	// Arrange: a reproducible PRNG generates independently varied policies, including exclusive tools.
	let seed = 1234567;
	function nextBit(): boolean {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		return (seed >>> 29) % 2 === 0;
	}
	const tools = ['shared', 'default-only', 'persona-only', 'neither'];
	for (let sample = 0; sample < 200; sample += 1) {
		const defaultTools = tools.filter(nextBit);
		const namedTools = tools.filter(nextBit);
		const defaultFree = defaultTools.filter(nextBit);
		const namedFree = namedTools.filter(nextBit);
		for (const tool of tools) {
			const available = defaultTools.includes(tool) && namedTools.includes(tool);
			const free = defaultFree.includes(tool) && namedFree.includes(tool);
			expect(
				decision([profile(defaultTools, defaultFree), profile(namedTools, namedFree)], tool),
			).toEqual(expectedProfile(available, free, tool));
		}
	}
});

it('undefined named personas allow nothing, while bots use only their named profile', () => {
	const profiles = {
		base: profile(['shared'], []),
		wide: profile(['shared', 'exclusive'], ['shared', 'exclusive']),
	};
	const session = {
		kind: 'fleetHarnessSession',
		session_ref: {
			installation: '33333333-3333-4333-8333-333333333333',
			harness_endpoint: 'codex-local',
			conversation_id: 'session-one',
		},
		machine_environment: { kind: 'physical' },
		project_id: 'project-one',
		isolation: { kind: 'host', instance_id: 'launch-one' },
	} as const;
	expect(
		resolveHostedCallerProfiles({
			principal: session,
			persona: { kind: 'named', name: 'missing' },
			sessionDefaultProfile: 'base',
			profiles,
		}),
	).toBeUndefined();
	expect(
		resolveHostedCallerProfiles({
			principal: session,
			persona: { kind: 'sessionDefault' },
			sessionDefaultProfile: 'base',
			profiles,
		}),
	).toHaveLength(1);
	const botProfiles = resolveHostedCallerProfiles({
		principal: { kind: 'bot', bot_id: '22222222-2222-4222-8222-222222222222' },
		persona: { kind: 'named', name: 'wide' },
		sessionDefaultProfile: 'base',
		profiles,
	});
	expect(botProfiles).toHaveLength(1);
	expect(botProfiles?.[0]?.profile).toEqual(profiles.wide);
});
