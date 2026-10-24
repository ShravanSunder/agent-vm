import { it } from 'vitest';
import { z } from 'zod';

import type { PrivateDeployFile } from '#worker-host/deployed-checks/deploy-configuration/models/private-deploy-file';
import { readPrivateDeployFile } from '#worker-host/deployed-checks/deploy-configuration/private-file-access';
import {
	helperRequest,
	observations,
	portalCall,
	portalRpc,
} from '#worker-host/deployed-checks/deployed-check-suites/deployed-portal-client';
import { writeRunArtifact } from '#worker-host/deployed-checks/deployed-check-suites/evidence-file-access';
import {
	assertBatchLimit,
	assertBodyLimit,
	assertBoundedLargeReply,
	assertSixInFlight,
	assertUpstreamBoundary,
} from '#worker-host/deployed-checks/deployed-check-suites/limit-observations';
import { waitForProtocolRetryInterval } from '#worker-host/test-fixtures/protocol-observation-interval';

function batch(
	configuration: PrivateDeployFile,
	prefix: string,
	count: number,
	extra: Readonly<Record<string, unknown>> = {},
): { readonly params: Record<string, unknown>; readonly callIds: string[] } {
	const callIds = Array.from({ length: count }, (_, index) => `${prefix}-${String(index)}`);
	return {
		params: {
			name: 'mcp_portal_call',
			arguments: {
				calls: callIds.map((callId) => ({
					id: callId,
					namespace: 'same-server',
					toolName: 'read',
					arguments: { runId: configuration.runId, callId, ...extra },
				})),
			},
		},
		callIds,
	};
}
async function waitForHeldCalls(configuration: PrivateDeployFile, expected: number): Promise<void> {
	const deadline = Date.now() + 30_000;
	async function observe(): Promise<void> {
		const snapshot = await observations(configuration);
		if (snapshot.activeCalls === expected) return;
		if (snapshot.activeCalls > expected || Date.now() >= deadline)
			throw new Error('Held-call barrier did not reach the expected concurrency.');
		await waitForProtocolRetryInterval();
		return observe();
	}
	await observe();
}
async function release(configuration: PrivateDeployFile): Promise<void> {
	await (
		await helperRequest(configuration, `/observations?runId=${configuration.runId}`, 'POST', {
			action: 'release',
		})
	).body?.cancel();
}

it('row 15: exact body, batch, upstream and six-in-flight limits on a deployed Worker', async () => {
	const configuration = await readPrivateDeployFile();
	const ids = ['body-under', 'body-at', 'body-over'].map(
		(label) => `${label}-${crypto.randomUUID()}`,
	);
	const bodyResponses = await Promise.all(
		ids.map(async (callId, index) =>
			portalRpc(configuration, 'tools/call', portalCall(configuration, callId), {
				bodyBytes: 4 * 1024 * 1024 + index - 1,
			}),
		),
	);
	assertBodyLimit(bodyResponses, await observations(configuration), ids);
	const fifty = batch(configuration, `fifty-${crypto.randomUUID()}`, 50);
	assertBatchLimit(
		await portalRpc(configuration, 'tools/call', fifty.params),
		await observations(configuration),
		fifty.callIds,
		true,
	);
	const fiftyOne = batch(configuration, `fifty-one-${crypto.randomUUID()}`, 51);
	assertBatchLimit(
		await portalRpc(configuration, 'tools/call', fiftyOne.params),
		await observations(configuration),
		fiftyOne.callIds,
		false,
	);
	await Promise.all(
		[-1, 0, 1].map(async (offset): Promise<void> => {
			const responseBytes = 4 * 1024 * 1024 + offset;
			const response = await portalRpc(
				configuration,
				'tools/call',
				portalCall(configuration, `upstream-${crypto.randomUUID()}`, 'read', { responseBytes }),
			);
			assertUpstreamBoundary(response, responseBytes, offset <= 0);
		}),
	);
	const slowConfiguration = { ...configuration, runId: `${configuration.runId}-slow` };
	const slow = batch(slowConfiguration, 'slow', 12, { hold: true });
	const pending = portalRpc(slowConfiguration, 'tools/call', slow.params);
	try {
		await waitForHeldCalls(slowConfiguration, 6);
		await waitForProtocolRetryInterval();
		if ((await observations(slowConfiguration)).activeCalls !== 6)
			throw new Error('More than six calls crossed the held-response barrier.');
	} finally {
		await release(slowConfiguration);
	}
	const response = await pending;
	if (response.status !== 200 || response.result.isError === true)
		throw new Error('Slow batch did not complete.');
	assertSixInFlight(await observations(slowConfiguration), slow.callIds);
});

it('row 15: hold three large batches together; isolate proof follows in the evidence step', async () => {
	const baseConfiguration = await readPrivateDeployFile();
	const configuration = { ...baseConfiguration, runId: `${baseConfiguration.runId}-overlap` };
	const batches = Array.from({ length: 3 }, (_, index) =>
		batch(configuration, `overlap-${String(index)}`, 8, {
			hold: true,
			responseBytes: 3 * 1024 * 1024,
		}),
	);
	const startedAt = Date.now();
	const pending = Promise.all(
		batches.map(async (entry) => portalRpc(configuration, 'tools/call', entry.params)),
	);
	try {
		await waitForHeldCalls(configuration, 18);
	} finally {
		await release(configuration);
	}
	const responses = await pending;
	for (const response of responses) assertBoundedLargeReply(response);
	const snapshot = await observations(configuration);
	for (const callId of batches.flatMap((entry) => entry.callIds)) {
		const call = snapshot.calls.find((entry) => entry.callId === callId);
		if (call?.effects !== 1 || call.inFlight !== 0)
			throw new Error('Overlap effect missing or duplicated.');
	}
	await writeRunArtifact(baseConfiguration, 'row-15-overlap.json', {
		runId: baseConfiguration.runId,
		overlapRunId: configuration.runId,
		callIds: batches.flatMap((entry) => entry.callIds),
		responses,
		startedAt,
		endedAt: Date.now(),
	});
	// This is an observation, not a same-isolate pass. The separate log step decides that.
	z.number().min(18).parse(snapshot.peakCalls);
});
