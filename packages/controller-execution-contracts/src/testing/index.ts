import type { JsonObject } from '@agent-vm/agent-portal-sdk';

import {
	ControllerDispatchIntentSchema,
	type ControllerDispatchIntent,
} from '../controller-dispatch-boundary/models/controller-dispatch-intent-schema.js';
import {
	ManagedVmExecRequestSchema,
	type ManagedVmExecRequest,
} from '../tool-vm-runner-boundary/models/managed-vm-exec-request-schema.js';

export interface CreateControllerDispatchIntentFixtureProps {
	readonly agentId?: string;
	readonly arguments?: JsonObject;
	readonly auditCorrelationId?: string;
	readonly name?: string;
	readonly namespace?: string;
	readonly profileId?: string;
}

export interface CreateManagedVmExecRequestFixtureProps {
	readonly argv?: readonly string[];
	readonly cwdPath?: string;
	readonly executablePath?: string;
	readonly timeoutMs?: number;
}

export function createControllerDispatchIntentFixture(
	props: CreateControllerDispatchIntentFixtureProps = {},
): ControllerDispatchIntent {
	return ControllerDispatchIntentSchema.parse({
		auditCorrelationId: props.auditCorrelationId ?? 'audit-1',
		canonicalArguments: props.arguments ?? {},
		capability: {
			name: props.name ?? 'get_issue',
			namespace: props.namespace ?? 'github',
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
