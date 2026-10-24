import type worker from '@agent-collaboration/auth/cloudflare';

export type PackedFetchInput = Parameters<typeof worker.fetch>;
export type PackedFetchResult = Awaited<ReturnType<typeof worker.fetch>>;
export type PackedGeneratedDatabase = AuthWorkerEnv['DB'];

// @ts-expect-error Spec What this replaces: management moved to Fleet's admin, with C7 HTTP receivers.
export type RemovedPackedManagementEntrypoint =
	typeof import('@agent-collaboration/auth/cloudflare').AgentClientManagement;
