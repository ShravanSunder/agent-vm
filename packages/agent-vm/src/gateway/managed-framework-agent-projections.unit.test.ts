import { describe, expect, test } from 'vitest';

import { buildManagedFrameworkAgentProjectionInputs } from './managed-framework-agent-projections.js';

describe('buildManagedFrameworkAgentProjectionInputs', () => {
	test('builds two Hermes identities only from exact authored profile assignments', () => {
		// Arrange
		const configuredAgents = [{ id: 'reviewer' }, { id: 'builder' }] as const;
		const toolPortalAgents = {
			builder: { profile: 'coding' },
			reviewer: { profile: 'research' },
		};

		// Act
		const projections = buildManagedFrameworkAgentProjectionInputs({
			configuredAgents,
			frameworkKind: 'hermes',
			profilesByAgent: {
				builder: 'beta-builder',
				reviewer: 'beta-reviewer',
			},
			toolPortalAgents,
		});

		// Assert
		expect(projections).toEqual([
			{
				agentId: 'builder',
				frameworkIdentity: { kind: 'hermes', profileName: 'beta-builder' },
				toolPortalProfileId: 'coding',
			},
			{
				agentId: 'reviewer',
				frameworkIdentity: { kind: 'hermes', profileName: 'beta-reviewer' },
				toolPortalProfileId: 'research',
			},
		]);
	});

	test('rejects missing, extra, or duplicate agent assignments', () => {
		// Arrange
		const cases = [
			{
				configuredAgents: [{ id: 'alpha' }],
				frameworkKind: 'hermes' as const,
				profilesByAgent: { alpha: 'profile-alpha' },
				toolPortalAgents: { alpha: { profile: 'coding' }, beta: { profile: 'research' } },
			},
			{
				configuredAgents: [{ id: 'alpha' }, { id: 'beta' }],
				frameworkKind: 'hermes' as const,
				profilesByAgent: { alpha: 'profile-alpha', beta: 'profile-beta' },
				toolPortalAgents: { alpha: { profile: 'coding' } },
			},
			{
				configuredAgents: [{ id: 'alpha' }, { id: 'alpha' }],
				frameworkKind: 'hermes' as const,
				profilesByAgent: { alpha: 'profile-alpha' },
				toolPortalAgents: { alpha: { profile: 'coding' } },
			},
		] as const;

		// Act / Assert
		for (const candidate of cases) {
			expect(() => buildManagedFrameworkAgentProjectionInputs(candidate)).toThrow('exactly match');
		}
	});

	test('rejects missing, extra, blank, or shared Hermes profile assignments', () => {
		// Arrange
		const configuredAgents = [{ id: 'alpha' }, { id: 'beta' }] as const;
		const toolPortalAgents = {
			alpha: { profile: 'coding' },
			beta: { profile: 'research' },
		};
		const cases = [
			{ alpha: 'profile-alpha' },
			{ alpha: 'profile-alpha', beta: 'profile-beta', extra: 'profile-extra' },
			{ alpha: 'profile-alpha', beta: '  ' },
			{ alpha: 'shared-profile', beta: 'shared-profile' },
		] as const;

		// Act / Assert
		for (const profilesByAgent of cases) {
			expect(() =>
				buildManagedFrameworkAgentProjectionInputs({
					configuredAgents,
					frameworkKind: 'hermes',
					profilesByAgent,
					toolPortalAgents,
				}),
			).toThrow();
		}
	});
});
