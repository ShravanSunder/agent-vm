import { createAccessAssessor } from '@agent-collaboration/tool-access/authorization';
import {
	assessAccessInput,
	type AssessAccessInput,
} from '@agent-collaboration/tool-access/contracts';
import { projectManagedAccessProfile } from '@agent-vm/gateway-runtime/managed-tool-engine/access-profile-projection.js';
import {
	semanticSnapshot,
	toolPortalConfig,
} from '@agent-vm/gateway-runtime/managed-tool-engine/managed-profile-test-fixture.js';
import { describe, expect, it } from 'vitest';

// Oracle: Program Design §1 and J13. Fixture is the existing managed three-backend configuration.
function assessmentInput(
	namespace: string,
	tool: string,
	surface: 'mcp' | 'protected_uds',
): AssessAccessInput {
	const revision = { owner: 'controller', revision: 'v1' };
	const surfaces: Readonly<Record<string, readonly ('mcp' | 'protected_uds')[]>> =
		semanticSnapshot.surfaceEligibilityByProfile['gate-c-profile'];
	return assessAccessInput.parse({
		capability: { namespace, tool },
		surface,
		call: { arguments: {}, account: null, digest: 'a'.repeat(64) },
		facts: {
			workspace: { kind: 'not-configured' },
			assignment: {
				profile: projectManagedAccessProfile({
					config: toolPortalConfig,
					profileId: 'gate-c-profile',
				}),
				profileRevision: revision,
				revision,
			},
			surface: { eligible: surfaces[namespace] ?? [], snapshot: revision },
			accounts: [],
			upstream: { status: 'available', credentialNeed: 'none', binding: revision },
		},
	});
}

describe('managed access profile projection', () => {
	const assess = createAccessAssessor({
		workspaceLayer: 'not-configured',
		config: { owner: 'controller', revision: 'config:1' },
	});
	it.each([
		['github', 'get_issue', 'usable'],
		['controller', 'push_branch', 'approval-each-call'],
		['sandbox', 'exec', 'approval-each-call'],
	] as const)('preserves the %s decision for %s', (namespace, tool, kind) => {
		const result = assess(assessmentInput(namespace, tool, 'protected_uds'));
		expect(result).toMatchObject({
			kind: 'assessed',
			assessment: { kind: 'fixed', state: { kind } },
		});
	});
	it('keeps the paired surface refusal', () => {
		expect(assess(assessmentInput('github', 'get_issue', 'mcp'))).toMatchObject({
			kind: 'assessed',
			assessment: {
				surface: 'mcp',
				state: { kind: 'not-usable', firstUnmet: 'not-given-to-agent' },
			},
		});
	});
	it('drops execution bindings rather than moving them into the projection', () => {
		const projection = projectManagedAccessProfile({
			config: toolPortalConfig,
			profileId: 'gate-c-profile',
		});
		expect(projection.namespaces.sandbox?.operations.exec).toEqual({
			cliPolicy: null,
			googleCommands: null,
		});
		expect(JSON.stringify(projection)).not.toContain('/usr/bin/true');
		expect(JSON.stringify(projection)).not.toContain('sandbox_ssh');
	});
});
