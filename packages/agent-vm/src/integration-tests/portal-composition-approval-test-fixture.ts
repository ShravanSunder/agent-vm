import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import type { FakeUpstreamToolCallRecord } from '@agent-collaboration/tool-host-node/testing/fake-upstream-mcp-server';
import { PortalCallResultSchema } from '@agent-vm/agent-portal-sdk';
import { expect } from 'vitest';
import { z } from 'zod';

import {
	createControllerApprovalLedger,
	type ControllerApprovalOperatorView,
} from '#agent-vm/controller/approval/controller-approval-ledger';
import type { ControllerApprovalRecordsTarget } from '#agent-vm/controller/durable-state/controller-state-record-paths';

export const portalCompositionApprovalNamespace = 'portal_composition_approved_mcp';
export const portalCompositionApprovalTitle = 'approved-through-native-hermes';
export const portalCompositionApprovalRequest = {
	calls: [
		{
			id: 'guest-protected-write',
			namespace: portalCompositionApprovalNamespace,
			name: 'write_thing',
			arguments: { title: portalCompositionApprovalTitle },
		},
	],
};

export const portalCompositionApprovalPrompt = 'RUN_PORTAL_COMPOSITION_NATIVE_APPROVAL';
export const portalCompositionApprovalResultMarker = 'portal-composition-protected-call-complete';
export const portalCompositionApprovalFinalMarker = 'portal-composition-native-approval-complete';

/** Identical source is sent in two separate execute_code invocations. */
export function buildPortalCompositionApprovalProgram(): string {
	return [
		'import asyncio, json',
		'from agent_vm_agent_portal_sdk import connect_tool_portal',
		'async def main():',
		'    async with connect_tool_portal() as portal:',
		`        result = await portal.call(json.loads(${JSON.stringify(JSON.stringify(portalCompositionApprovalRequest))}))`,
		`        print(json.dumps({"marker": ${JSON.stringify(portalCompositionApprovalResultMarker)}, "result": result.model_dump(by_alias=True, mode="json", exclude_none=True)}, sort_keys=True))`,
		'asyncio.run(main())',
	].join('\n');
}

export async function readPortalCompositionApprovals(
	recordsTarget: ControllerApprovalRecordsTarget,
): Promise<readonly ControllerApprovalOperatorView[]> {
	const firstName = (await readdir(recordsTarget.directoryPath)).find((name) =>
		name.endsWith('.json'),
	);
	if (firstName === undefined) throw new Error('Controller has not persisted an approval record');
	const header = z
		.object({ authorityContext: z.object({ controllerEpoch: z.string() }) })
		.parse(JSON.parse(await readFile(path.join(recordsTarget.directoryPath, firstName), 'utf8')));
	// This instance only reads the actual controller's durable records; it never decides or arms.
	const ledger = createControllerApprovalLedger({
		recordsTarget,
		currentControllerEpoch: header.authorityContext.controllerEpoch,
		challengeTtlMs: 300_000,
	});
	return (await ledger.list()).filter(
		(entry) => entry.challenge.intent.call.namespace === portalCompositionApprovalNamespace,
	);
}

const runEventSchema = z.object({ event: z.string(), run_id: z.string() }).passthrough();
export const hermesApprovalEventSchema = runEventSchema.extend({
	event: z.literal('approval.request'),
	request_id: z.string().min(1),
	command: z.string(),
	choices: z.array(z.string()),
});

