import type { JsonObject } from '@agent-vm/agent-portal-sdk';
import type {
	ControllerHostActionRequest,
	ValidatedCliInvocation,
} from '@agent-vm/controller-execution-contracts';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
	createControllerHostActionRegistry,
	defineControllerHostAction,
	type ControllerHostActionTrustedAuthority,
} from '../controller/runner/controller-host-action-registry.js';

const RefreshPackageMetadataInputSchema = z
	.object({ packageName: z.string().startsWith('@agent-vm/') })
	.strict();

const validatedInvocation = {
	artifacts: { maxArtifacts: 0, mode: 'none', noFollowRequired: true },
	argv: ['view'],
	cancellation: { onCancel: 'abort_process', timeoutMs: 10_000 },
	cwd: { kind: 'fixed', path: '/var/lib/agent-vm' },
	egress: { allowedHosts: ['registry.npmjs.org'], denyEndpointOverrides: true },
	environment: { allowedVariables: [], deniedPatterns: [], mode: 'empty' },
	executablePath: '/usr/local/bin/npm',
	fingerprint: {
		agentId: 'agent-a',
		artifactIntentHash: 'artifact-hash',
		backendBindingRevision: 'binding-revision',
		canonicalArgumentHash: 'argument-hash',
		capability: { name: 'refresh-package-metadata', namespace: 'controller' },
		catalogRevision: 'catalog-revision',
		custodyMode: 'controller_durable_state',
		egressPolicyHash: 'egress-hash',
		executableTemplateRevision: 'executable-revision',
		outputPolicyHash: 'output-hash',
		policyRevision: 'policy-revision',
	},
	output: {
		modelVisibleStderr: 'safe_summary',
		redactionProfile: 'controller-safe',
		stderrMaxBytes: 4096,
		stdoutMaxBytes: 4096,
		truncationMode: 'truncate',
	},
} as const satisfies ValidatedCliInvocation;

const completeTrustedAuthority = {
	credentials: [
		{
			credentialProfileId: 'registry-read',
			custodyMode: 'controller_durable_state',
		},
	],
	invocation: validatedInvocation,
	mandatoryArgvPrefix: ['view'],
	target: { kind: 'controller-host', osContextId: 'agent-vm-controller' },
} as const satisfies ControllerHostActionTrustedAuthority;

const executeRefreshPackageMetadata = vi.fn(
	async ({ input }: { readonly input: { readonly packageName: string } }) =>
		({ packageName: input.packageName }) satisfies JsonObject,
);

const registeredAction = defineControllerHostAction({
	actionName: 'refresh-package-metadata',
	execute: executeRefreshPackageMetadata,
	inputSchema: RefreshPackageMetadataInputSchema,
});

const validRequest = {
	canonicalArguments: { packageName: '@agent-vm/agent-vm' },
	dispatch: {
		auditCorrelationId: 'audit-operation-a',
		canonicalArguments: { packageName: '@agent-vm/agent-vm' },
		capability: { name: 'refresh-package-metadata', namespace: 'controller' },
		trustedScope: { agentId: 'agent-a', profileId: 'standard' },
	},
	hostActionName: 'refresh-package-metadata',
} as const satisfies ControllerHostActionRequest;

