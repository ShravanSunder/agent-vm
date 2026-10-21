import { directDispatchFingerprint as originalFingerprint } from '@agent-vm/tool-portal/policy-comparison';
import { expect, it } from 'vitest';

import {
	deriveStandaloneDirectFingerprint,
	deriveStandaloneOperationId,
} from '#node-host/standalone-tool-portal/standalone-dispatch-identity';

it('keeps the old canonical direct fingerprint with exactly the six semantic revisions', () => {
	const snapshot = {
		activeRevision: 'active:1',
		bindingRevision: 'binding:1',
		catalogRevision: 'catalog:1',
		profilePolicyRevision: 'policy:1',
		providerRevision: 'provider:1',
		schemaRevision: 'schema:1',
		desiredRevision: 'active:1',
		agentProjections: {},
		namespaceDiscoveryByProfile: {},
		surfaceEligibilityByProfile: {},
		schemaVersion: 1 as const,
	};
	const call = { id: 'read', namespace: 'example', name: 'read', arguments: { ä: 42, z: 1 } };
	const principal = {
		agentId: 'agent-a',
		toolPortalProfileId: 'builder',
		profileAssignmentRevision: 'assignment:1',
		credentialVersion: 1,
	};
	const expected = originalFingerprint({
		backendKind: 'mcp_provider',
		call,
		principal,
		semanticSnapshot: snapshot,
		surfaceClass: 'mcp',
	});
	expect(
		deriveStandaloneDirectFingerprint({
			call,
			principal,
			semanticSnapshot: snapshot,
			surfaceClass: 'mcp',
		}),
	).toBe(expected);
	const id = deriveStandaloneOperationId({
		callId: call.id,
		semanticRevision: snapshot.activeRevision,
		stablePrincipal: 'fixture',
		surfaceClass: 'mcp',
	});
	expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
});
