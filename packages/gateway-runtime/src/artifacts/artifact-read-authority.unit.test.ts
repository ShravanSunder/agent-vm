import { describe, expect, it, vi } from 'vitest';

import {
	createGatewayRuntimeArtifactCurrentAuthorityRegistry,
	createGatewayRuntimeArtifactReadAuthorityResolver,
	gatewayRuntimeArtifactStablePrincipalFromTrustedContext,
	type GatewayRuntimeArtifactAuthorization,
	type GatewayRuntimeArtifactCurrentAuthorityDecision,
	type GatewayRuntimeArtifactReadAuthorityResolver,
	type GatewayRuntimeArtifactReadCaller,
} from './artifact-read-authority.js';

const authorization = {
	agentId: 'agent-a',
	capability: { name: 'get_issue', namespace: 'github' },
	executionFingerprint: 'execution-fingerprint-a',
	frameworkIdentity: { kind: 'hermes', profileName: 'agent-a' },
	operationId: 'operation-a',
	owningGeneration: 'generation-a',
	profileAssignmentRevision: 'profile-assignment:agent-a:7',
	toolPortalProfileId: 'code-builder',
	surfaceClass: 'mcp',
} as const satisfies GatewayRuntimeArtifactAuthorization;

const caller = {
	principal: {
		agentId: authorization.agentId,
		frameworkIdentity: authorization.frameworkIdentity,
		profileAssignmentRevision: authorization.profileAssignmentRevision,
		toolPortalProfileId: authorization.toolPortalProfileId,
	},
	surfaceClass: 'mcp',
} as const satisfies GatewayRuntimeArtifactReadCaller;

interface ResolverFixture {
	readonly authorizeStoredArtifact: (
		authorization: GatewayRuntimeArtifactAuthorization,
	) => GatewayRuntimeArtifactCurrentAuthorityDecision;
	readonly resolver: GatewayRuntimeArtifactReadAuthorityResolver;
}

function createResolver(
	currentDecision: GatewayRuntimeArtifactCurrentAuthorityDecision,
): ResolverFixture {
	const authorizeStoredArtifact = vi.fn(() => currentDecision);
	return {
		authorizeStoredArtifact,
		resolver: createGatewayRuntimeArtifactReadAuthorityResolver({
			currentAuthority: { authorizeStoredArtifact },
		}),
	};
}

