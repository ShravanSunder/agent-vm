import { z } from 'zod';

import { assertCallEffects } from '#worker-host/deployed-checks/deployed-check-suites/authorization-observations';
import type {
	PortalResponseObservation,
	TailRecord,
} from '#worker-host/deployed-checks/deployed-check-suites/models/deployed-evidence';
import { requestLogSchema } from '#worker-host/deployed-checks/deployed-check-suites/models/deployed-evidence';
import type { RunObservations } from '#worker-host/deployed-checks/test-helper-worker/models/helper-contracts';

export function assertBodyLimit(
	responses: readonly PortalResponseObservation[],
	observations: RunObservations,
	callIds: readonly string[],
): void {
	if (responses.length !== 3 || callIds.length !== 3)
		throw new Error('Missing request-boundary observations.');
	responses.forEach((response, index) => {
		const callId = z.string().parse(callIds[index]);
		if (index < 2) {
			if (response.status !== 200 || response.result.isError === true)
				throw new Error('Body under or at the limit failed.');
			assertCallEffects(observations, callId, 1);
		} else {
			if (response.status !== 413) throw new Error('Oversized body was not refused with 413.');
			assertCallEffects(observations, callId, 0);
		}
	});
}
export function assertBatchLimit(
	response: PortalResponseObservation,
	observations: RunObservations,
	callIds: readonly string[],
	permitted: boolean,
): void {
	if (
		response.status !== 200 ||
		(permitted
			? response.result.isError === true
			: response.result.isError !== true ||
				!JSON.stringify(response.result).includes('too_many_calls'))
	)
		throw new Error('Batch boundary returned the wrong outcome.');
	for (const callId of callIds) assertCallEffects(observations, callId, permitted ? 1 : 0);
}
export function assertSixInFlight(observations: RunObservations, callIds: readonly string[]): void {
	if (callIds.length !== 12 || observations.peakCalls !== 6 || observations.activeCalls !== 0)
		throw new Error('Expected twelve calls with a peak of exactly six and none left active.');
	for (const callId of callIds) assertCallEffects(observations, callId, 1);
}
export function assertBoundedLargeReply(response: PortalResponseObservation): void {
	if (
		response.status !== 200 ||
		response.bytes > 16 * 1024 * 1024 ||
		response.result.isError !== true ||
		!JSON.stringify(response.result).includes('too_large_result')
	)
		throw new Error('Large reply did not return a bounded too-large result.');
}
export function assertUpstreamBoundary(
	response: PortalResponseObservation,
	expectedBytes: number,
	allowed: boolean,
): void {
	if (response.status !== 200) throw new Error('Upstream boundary request failed.');
	if (!allowed) {
		if (
			response.result.isError !== true ||
			!JSON.stringify(response.result).includes('upstream_call_failed')
		)
			throw new Error('Oversized upstream response was served.');
		return;
	}
	if (response.result.isError === true) throw new Error('Allowed upstream response was refused.');
	const text = z
		.object({ content: z.tuple([z.object({ text: z.string() })]) })
		.parse(response.result).content[0].text;
	const result = z
		.object({
			items: z.tuple([
				z.object({
					status: z.literal('success'),
					structuredContent: z.object({
						result: z.object({
							content: z.tuple([z.object({ type: z.literal('text'), text: z.string() })]),
						}),
					}),
				}),
			]),
		})
		.parse(JSON.parse(text)).items[0].structuredContent.result;
	if (new TextEncoder().encode(JSON.stringify(result)).byteLength !== expectedBytes)
		throw new Error('Allowed upstream result was truncated.');
}
export function assertSameIsolateOverlap(records: readonly TailRecord[], runId: string): void {
	if (
		records.length < 3 ||
		records.some(
			(record) =>
				record.outcome !== 'ok' ||
				(record.exceptions?.length ?? 0) > 0 ||
				new URL(record.event.request.url).searchParams.get('runId') !== runId,
		)
	)
		throw new Error('Missing overlap logs or a Worker runtime failure.');
	const events = records.flatMap((record) =>
		record.logs.flatMap((log) =>
			log.message.flatMap((message) => {
				if (typeof message !== 'string') return [];
				try {
					const parsed = requestLogSchema.safeParse(JSON.parse(message));
					return parsed.success ? [{ ...parsed.data, timestamp: log.timestamp }] : [];
				} catch {
					return [];
				}
			}),
		),
	);
	const isolates = new Set(events.map((event) => event.isolateId));
	const proven = [...isolates].some((isolateId) => {
		const selected = events.filter((event) => event.isolateId === isolateId);
		const starts = [
			...new Map(
				selected
					.filter((event) => event.event === 'request-started')
					.map((event) => [event.requestId, event]),
			).values(),
		];
		return starts.some(
			(start) =>
				start.activeRequests >= 3 &&
				starts.filter(
					(other) =>
						other.timestamp <= start.timestamp &&
						selected.some(
							(end) =>
								end.event === 'request-ended' &&
								end.requestId === other.requestId &&
								end.timestamp >= start.timestamp,
						),
				).length >= 3,
		);
	});
	if (!proven)
		throw new Error(`INCONCLUSIVE: no three requests overlap in one isolate for run ${runId}.`);
}
