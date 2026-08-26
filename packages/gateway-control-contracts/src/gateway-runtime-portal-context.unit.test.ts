import {
	GatewayRuntimeFrameworkKindSchema as CanonicalGatewayRuntimeFrameworkKindSchema,
	GatewayRuntimeTrustedInvocationCorrelationSchema as CanonicalGatewayRuntimeTrustedInvocationCorrelationSchema,
	GatewayRuntimeTrustedInvocationContextSchema as CanonicalGatewayRuntimeTrustedInvocationContextSchema,
	GatewayRuntimeTrustedInvocationPrincipalSchema as CanonicalGatewayRuntimeTrustedInvocationPrincipalSchema,
	GatewayRuntimeTrustedInvocationRequesterSchema as CanonicalGatewayRuntimeTrustedInvocationRequesterSchema,
} from '@agent-vm/agent-portal-sdk/contracts';
import { describe, expect, it } from 'vitest';

import {
	GatewayRuntimeFrameworkKindSchema,
	GatewayRuntimePortalSemanticSnapshotSchema,
	GatewayRuntimePortalSurfaceClassSchema,
	GatewayRuntimeTrustedInvocationCorrelationSchema,
	GatewayRuntimeTrustedInvocationContextSchema,
	GatewayRuntimeTrustedInvocationPrincipalSchema,
	GatewayRuntimeTrustedInvocationRequesterSchema,
	deriveGatewayControlStablePrincipal,
} from './index.js';

const validTrustedContext = {
	correlation: {
		runId: 'run-a',
		sessionId: 'session-a',
		toolCallId: 'tool-call-a',
	},
	principal: {
		agentId: 'agent-a',
		frameworkIdentity: { kind: 'hermes', profileName: 'agent-a' },
		profileAssignmentRevision: 'profile-assignment-7',
		toolPortalProfileId: 'engineering',
	},
	requester: { authenticatedSubjectId: 'operator-a' },
} as const;

const validSemanticSnapshot = {
	activeRevision: 'semantic-12',
	agentProjections: {
		'agent-a': {
			agentId: 'agent-a',
			frameworkIdentity: { kind: 'hermes', profileName: 'agent-a' },
			profileAssignmentRevision: 'profile-assignment-7',
			toolPortalNamespaces: [{ namespace: 'github' }],
			toolPortalProfileId: 'engineering',
		},
	},
	bindingRevision: 'bindings-4',
	catalogRevision: 'catalog-9',
	desiredRevision: 'semantic-12',
	profilePolicyRevision: 'profile-policy-6',
	projectionCohortDigest:
		'projection-cohort:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
	providerRevision: 'providers-3',
	schemaRevision: 'portal-schema-1',
	schemaVersion: 1,
	surfaceEligibilityByProfile: {
		engineering: {
			github: ['mcp', 'protected_uds'],
			sandbox: ['protected_uds'],
		},
	},
} as const;

