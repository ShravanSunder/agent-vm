import { removalNoticeSchema } from '@agent-collaboration/tool-access/contracts';
import type { ConsumeApprovalTokenResult } from '@agent-collaboration/tool-engine/mcp-gateway';
import type { ObservationLog } from '@agent-collaboration/tool-host-core';
import {
	createHostedMcpProxy,
	hostedAgentVerifier,
	type HostedMcpProxy,
} from '@agent-collaboration/tool-host-core';
import { z } from 'zod';

import { createAnalyticsEngineSink } from '#worker-host/analytics-engine-sink/analytics-engine-sink';
import { WorkspaceAuthority as ProductionWorkspaceAuthority } from '#worker-host/durable-workspace-authority/workspace-authority';
import type { WorkerBindings } from '#worker-host/index';
import {
	createObservedNativeClient,
	nativeClientClosures,
} from '#worker-host/test-fixtures/native-client-observation';
import {
	deployedConfigurationSource,
	workerSecretBindings,
} from '#worker-host/worker-bindings/worker-configuration';
import { workerHostedProxyLimits } from '#worker-host/worker-limits';
import { createWorkerUpstreamTransport } from '#worker-host/worker-upstream-transports';

export class WorkspaceAuthority extends ProductionWorkspaceAuthority {
	private fault: 'none' | 'fail' | 'stall' = 'none';
	private release: (() => void) | undefined;
	private recording = Promise.withResolvers<void>();
	async setProofFault(fault: 'none' | 'fail' | 'stall'): Promise<void> {
		this.fault = fault;
		this.recording = Promise.withResolvers<void>();
	}
	async waitForProofRecording(): Promise<void> {
		await this.recording.promise;
	}
	async releaseProofFault(): Promise<void> {
		this.fault = 'none';
		this.release?.();
	}
	override async consumeApprovalToken(
		tokenId: string,
		expiresAtMs: number,
	): Promise<ConsumeApprovalTokenResult> {
		if (this.fault === 'fail') throw new Error('object-failure-canary');
		if (this.fault === 'stall') {
			this.recording.resolve();
			await new Promise<void>((resolve) => {
				this.release = resolve;
			});
		}
		return super.consumeApprovalToken(tokenId, expiresAtMs);
	}
}
interface ProofBindings extends WorkerBindings {
	readonly WORKSPACES: DurableObjectNamespace<WorkspaceAuthority>;
	readonly FIXED_CLOCK?: string;
}
const controlSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('removal'), notice: removalNoticeSchema }),
	z.strictObject({
		kind: z.literal('fault'),
		organizationId: z.string(),
		fault: z.enum(['none', 'fail', 'stall']),
	}),
	z.strictObject({ kind: z.literal('release'), organizationId: z.string() }),
	z.strictObject({ kind: z.literal('wait-recording'), organizationId: z.string() }),
]);
let host: HostedMcpProxy | undefined;
let testNow: number | undefined;
const logs: ObservationLog[] = [];
const points: unknown[] = [];
let failAnalytics = false;
// Control routes exist only in this separate test entry, never in the production entrypoint.
export default {
	async fetch(request: Request, bindings: ProofBindings): Promise<Response> {
		// Parity-only deterministic diagnostic clock; not used by the production entrypoint.
		if (bindings.FIXED_CLOCK !== undefined) {
			testNow ??= Number(bindings.FIXED_CLOCK);
			Date.now = () => testNow ?? 0;
		}
		if (new URL(request.url).pathname === '/__clock') {
			testNow = Number(new URL(request.url).searchParams.get('now'));
			return Response.json({ ok: true });
		}
		if (new URL(request.url).pathname === '/__clients') return Response.json(nativeClientClosures);
		if (new URL(request.url).pathname === '/__points') return Response.json(points);
		if (new URL(request.url).pathname === '/__fail-analytics') {
			failAnalytics = new URL(request.url).searchParams.has('fail');
			return Response.json({ ok: true });
		}
		if (new URL(request.url).pathname === '/__logs') return Response.json(logs);
		if (new URL(request.url).pathname === '/__proof') {
			const input = controlSchema.parse(await request.json());
			const object = bindings.WORKSPACES.get(
				bindings.WORKSPACES.idFromName(
					input.kind === 'removal' ? input.notice.workspaceId : input.organizationId,
				),
			);
			switch (input.kind) {
				case 'removal':
					await object.recordRemovalNotice(input.notice);
					break;
				case 'fault':
					await object.setProofFault(input.fault);
					break;
				case 'release':
					await object.releaseProofFault();
					break;
				case 'wait-recording':
					await object.waitForProofRecording();
					break;
			}
			return Response.json({ ok: true });
		}
		host ??= createHostedMcpProxy({
			sessionClientId: 'central',
			toolPortalOrigin: bindings.TOOL_PORTAL_ORIGIN,
			createClient: createObservedNativeClient,
			analytics: createAnalyticsEngineSink({
				writeDataPoint: (point) => {
					if (failAnalytics) throw new Error('binding-secret-canary');
					points.push(point);
				},
			}),
			clock: { nowMs: () => Date.now(), nowIso: () => new Date().toISOString() },
			newId: () => crypto.randomUUID(),
			limits: workerHostedProxyLimits,
			createUpstreamMcpTransport: createWorkerUpstreamTransport,
			log: (event) => logs.push(event),
			verifier: hostedAgentVerifier({
				deployment: bindings.SIGN_IN_ISSUER,
				jwksUrl: bindings.SIGN_IN_JWKS_URL,
			}),
			configurations: deployedConfigurationSource(JSON.parse(bindings.WORKSPACE_CONFIGURATIONS)),
			secrets: workerSecretBindings(bindings),
			workspaces: {
				forWorkspace: (organizationId) =>
					bindings.WORKSPACES.get(bindings.WORKSPACES.idFromName(organizationId)),
			},
		});
		return host.handle(request);
	},
};