describe('Gateway runtime artifact read authority resolver', () => {
	it.each([
		{
			retirement: {
				capability: authorization.capability,
				kind: 'capability',
			} as const,
			reason: 'capability',
		},
		{
			retirement: {
				executionFingerprint: authorization.executionFingerprint,
				kind: 'execution-fingerprint',
			} as const,
			reason: 'execution-fingerprint',
		},
		{
			retirement: {
				kind: 'operation',
				operationId: authorization.operationId,
			} as const,
			reason: 'operation',
		},
		{
			retirement: {
				kind: 'owning-generation',
				owningGeneration: authorization.owningGeneration,
			} as const,
			reason: 'owning-generation',
		},
	] as const)(
		'registers exact live authority and permanently retires it by $reason',
		({ reason, retirement }) => {
			// Arrange
			const registry = createGatewayRuntimeArtifactCurrentAuthorityRegistry();

			// Act
			const beforeRegistration = registry.currentAuthority.authorizeStoredArtifact(authorization);
			const registration = registry.register(authorization);
			const whileCurrent = registry.currentAuthority.authorizeStoredArtifact(authorization);
			const retirementResult = registry.retire(retirement);
			const afterRetirement = registry.currentAuthority.authorizeStoredArtifact(authorization);
			const repeatedRegistration = registry.register(authorization);

			// Assert
			expect(beforeRegistration).toEqual({ kind: 'retired', reason: 'unregistered' });
			expect(registration).toEqual({ kind: 'registered' });
			expect(whileCurrent).toEqual({ kind: 'current' });
			expect(retirementResult).toEqual({ affectedAuthorizationCount: 1, kind: 'retired' });
			expect(afterRetirement).toEqual({ kind: 'retired', reason });
			expect(repeatedRegistration).toEqual({ kind: 'rejected', reason });
		},
	);

	it('authorizes an exact stable caller only after required live-currentness approval', () => {
		// Arrange
		const fixture = createResolver({ kind: 'current' });

		// Act
		const decision = fixture.resolver.authorize({ caller, storedAuthorization: authorization });

		// Assert
		expect(decision).toEqual({ kind: 'authorized' });
		expect(fixture.authorizeStoredArtifact).toHaveBeenCalledExactlyOnceWith(authorization);
	});

	it('derives identical artifact authority across requester and correlation changes', () => {
		// Arrange
		const principal = {
			agentId: authorization.agentId,
			frameworkIdentity: authorization.frameworkIdentity,
			profileAssignmentRevision: authorization.profileAssignmentRevision,
			toolPortalProfileId: authorization.toolPortalProfileId,
		} as const;

		// Act
		const firstAuthority = gatewayRuntimeArtifactStablePrincipalFromTrustedContext({
			correlation: { sessionId: 'session-a', toolCallId: 'tool-call-a' },
			principal,
			requester: { authenticatedSubjectId: 'subject-a' },
		});
		const laterAuthority = gatewayRuntimeArtifactStablePrincipalFromTrustedContext({
			correlation: { runId: 'run-b', sessionKey: 'session-key-b' },
			principal,
			requester: { authenticatedSubjectId: 'subject-b' },
		});

		// Assert
		expect(laterAuthority).toEqual(firstAuthority);
		expect(laterAuthority).toEqual(principal);
	});

	it.each([
		{
			caller: { ...caller, surfaceClass: 'protected_uds' as const },
			expectedReason: 'surface',
			label: 'cross-surface caller',
		},
		{
			caller: {
				...caller,
				principal: { ...caller.principal, toolPortalProfileId: 'privileged' },
			},
			expectedReason: 'principal',
			label: 'cross-principal caller',
		},
	])('denies a $label before consulting live currentness', (testCase) => {
		// Arrange
		const fixture = createResolver({ kind: 'current' });

		// Act
		const decision = fixture.resolver.authorize({
			caller: testCase.caller,
			storedAuthorization: authorization,
		});

		// Assert
		expect(decision).toEqual({ kind: 'denied', reason: testCase.expectedReason });
		expect(fixture.authorizeStoredArtifact).not.toHaveBeenCalled();
	});

	it.each(['capability', 'execution-fingerprint', 'operation', 'owning-generation'] as const)(
		'denies retired %s authority returned by the live registry',
		(reason) => {
			// Arrange
			const fixture = createResolver({ kind: 'retired', reason });

			// Act
			const decision = fixture.resolver.authorize({ caller, storedAuthorization: authorization });

			// Assert
			expect(decision).toEqual({ kind: 'denied', reason: 'current-authority' });
			expect(fixture.authorizeStoredArtifact).toHaveBeenCalledExactlyOnceWith(authorization);
		},
	);

	it('does not treat a NUL-boundary-shifted capability as registered authority', () => {
		// Arrange
		const registry = createGatewayRuntimeArtifactCurrentAuthorityRegistry();
		const registeredAuthorization = {
			...authorization,
			capability: { name: 'create', namespace: 'github\u0000issues' },
		};
		const neverRegisteredAuthorization = {
			...authorization,
			capability: { name: 'issues\u0000create', namespace: 'github' },
		};

		// Act
		const registration = registry.register(registeredAuthorization);
		const neverRegisteredDecision = registry.currentAuthority.authorizeStoredArtifact(
			neverRegisteredAuthorization,
		);

		// Assert
		expect(registration).toEqual({ kind: 'registered' });
		expect(neverRegisteredDecision).toEqual({ kind: 'retired', reason: 'unregistered' });
	});

	it('does not treat a NUL-boundary-shifted principal tuple as registered authority', () => {
		// Arrange
		const registry = createGatewayRuntimeArtifactCurrentAuthorityRegistry();
		const registeredAuthorization = {
			...authorization,
			agentId: 'agent-a\u0000profile-prefix',
			frameworkIdentity: {
				kind: 'hermes' as const,
				profileName: 'agent-a\u0000profile-prefix',
			},
			toolPortalProfileId: 'code-builder',
		};
		const neverRegisteredAuthorization = {
			...authorization,
			agentId: 'agent-a',
			toolPortalProfileId: 'profile-prefix\u0000code-builder',
		};

		// Act
		const registration = registry.register(registeredAuthorization);
		const neverRegisteredDecision = registry.currentAuthority.authorizeStoredArtifact(
			neverRegisteredAuthorization,
		);

		// Assert
		expect(registration).toEqual({ kind: 'registered' });
		expect(neverRegisteredDecision).toEqual({ kind: 'retired', reason: 'unregistered' });
	});
});
