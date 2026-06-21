import type { JsonObject } from '@agent-vm/agent-portal-sdk';

import {
	ControllerDispatchIntentSchema,
	type ControllerDispatchIntent,
} from '../controller-dispatch-boundary/models/controller-dispatch-intent-schema.js';
import {
	CredentialedRunnerRequestSchema,
	type CredentialedRunnerRequest,
} from '../credentialed-runner-boundary/models/credentialed-runner-request-schema.js';
import {
	ManagedVmExecRequestSchema,
	type ManagedVmExecRequest,
} from '../credentialed-runner-boundary/models/managed-vm-exec-request-schema.js';

export interface CreateControllerDispatchIntentFixtureProps {
	readonly agentId?: string;
	readonly arguments?: JsonObject;
	readonly auditCorrelationId?: string;
	readonly namespace?: string;
	readonly profileId?: string;
	readonly toolName?: string;
}

export interface CreateManagedVmExecRequestFixtureProps {
	readonly argv?: readonly string[];
	readonly cwdPath?: string;
	readonly executablePath?: string;
	readonly timeoutMs?: number;
}

export interface CreateCredentialedRunnerRequestFixtureProps
	extends CreateControllerDispatchIntentFixtureProps, CreateManagedVmExecRequestFixtureProps {
	readonly credentialProfileId?: string;
}

export function createControllerDispatchIntentFixture(
	props: CreateControllerDispatchIntentFixtureProps = {},
): ControllerDispatchIntent {
	return ControllerDispatchIntentSchema.parse({
		auditCorrelationId: props.auditCorrelationId ?? 'audit-1',
		canonicalArguments: props.arguments ?? {},
		capability: {
			namespace: props.namespace ?? 'github',
			toolName: props.toolName ?? 'get_issue',
		},
		trustedScope: {
			agentId: props.agentId ?? 'agent-1',
			profileId: props.profileId ?? 'code-builder',
		},
	});
}

export function createManagedVmExecRequestFixture(
	props: CreateManagedVmExecRequestFixtureProps = {},
): ManagedVmExecRequest {
	return ManagedVmExecRequestSchema.parse({
		argv: props.argv ?? ['issue', 'view', '1'],
		cwd: { kind: 'fixed', path: props.cwdPath ?? '/work' },
		env: {},
		executablePath: props.executablePath ?? '/usr/local/bin/gh',
		pty: false,
		shellMode: 'none',
		stderr: 'stream',
		stderrMaxBytes: 1024,
		stdout: 'stream',
		stdoutMaxBytes: 1024,
		timeoutMs: props.timeoutMs ?? 30_000,
	});
}

export function createCredentialedRunnerRequestFixture(
	props: CreateCredentialedRunnerRequestFixtureProps = {},
): CredentialedRunnerRequest {
	const dispatch = createControllerDispatchIntentFixture(props);
	return CredentialedRunnerRequestSchema.parse({
		credentialProfileId: props.credentialProfileId ?? 'github-readonly',
		dispatch,
		invocation: {
			artifacts: {
				maxArtifacts: 0,
				mode: 'none',
				noFollowRequired: true,
			},
			argv: props.argv ?? ['issue', 'view', '1'],
			cancellation: {
				onCancel: 'close_vm',
				timeoutMs: props.timeoutMs ?? 30_000,
			},
			cwd: { kind: 'fixed', path: props.cwdPath ?? '/work' },
			egress: {
				allowedHosts: ['api.github.com'],
				denyEndpointOverrides: true,
			},
			environment: {
				allowedVariables: [],
				deniedPatterns: [],
				mode: 'empty',
			},
			executablePath: props.executablePath ?? '/usr/local/bin/gh',
			fingerprint: {
				agentId: dispatch.trustedScope.agentId,
				artifactIntentHash: 'artifact-intent-hash',
				backendBindingRevision: 'backend-binding-revision',
				canonicalArgumentHash: 'canonical-argument-hash',
				capability: dispatch.capability,
				catalogRevision: 'catalog-revision',
				custodyMode: 'ephemeral_material',
				egressPolicyHash: 'egress-policy-hash',
				executableTemplateRevision: 'executable-template-revision',
				outputPolicyHash: 'output-policy-hash',
				policyRevision: 'policy-revision',
			},
			output: {
				modelVisibleStderr: 'safe_summary',
				redactionProfile: 'default',
				stderrMaxBytes: 1024,
				stdoutMaxBytes: 1024,
				truncationMode: 'truncate',
			},
		},
	});
}