export function createPortalCompositionApprovalObservation(props: {
	readonly recordsTarget: ControllerApprovalRecordsTarget;
	readonly calls: () => readonly FakeUpstreamToolCallRecord[];
}): {
	readonly onApproval: (
		event: z.infer<typeof hermesApprovalEventSchema>,
	) => Promise<'once' | 'deny'>;
	readonly assertSettled: (results: readonly string[]) => Promise<void>;
} {
	const challengeIds: string[] = [];
	const operationIds: string[] = [];
	const qualifiedCallIds: string[] = [];
	const nativeRequestIds: string[] = [];
	const protectedCalls = (): readonly FakeUpstreamToolCallRecord[] =>
		props
			.calls()
			.filter(
				(call) =>
					call.name === 'write_thing' &&
					z
						.object({ title: z.literal(portalCompositionApprovalTitle) })
						.safeParse(call.argumentsValue).success,
			);
	return {
		onApproval: async (event) => {
			const index = challengeIds.length;
			expect(event.command).toContain(`${portalCompositionApprovalNamespace}.write_thing`);
			expect(event.command).toContain(portalCompositionApprovalTitle);
			if (index > 1) throw new Error('Unexpected third native approval request');
			const records = await readPortalCompositionApprovals(props.recordsTarget);
			const pending = records.find((record) => record.kind === 'pending');
			if (pending === undefined)
				throw new Error('Native approval has no durable pending controller challenge');
			expect(protectedCalls()).toHaveLength(index);
			expect(pending.challenge.intent.call.arguments).toEqual({
				title: portalCompositionApprovalTitle,
			});
			expect(pending.challenge.intent.trustedContext.principal.agentId).toBe('main');
			if (index === 1) {
				expect(
					records.find((record) => record.challenge.approvalId === challengeIds[0])?.kind,
				).toBe('dispatch-armed');
				expect(pending.challenge.approvalId).not.toBe(challengeIds[0]);
				expect(pending.challenge.intent.operationId).not.toBe(operationIds[0]);
				expect(pending.challenge.intent.call.id).not.toBe(qualifiedCallIds[0]);
				expect(event.request_id).not.toBe(nativeRequestIds[0]);
			}
			challengeIds.push(pending.challenge.approvalId);
			operationIds.push(pending.challenge.intent.operationId);
			qualifiedCallIds.push(pending.challenge.intent.call.id);
			nativeRequestIds.push(event.request_id);
			const choice = index === 0 ? 'once' : 'deny';
			process.stdout.write(
				'portal-composition-approval-pending ' +
					JSON.stringify({
						index,
						choice,
						challengeId: pending.challenge.approvalId,
						operationId: pending.challenge.intent.operationId,
						state: pending.kind,
						protectedEffectCount: protectedCalls().length,
					}) +
					'\n',
			);
			return choice;
		},
		assertSettled: async (results) => {
			expect(results).toHaveLength(2);
			results.forEach((raw, index) => {
				const envelope = z
					.object({
						status: z.literal('success'),
						kernel: z.object({ remote: z.literal(true) }),
						output: z.string(),
					})
					.parse(JSON.parse(raw));
				const output = z
					.object({
						marker: z.literal(portalCompositionApprovalResultMarker),
						result: PortalCallResultSchema,
					})
					.parse(JSON.parse(envelope.output));
				expect(output.result.ok).toBe(index === 0);
				expect(output.result.items).toHaveLength(1);
				expect(output.result.items[0]).toMatchObject({
					id: 'guest-protected-write',
					operationId: operationIds[index],
					status: index === 0 ? 'ok' : 'error',
				});
				if (index === 1)
					expect(output.result.items[0]).toMatchObject({
						error: { code: 'capability_denied' },
						outcome: { kind: 'not-dispatched' },
					});
			});
			const records = await readPortalCompositionApprovals(props.recordsTarget);
			expect(challengeIds).toHaveLength(2);
			expect(protectedCalls()).toEqual([
				{ name: 'write_thing', argumentsValue: { title: portalCompositionApprovalTitle } },
			]);
			expect(
				challengeIds.map(
					(id) => records.find((record) => record.challenge.approvalId === id)?.kind,
				),
			).toEqual(['dispatch-armed', 'denied']);
			process.stdout.write(
				'portal-composition-approval-settled ' +
					JSON.stringify({
						challengeIds,
						operationIds,
						qualifiedCallIds,
						nativeRequestIds,
						states: records.map((record) => record.kind),
						protectedEffects: protectedCalls(),
					}) +
					'\n',
			);
		},
	};
}

