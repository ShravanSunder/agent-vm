import type {
	AnalyticsSink,
	CallAnalytics,
} from '#tool-host-core/call-analytics/models/call-analytics';

/** No raw call, token, result, exception or secret is accepted at this boundary. */
export function writeCallAnalytics(props: {
	readonly sink: AnalyticsSink;
	readonly call: CallAnalytics;
	readonly log: (event: { readonly event: 'analytics-write-dropped' }) => void;
}): void {
	try {
		props.sink.write(props.call);
	} catch {
		props.log({ event: 'analytics-write-dropped' });
	}
}
