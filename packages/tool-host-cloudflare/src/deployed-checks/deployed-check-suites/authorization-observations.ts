import type { RunObservations } from '#worker-host/deployed-checks/test-helper-worker/models/helper-contracts';

export function assertCallEffects(
	observations: RunObservations,
	callId: string,
	expected: number,
): void {
	const total = observations.calls
		.filter((call) => call.callId === callId)
		.reduce((sum, call) => sum + call.effects, 0);
	if (total !== expected) throw new Error('Unexpected controlled effect count.');
}
export function assertOwnCredential(
	observations: RunObservations,
	callId: string,
	credential: string,
	label: string,
): void {
	assertCallEffects(observations, callId, 1);
	const call = observations.calls.find((entry) => entry.callId === callId);
	if (call?.credential !== credential || call.workspaceLabel !== label || call.inFlight !== 0)
		throw new Error('Call used the wrong organization or credential.');
}
export function assertOneApprovalUse(
	observations: RunObservations,
	callId: string,
	results: readonly Readonly<Record<string, unknown>>[],
): void {
	assertCallEffects(observations, callId, 1);
	if (results.filter((result) => result.isError !== true).length !== 1 || results.length !== 2)
		throw new Error('Expected exactly one successful approval use.');
}
export function assertRefusedCall(
	observations: RunObservations,
	callId: string,
	response: { readonly status: number; readonly result?: Readonly<Record<string, unknown>> },
): void {
	assertCallEffects(observations, callId, 0);
	if (response.status !== 401 && !(response.status === 200 && response.result?.isError === true))
		throw new Error('Refused control was served.');
}

/** Require an exact organization tool boundary, including when labels share a prefix. */
export function assertWorkspaceCatalogTools(props: {
	readonly names: readonly string[];
	readonly ownLabel: string;
	readonly otherLabel: string;
}): void {
	if (
		!props.names.some((name) => name.startsWith(`same-server__only-${props.ownLabel}__`)) ||
		props.names.some((name) => name.startsWith(`same-server__only-${props.otherLabel}__`))
	)
		throw new Error('Organization catalog leaked or lost tools.');
}
