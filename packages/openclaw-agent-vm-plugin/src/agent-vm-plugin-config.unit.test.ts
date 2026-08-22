import { describe, expect, it } from 'vitest';

import { resolveAgentVmPluginConfig } from './agent-vm-plugin-config.js';

function createToolPortalConfig(): {
	readonly attachment: {
		readonly attachmentGeneration: number;
		readonly clientKind: string;
		readonly configuredAgentIds: readonly string[];
		readonly frameworkEpoch: string;
		readonly gatewayEpoch: string;
		readonly protocolVersion: number;
		readonly projectionCohortDigest: string;
		readonly runtimeEpoch: string;
		readonly schemaVersion: number;
	};
	readonly agentProjections: Readonly<
		Record<
			string,
			{
				readonly agentId: string;
				readonly frameworkIdentity: {
					readonly agentId: string;
					readonly kind: 'openclaw';
				};
				readonly profileAssignmentRevision: string;
				readonly toolPortalNamespaces: readonly string[];
				readonly toolPortalProfileId: string;
			}
		>
	>;
} {
	return {
		agentProjections: {
			'agent-a': {
				agentId: 'agent-a',
				frameworkIdentity: { agentId: 'agent-a', kind: 'openclaw' },
				profileAssignmentRevision: 'profile-revision-a',
				toolPortalNamespaces: [{ namespace: 'filesystem' }, { namespace: 'github' }],
				toolPortalProfileId: 'profile-a',
			},
			'agent-b': {
				agentId: 'agent-b',
				frameworkIdentity: { agentId: 'agent-b', kind: 'openclaw' },
				profileAssignmentRevision: 'profile-revision-b',
				toolPortalNamespaces: [{ namespace: 'filesystem' }, { namespace: 'github' }],
				toolPortalProfileId: 'profile-b',
			},
		},
		attachment: {
			attachmentGeneration: 7,
			clientKind: 'openclaw-managed-plugin',
			configuredAgentIds: ['agent-a', 'agent-b'],
			frameworkEpoch: 'openclaw-epoch-4',
			gatewayEpoch: 'gateway-epoch-3',
			protocolVersion: 1,
			projectionCohortDigest:
				'projection-cohort:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			runtimeEpoch: 'runtime-epoch-5',
			schemaVersion: 1,
		},
	};
}