describe('gateway runtime typed controller host actions', () => {
	it('executes a registered typed action only after complete controller authority recomputation', async () => {
		const authorizationEvents: string[] = [];
		const registry = createControllerHostActionRegistry({
			actions: [registeredAction],
			recomputeAuthorization: async () => {
				authorizationEvents.push('authorization-recomputed');
				return completeTrustedAuthority;
			},
		});

		await expect(registry.execute(validRequest)).resolves.toEqual({
			binding: {
				fingerprint: JSON.stringify(validatedInvocation.fingerprint),
				operationId: 'audit-operation-a',
			},
			certainty: 'proven',
			completion: 'succeeded',
			diagnostics: [],
			kind: 'completed',
			retryClass: 'forbidden',
			value: { packageName: '@agent-vm/agent-vm' },
		});
		expect(authorizationEvents).toEqual(['authorization-recomputed']);
		expect(executeRefreshPackageMetadata).toHaveBeenCalledWith({
			authority: completeTrustedAuthority,
			input: { packageName: '@agent-vm/agent-vm' },
			request: validRequest,
		});
	});

	it.each([
		['unregistered action', { ...validRequest, hostActionName: 'execute-command' }],
		['malformed typed input', { ...validRequest, canonicalArguments: { packageName: 'npm' } }],
		[
			'unknown typed input field',
			{
				...validRequest,
				canonicalArguments: { command: 'id', packageName: '@agent-vm/agent-vm' },
			},
		],
		['generic command field', { ...validRequest, command: 'id' }],
		['executable override', { ...validRequest, executablePath: '/bin/sh' }],
		['prefix override', { ...validRequest, mandatoryArgvPrefix: ['-c'] }],
		['environment override', { ...validRequest, environment: { TOKEN: 'stolen' } }],
		['cancellation override', { ...validRequest, cancellation: 'ignore' }],
		['target override', { ...validRequest, target: 'host-root' }],
	] as const)('rejects %s before invoking host code', async (_name, attackerRequest) => {
		executeRefreshPackageMetadata.mockClear();
		const registry = createControllerHostActionRegistry({
			actions: [registeredAction],
			recomputeAuthorization: async () => completeTrustedAuthority,
		});

		await expect(registry.execute(attackerRequest)).resolves.toMatchObject({
			certainty: 'proven',
			error: { code: expect.stringMatching(/capability_denied|validation_failed/u) },
			kind: 'not-dispatched',
			retryClass: 'safe-before-dispatch',
		});
		expect(executeRefreshPackageMetadata).not.toHaveBeenCalled();
	});

	it('rejects mismatched duplicated canonical arguments before recomputation', async () => {
		const recomputeAuthorization = vi.fn(async () => completeTrustedAuthority);
		const registry = createControllerHostActionRegistry({
			actions: [registeredAction],
			recomputeAuthorization,
		});

		await expect(
			registry.execute({
				...validRequest,
				dispatch: {
					...validRequest.dispatch,
					canonicalArguments: { packageName: '@agent-vm/other' },
				},
			}),
		).resolves.toMatchObject({
			certainty: 'proven',
			error: { code: 'validation_failed' },
			kind: 'not-dispatched',
			retryClass: 'safe-before-dispatch',
		});
		expect(recomputeAuthorization).not.toHaveBeenCalled();
	});

	it('preserves ambiguous replay-forbidden truth after host-action dispatch begins', async () => {
		const failingAction = defineControllerHostAction({
			actionName: 'refresh-package-metadata',
			execute: async (): Promise<JsonObject> => {
				throw new Error('host action connection failed after dispatch');
			},
			inputSchema: RefreshPackageMetadataInputSchema,
		});
		const registry = createControllerHostActionRegistry({
			actions: [failingAction],
			recomputeAuthorization: async () => completeTrustedAuthority,
		});

		await expect(registry.execute(validRequest)).resolves.toEqual({
			binding: {
				fingerprint: JSON.stringify(validatedInvocation.fingerprint),
				operationId: 'audit-operation-a',
			},
			certainty: 'side-effects-and-termination-unknown',
			diagnostics: [],
			error: {
				code: 'execution_failed',
				message: 'Controller host action execution state is unknown.',
			},
			kind: 'ambiguous',
			reason: 'dispatch-state-unknown',
			retryClass: 'forbidden',
		});
	});

	it('preserves proven not-dispatched truth when authority recomputation fails', async () => {
		const registry = createControllerHostActionRegistry({
			actions: [registeredAction],
			recomputeAuthorization: async () => {
				throw new Error('authority lookup failed');
			},
		});

		await expect(registry.execute(validRequest)).resolves.toEqual({
			certainty: 'proven',
			diagnostics: [],
			error: {
				code: 'not_authorized',
				message: 'Controller host action authority could not be recomputed.',
			},
			kind: 'not-dispatched',
			reason: 'stale-authority',
			retryClass: 'safe-before-dispatch',
		});
	});

	it('does not register the HTTP execute-command route as a Tool Portal backend', () => {
		const registry = createControllerHostActionRegistry({
			actions: [registeredAction],
			recomputeAuthorization: async () => completeTrustedAuthority,
		});

		expect(registry.listActionNames()).toEqual(['refresh-package-metadata']);
		expect(registry.hasAction('execute-command')).toBe(false);
	});
});