describe('Gateway runtime Tool Portal context contracts', () => {
	it('re-exports the canonical framework and trusted-context schema instances', () => {
		// Arrange / Act / Assert
		expect(GatewayRuntimeFrameworkKindSchema).toBe(CanonicalGatewayRuntimeFrameworkKindSchema);
		expect(GatewayRuntimeTrustedInvocationPrincipalSchema).toBe(
			CanonicalGatewayRuntimeTrustedInvocationPrincipalSchema,
		);
		expect(GatewayRuntimeTrustedInvocationRequesterSchema).toBe(
			CanonicalGatewayRuntimeTrustedInvocationRequesterSchema,
		);
		expect(GatewayRuntimeTrustedInvocationCorrelationSchema).toBe(
			CanonicalGatewayRuntimeTrustedInvocationCorrelationSchema,
		);
		expect(GatewayRuntimeTrustedInvocationContextSchema).toBe(
			CanonicalGatewayRuntimeTrustedInvocationContextSchema,
		);
	});

	it('parses the complete server-attested invocation context', () => {
		// Arrange / Act
		const parsed = GatewayRuntimeTrustedInvocationContextSchema.parse(validTrustedContext);

		// Assert
		expect(parsed).toEqual(validTrustedContext);
	});

	it('permits requester and correlation to be absent without weakening the required principal', () => {
		// Arrange
		const contextWithoutOptionalMetadata = { principal: validTrustedContext.principal };

		// Act / Assert
		expect(
			GatewayRuntimeTrustedInvocationContextSchema.parse(contextWithoutOptionalMetadata),
		).toEqual(contextWithoutOptionalMetadata);
	});

	it('derives stable authority from every principal field while ignoring requester and correlation', () => {
		// Arrange
		const baseline = deriveGatewayControlStablePrincipal({
			principal: validTrustedContext.principal,
		});

		// Act / Assert
		expect(
			deriveGatewayControlStablePrincipal({
				principal: validTrustedContext.principal,
			}),
		).toBe(baseline);
		for (const changedPrincipal of [
			{ ...validTrustedContext.principal, agentId: 'agent-b' },
			{ ...validTrustedContext.principal, toolPortalProfileId: 'operations' },
			{ ...validTrustedContext.principal, profileAssignmentRevision: 'profile-assignment-8' },
			{
				...validTrustedContext.principal,
				frameworkIdentity: { kind: 'hermes' as const, profileName: 'agent-a-profile' },
			},
		]) {
			expect(deriveGatewayControlStablePrincipal({ principal: changedPrincipal })).not.toBe(
				baseline,
			);
		}
	});

	it('keeps accepted NUL-containing Hermes principals on distinct stable hashes', () => {
		// Arrange
		const firstPrincipal = GatewayRuntimeTrustedInvocationPrincipalSchema.parse({
			agentId: 'agent\0hermes',
			frameworkIdentity: { kind: 'hermes', profileName: 'profile' },
			profileAssignmentRevision: 'profile-assignment-7',
			toolPortalProfileId: 'engineering',
		});
		const secondPrincipal = GatewayRuntimeTrustedInvocationPrincipalSchema.parse({
			agentId: 'agent',
			frameworkIdentity: { kind: 'hermes', profileName: 'hermes\0profile' },
			profileAssignmentRevision: 'profile-assignment-7',
			toolPortalProfileId: 'engineering',
		});

		// Act
		const firstStablePrincipal = deriveGatewayControlStablePrincipal({
			principal: firstPrincipal,
		});
		const secondStablePrincipal = deriveGatewayControlStablePrincipal({
			principal: secondPrincipal,
		});

		// Assert
		expect(firstStablePrincipal).not.toBe(secondStablePrincipal);
	});

	it.each([
		['profile selector', { profile: 'admin' }],
		['surface selector', { surfaceClass: 'managed-uds' }],
		['credential selector', { credentialVersion: 99 }],
		['lease authority', { leaseId: 'lease-a' }],
		['path authority', { workMountDir: '/work' }],
	])('rejects a public %s field from trusted context', (_label, injectedField) => {
		// Arrange
		const untrustedContext = { ...validTrustedContext, ...injectedField };

		// Act / Assert
		expect(GatewayRuntimeTrustedInvocationContextSchema.safeParse(untrustedContext).success).toBe(
			false,
		);
	});

	it('parses the immutable controller-authored semantic snapshot', () => {
		// Arrange / Act
		const parsed = GatewayRuntimePortalSemanticSnapshotSchema.parse(validSemanticSnapshot);

		// Assert
		expect(parsed).toEqual(validSemanticSnapshot);
	});

	it.each([
		['selfRoot', '/zone/agents/agent-a/self'],
		['workRoot', '/zone/agents/agent-a/work'],
	] as const)('rejects legacy %s path authority from an agent projection', (field, value) => {
		// Arrange
		const projection = validSemanticSnapshot.agentProjections['agent-a'];
		const snapshotWithPathAuthority = {
			...validSemanticSnapshot,
			agentProjections: {
				...validSemanticSnapshot.agentProjections,
				'agent-a': { ...projection, [field]: value },
			},
		};

		// Act / Assert
		expect(
			GatewayRuntimePortalSemanticSnapshotSchema.safeParse(snapshotWithPathAuthority).success,
		).toBe(false);
	});

	it('keeps desired and active revisions distinct for readiness evaluation', () => {
		// Arrange
		const pendingSnapshot = { ...validSemanticSnapshot, desiredRevision: 'semantic-13' };

		// Act / Assert
		expect(GatewayRuntimePortalSemanticSnapshotSchema.parse(pendingSnapshot)).toEqual(
			pendingSnapshot,
		);
	});

	it('rejects unknown semantic authority fields', () => {
		// Arrange
		const untrustedSnapshot = {
			...validSemanticSnapshot,
			controllerAdminToken: 'not-snapshot-state',
		};

		// Act / Assert
		expect(GatewayRuntimePortalSemanticSnapshotSchema.safeParse(untrustedSnapshot).success).toBe(
			false,
		);
	});

	it('defines only the two server-derived Tool Portal surface classes', () => {
		// Arrange
		const supportedSurfaceClasses = ['mcp', 'protected_uds'] as const;

		// Act / Assert
		for (const surfaceClass of supportedSurfaceClasses) {
			expect(GatewayRuntimePortalSurfaceClassSchema.parse(surfaceClass)).toBe(surfaceClass);
		}
		expect(GatewayRuntimePortalSurfaceClassSchema.safeParse('public-supplied').success).toBe(false);
	});
});