describe('resolveAgentVmPluginConfig', () => {
	it('parses immutable multi-agent Tool Portal attachment inputs', () => {
		const toolPortal = createToolPortalConfig();
		const resolved = resolveAgentVmPluginConfig({
			toolPortal,
			zoneId: 'shravan',
		});

		expect(resolved).toEqual({
			toolPortal,
			zoneId: 'shravan',
		});
		expect(Object.isFrozen(resolved.toolPortal)).toBe(true);
		expect(Object.isFrozen(resolved.toolPortal?.attachment)).toBe(true);
		expect(Object.isFrozen(resolved.toolPortal?.attachment.configuredAgentIds)).toBe(true);
		expect(Object.isFrozen(resolved.toolPortal?.agentProjections)).toBe(true);
		expect(Object.isFrozen(resolved.toolPortal?.agentProjections['agent-a'])).toBe(true);
	});

	it('does not require Tool Portal config outside the managed adapter path', () => {
		expect(resolveAgentVmPluginConfig({ zoneId: 'shravan' })).toEqual({
			zoneId: 'shravan',
		});
	});

	it('rejects the removed plugin-owned control session authority surface', () => {
		expect(() =>
			resolveAgentVmPluginConfig({
				controlSession: {
					bootId: 'boot-a',
					controllerEpoch: 'epoch-a',
					generationId: 'generation-a',
					peerId: 'gateway-shravan',
					processEpoch: 'process-a',
					verifierPublicKeyPem: 'public-key',
				},
				zoneId: 'shravan',
			}),
		).toThrow("Gondolin plugin config does not accept field 'controlSession'.");
	});

	it('rejects stale local Tool Portal and caller-context authority config', () => {
		expect(() =>
			resolveAgentVmPluginConfig({
				toolPortal: {
					configDir: '/home/openclaw/.openclaw/cache/tool-portal-effective',
				},
				zoneId: 'shravan',
			}),
		).toThrow("Gondolin plugin toolPortal does not accept field 'configDir'.");
	});

	it('rejects duplicate, missing, and mismatched configured-agent projections', () => {
		const duplicateAgents = createToolPortalConfig();
		expect(() =>
			resolveAgentVmPluginConfig({
				toolPortal: {
					...duplicateAgents,
					attachment: {
						...duplicateAgents.attachment,
						configuredAgentIds: ['agent-a', 'agent-a'],
					},
				},
				zoneId: 'shravan',
			}),
		).toThrow('Gondolin plugin toolPortal attachment is invalid.');

		const missingProjection = createToolPortalConfig();
		const agentAProjection = missingProjection.agentProjections['agent-a'];
		if (agentAProjection === undefined) {
			throw new Error("Expected fixture projection for 'agent-a'.");
		}
		expect(() =>
			resolveAgentVmPluginConfig({
				toolPortal: {
					...missingProjection,
					agentProjections: {
						'agent-a': agentAProjection,
					},
				},
				zoneId: 'shravan',
			}),
		).toThrow('Gondolin plugin toolPortal agent sets must match exactly.');

		const extraProjection = createToolPortalConfig();
		expect(() =>
			resolveAgentVmPluginConfig({
				toolPortal: {
					...extraProjection,
					agentProjections: {
						...extraProjection.agentProjections,
						'agent-c': {
							agentId: 'agent-c',
							frameworkIdentity: { agentId: 'agent-c', kind: 'openclaw' },
							profileAssignmentRevision: 'profile-revision-c',
							toolPortalNamespaces: [{ namespace: 'filesystem' }, { namespace: 'github' }],
							toolPortalProfileId: 'profile-c',
						},
					},
				},
				zoneId: 'shravan',
			}),
		).toThrow('Gondolin plugin toolPortal agent sets must match exactly.');
	});

	it.each([
		{ fieldName: 'selfRoot', fieldValue: '/zone/agents/agent-a/self' },
		{ fieldName: 'workRoot', fieldValue: '/zone/agents/agent-a/work' },
	] as const)(
		'rejects removed projection authority field $fieldName',
		({ fieldName, fieldValue }) => {
			const config = createToolPortalConfig();
			expect(() =>
				resolveAgentVmPluginConfig({
					toolPortal: {
						...config,
						agentProjections: {
							...config.agentProjections,
							'agent-a': {
								...config.agentProjections['agent-a'],
								[fieldName]: fieldValue,
							},
						},
					},
					zoneId: 'shravan',
				}),
			).toThrow(
				"Gondolin plugin toolPortal agentProjections requires a valid projection for agent 'agent-a'.",
			);
		},
	);

	it('rejects missing and mismatched framework projection identity', () => {
		const config = createToolPortalConfig();
		const agentAProjection = config.agentProjections['agent-a'];
		if (agentAProjection === undefined) {
			throw new Error("Expected fixture projection for 'agent-a'.");
		}
		const { frameworkIdentity: _omittedFrameworkIdentity, ...projectionWithoutFrameworkIdentity } =
			agentAProjection;

		expect(() =>
			resolveAgentVmPluginConfig({
				toolPortal: {
					...config,
					agentProjections: {
						...config.agentProjections,
						'agent-a': projectionWithoutFrameworkIdentity,
					},
				},
				zoneId: 'shravan',
			}),
		).toThrow(
			"Gondolin plugin toolPortal agentProjections requires a valid projection for agent 'agent-a'.",
		);

		expect(() =>
			resolveAgentVmPluginConfig({
				toolPortal: {
					...config,
					agentProjections: {
						...config.agentProjections,
						'agent-a': {
							...agentAProjection,
							frameworkIdentity: { agentId: 'agent-b', kind: 'openclaw' },
						},
					},
				},
				zoneId: 'shravan',
			}),
		).toThrow(
			"Gondolin plugin toolPortal agentProjections identity does not match agent 'agent-a'.",
		);
	});

	it('rejects non-OpenClaw, incomplete, and authority-bearing attachment metadata', () => {
		const hermesAttachment = createToolPortalConfig();
		expect(() =>
			resolveAgentVmPluginConfig({
				toolPortal: {
					...hermesAttachment,
					attachment: {
						...hermesAttachment.attachment,
						clientKind: 'hermes-managed-plugin',
					},
				},
				zoneId: 'shravan',
			}),
		).toThrow('Gondolin plugin toolPortal requires openclaw-managed-plugin clientKind.');

		const incompleteAttachment = createToolPortalConfig();
		expect(() =>
			resolveAgentVmPluginConfig({
				toolPortal: {
					...incompleteAttachment,
					attachment: {
						attachmentGeneration: 7,
						clientKind: 'openclaw-managed-plugin',
						configuredAgentIds: ['agent-a', 'agent-b'],
						frameworkEpoch: 'openclaw-epoch-4',
						gatewayEpoch: 'gateway-epoch-3',
						runtimeEpoch: 'runtime-epoch-5',
						schemaVersion: 1,
					},
				},
				zoneId: 'shravan',
			}),
		).toThrow('Gondolin plugin toolPortal attachment is invalid.');

		const authorityBearing = createToolPortalConfig();
		expect(() =>
			resolveAgentVmPluginConfig({
				toolPortal: {
					...authorityBearing,
					attachment: {
						...authorityBearing.attachment,
						authority: 'admin',
					},
				},
				zoneId: 'shravan',
			}),
		).toThrow('Gondolin plugin toolPortal attachment is invalid.');
	});

	it('rejects malformed agent projections', () => {
		const config = createToolPortalConfig();
		expect(() =>
			resolveAgentVmPluginConfig({
				toolPortal: {
					...config,
					agentProjections: {
						...config.agentProjections,
						'agent-a': {
							...config.agentProjections['agent-a'],
							profileAssignmentRevision: '',
						},
					},
				},
				zoneId: 'shravan',
			}),
		).toThrow(
			"Gondolin plugin toolPortal agentProjections requires a valid projection for agent 'agent-a'.",
		);
	});

	it('rejects removed root authority fields and unknown fields', () => {
		expect(() =>
			resolveAgentVmPluginConfig({
				profileId: 'gpu',
				zoneId: 'shravan',
			}),
		).toThrow("Gondolin plugin config does not accept field 'profileId'.");
		expect(() =>
			resolveAgentVmPluginConfig({
				controllerUrl: 'http://controller.vm.host:18800',
				zoneId: 'shravan',
			}),
		).toThrow('Gondolin plugin config no longer accepts controllerUrl.');
		expect(() =>
			resolveAgentVmPluginConfig({
				zoneGitTokenEnv: 'AGENT_VM_ZONE_GIT_TOKEN',
				zoneId: 'shravan',
			}),
		).toThrow('Gondolin plugin config no longer accepts zone git token fields.');
		expect(() =>
			resolveAgentVmPluginConfig({
				extraRoot: true,
				zoneId: 'shravan',
			}),
		).toThrow("Gondolin plugin config does not accept field 'extraRoot'.");
	});

	it('rejects missing and empty required strings', () => {
		expect(() => resolveAgentVmPluginConfig({})).toThrow('Gondolin plugin config requires zoneId.');
		expect(() => resolveAgentVmPluginConfig({ zoneId: '' })).toThrow(
			'Gondolin plugin config requires non-empty zoneId.',
		);
	});

	it.each([
		{ fieldName: 'toolPortal', value: true },
		{ fieldName: 'toolPortal', value: null },
		{ fieldName: 'toolPortal', value: 'portal' },
		{ fieldName: 'toolPortal', value: ['portal'] },
	] satisfies readonly {
		readonly fieldName: 'toolPortal';
		readonly value: boolean | null | string | readonly string[];
	}[])('rejects non-object $fieldName config', ({ fieldName, value }) => {
		expect(() =>
			resolveAgentVmPluginConfig({
				[fieldName]: value,
				zoneId: 'shravan',
			}),
		).toThrow(`Gondolin plugin ${fieldName} must be an object when present.`);
	});
});
