import type {
	CallObservation,
	RunObservations,
} from '#worker-host/deployed-checks/test-helper-worker/models/helper-contracts';

export function emptyObservations(runId: string): RunObservations {
	return { runId, calls: [], activeCalls: 0, peakCalls: 0 };
}
export function beginObservation(
	snapshot: RunObservations,
	call: Omit<CallObservation, 'effects' | 'inFlight'>,
): RunObservations {
	const prior = snapshot.calls.find((record) => record.callId === call.callId);
	if (
		prior !== undefined &&
		(prior.organizationLabel !== call.organizationLabel ||
			prior.credential !== call.credential ||
			prior.toolName !== call.toolName)
	)
		throw new Error('Call ID reused with different identity.');
	const activeCalls = snapshot.activeCalls + 1;
	const record = {
		...call,
		effects: (prior?.effects ?? 0) + 1,
		inFlight: (prior?.inFlight ?? 0) + 1,
	};
	return {
		...snapshot,
		calls: [...snapshot.calls.filter((entry) => entry.callId !== call.callId), record],
		activeCalls,
		peakCalls: Math.max(snapshot.peakCalls, activeCalls),
	};
}
export function finishObservation(snapshot: RunObservations, callId: string): RunObservations {
	const prior = snapshot.calls.find((record) => record.callId === callId);
	if (prior === undefined || prior.inFlight < 1) throw new Error('No active call to finish.');
	return {
		...snapshot,
		activeCalls: snapshot.activeCalls - 1,
		calls: snapshot.calls.map((record) =>
			record.callId === callId ? { ...record, inFlight: record.inFlight - 1 } : record,
		),
	};
}
