import type {
	ManagedVmCreateRequest,
	ManagedVmGitReadOnlySshEgress,
	ManagedVmMount,
	ManagedVmRootfsMode,
} from '@agent-vm/managed-vm';

export type ForbiddenBackendDiscriminator = ManagedVmCreateRequest['backend'];
export type ForbiddenOpaquePayload = ManagedVmCreateRequest['opaque'];

export const forbiddenMount = {
	kind: 'backend-mount',
	nativeHandle: 12,
} satisfies ManagedVmMount;

export const forbiddenRootfsMode = 'overlay' satisfies ManagedVmRootfsMode;

export const forbiddenSshEgress = {
	allowedHosts: ['git.example.test'],
	kind: 'open',
} satisfies ManagedVmGitReadOnlySshEgress;
