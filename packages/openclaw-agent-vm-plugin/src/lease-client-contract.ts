import type {
	EndToolVmActiveUseRequest,
	HeartbeatToolVmActiveUseRequest,
	HeartbeatToolVmActiveUseResponse,
	StartToolVmActiveUseRequest,
	StartToolVmActiveUseResponse,
	ToolVmLeasePeek,
	ToolVmSshLease,
} from '@agent-vm/gateway-interface';
import { z } from 'zod';

export type { OpenClawRuntimeStatusReport } from './openclaw-runtime-status.js';

export type JsonValue =
	| boolean
	| null
	| number
	| string
	| { readonly [key: string]: JsonValue }
	| readonly JsonValue[];

export interface OpenClawGondolinLeaseSandboxSnapshot {
	readonly backend: unknown;
	readonly mode: unknown;
	readonly scope: unknown;
	readonly workspaceAccess: unknown;
}

export interface OpenClawGondolinLeaseRequest {
	readonly agentId: string;
	readonly agentWorkspaceDir: string;
	readonly idleTtlMs?: number;
	readonly profileId: string;
	readonly sessionKey: string;
	readonly workMountDir: string;
	readonly zoneId: string;
}

export type OpenClawGondolinLeaseStaleEvidence =
	| {
			readonly errorCode?: string;
			readonly kind: 'tool-vm-ssh';
			readonly operation: 'command' | 'file-bridge' | 'finalize' | 'probe';
	  }
	| {
			readonly kind: 'caller-context';
			readonly reason?: 'absent' | 'stale' | 'session_mismatch' | 'lease_authority_absent';
	  }
	| {
			readonly kind: 'lease-manager';
			readonly reason?: 'expired' | 'released' | 'force_released' | 'generation_stale';
	  };

export interface OpenClawGondolinLeaseReacquireRequest {
	readonly idleTtlMs?: number;
	readonly observedAtMs: number;
	readonly staleEvidence: OpenClawGondolinLeaseStaleEvidence;
}

export interface LeaseClient {
	// Cached handles use renewLease; read-only runtime probes use peekLease.
	endActiveUse(leaseId: string, useId: string, request: EndToolVmActiveUseRequest): Promise<void>;
	heartbeatActiveUse(
		leaseId: string,
		useId: string,
		request: HeartbeatToolVmActiveUseRequest,
	): Promise<HeartbeatToolVmActiveUseResponse>;
	peekLease(leaseId: string): Promise<ToolVmLeasePeek>;
	reacquireLease(
		oldLeaseId: string,
		request: OpenClawGondolinLeaseReacquireRequest,
	): Promise<ToolVmSshLease>;
	releaseLease(leaseId: string, options?: { readonly force?: boolean }): Promise<void>;
	renewLease(leaseId: string): Promise<ToolVmSshLease>;
	requestLease(request: OpenClawGondolinLeaseRequest): Promise<ToolVmSshLease>;
	startActiveUse(
		leaseId: string,
		request: StartToolVmActiveUseRequest,
	): Promise<StartToolVmActiveUseResponse>;
}

export type ControllerLeaseRequestErrorKind = 'client-error' | 'server-error';

const structuredControllerErrorSchema = z.object({
	guidance: z.string().trim().min(1).optional(),
	message: z.string().trim().min(1).optional(),
});

function formatStructuredErrorSuffix(responseBody: JsonValue | undefined): string {
	const parsedError = structuredControllerErrorSchema.safeParse(responseBody);
	if (!parsedError.success) {
		return '';
	}
	const { guidance, message } = parsedError.data;
	const parts = [message, guidance ? `Guidance: ${guidance}` : undefined].filter(
		(part): part is string => part !== undefined,
	);
	return parts.length > 0 ? `: ${parts.join(' ')}` : '';
}

export class ControllerLeaseRequestError extends Error {
	readonly bodyText: string;
	readonly kind: ControllerLeaseRequestErrorKind;
	readonly responseBody: JsonValue | undefined;
	readonly status: number;

	constructor(options: {
		readonly bodyText: string;
		readonly context: string;
		readonly responseBody: JsonValue | undefined;
		readonly status: number;
	}) {
		const kind: ControllerLeaseRequestErrorKind =
			options.status >= 400 && options.status < 500 ? 'client-error' : 'server-error';
		super(
			`${options.context} returned HTTP ${String(options.status)} (${kind})${formatStructuredErrorSuffix(
				options.responseBody,
			)}`,
		);
		this.bodyText = options.bodyText;
		this.kind = kind;
		this.responseBody = options.responseBody;
		this.status = options.status;
	}
}