/** Drive the pinned Hermes native run/elicitation API without a presenter or controller double. */
export async function requestPortalCompositionApprovalRun(options: {
	readonly gatewayPort: number;
	readonly agentId: string;
	readonly apiServerKey: string;
	readonly modelName: string;
	readonly sessionId: string;
	readonly prompt: string;
	readonly onApproval: (
		event: z.infer<typeof hermesApprovalEventSchema>,
	) => Promise<'once' | 'deny'>;
}): Promise<string> {
	const baseUrl = `http://127.0.0.1:${options.gatewayPort}/p/${options.agentId}/v1/runs`;
	const headers = {
		authorization: `Bearer ${options.apiServerKey}`,
		'content-type': 'application/json',
	};
	const signal = AbortSignal.timeout(180_000);
	const started = await fetch(baseUrl, {
		method: 'POST',
		headers,
		signal,
		body: JSON.stringify({
			input: options.prompt,
			model: options.modelName,
			session_id: options.sessionId,
		}),
	});
	if (started.status !== 202)
		throw new Error(`Hermes run start failed: ${started.status} ${await started.text()}`);
	const { run_id: runId } = z.object({ run_id: z.string().min(1) }).parse(await started.json());
	const events = await fetch(`${baseUrl}/${encodeURIComponent(runId)}/events`, { headers, signal });
	if (!events.ok || events.body === null)
		throw new Error(`Hermes event stream failed: ${events.status}`);
	let buffered = '';
	let approvalCount = 0;
	let output: string | undefined;
	const frames = new TransformStream<string, unknown>({
		transform: (chunk, controller): void => {
			buffered = (buffered + chunk).replaceAll('\r\n', '\n');
			let boundary = buffered.indexOf('\n\n');
			while (boundary !== -1) {
				const frame = buffered.slice(0, boundary);
				buffered = buffered.slice(boundary + 2);
				const data = frame
					.split('\n')
					.filter((line) => line.startsWith('data:'))
					.map((line) => line.slice(5).trimStart())
					.join('\n');
				if (data.length > 0) controller.enqueue(JSON.parse(data));
				boundary = buffered.indexOf('\n\n');
			}
		},
	});
	await events.body
		.pipeThrough(new TextDecoderStream())
		.pipeThrough(frames)
		.pipeTo(
			new WritableStream<unknown>({
				write: async (payload): Promise<void> => {
					const event = runEventSchema.parse(payload);
					if (event.run_id !== runId) throw new Error('Hermes event belongs to a different run');
					if (event.event === 'approval.request') {
						const approval = hermesApprovalEventSchema.parse(event);
						if (approvalCount !== 0)
							throw new Error('Unexpected second approval within one execute_code run');
						const choice = await options.onApproval(approval);
						if (!approval.choices.includes(choice))
							throw new Error('Native approval choice was not offered');
						const response = await fetch(`${baseUrl}/${encodeURIComponent(runId)}/approval`, {
							method: 'POST',
							headers,
							signal,
							body: JSON.stringify({ request_id: approval.request_id, choice }),
						});
						if (!response.ok)
							throw new Error(
								`Hermes approval failed: ${response.status} ${await response.text()}`,
							);
						z.object({
							run_id: z.literal(runId),
							request_id: z.literal(approval.request_id),
							choice: z.literal(choice),
							resolved: z.literal(1),
						}).parse(await response.json());
						approvalCount += 1;
					}
					if (event.event === 'run.completed')
						output = z.object({ output: z.string() }).parse(event).output;
					if (['run.failed', 'run.cancelled', 'run.interrupted'].includes(event.event))
						throw new Error(`Hermes run did not complete: ${JSON.stringify(event)}`);
				},
			}),
		);
	if (output === undefined || approvalCount !== 1)
		throw new Error(
			`Hermes omitted completion or one native approval: ${JSON.stringify({ output, approvalCount })}`,
		);
	return output;
}
