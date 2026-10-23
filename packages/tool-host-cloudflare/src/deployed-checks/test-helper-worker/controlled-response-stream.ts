import type {
	ControlledCall,
	ObservationPort,
} from '#worker-host/deployed-checks/test-helper-worker/models/helper-contracts';

/** Stream large fixtures so the helper's memory cannot decide the portal's memory proof. */
export function controlledResponseStream(props: {
	readonly rpcId: string | number | undefined;
	readonly input: ControlledCall;
	readonly observations: ObservationPort;
}): Response {
	const encoder = new TextEncoder();
	const envelopeBytes = JSON.stringify({ content: [{ type: 'text', text: '' }] }).length;
	let remainingBytes = Math.max(0, props.input.responseBytes - envelopeBytes);
	let phase: 'prefix' | 'text' | 'suffix' | 'done' = 'prefix';
	let completion: Promise<void> | undefined;
	const finish = (): Promise<void> =>
		(completion ??= props.observations.finish(props.input.callId));
	return new Response(
		new ReadableStream<Uint8Array>({
			async pull(controller): Promise<void> {
				try {
					if (phase === 'prefix') {
						if (props.input.hold) await props.observations.hold(props.input.callId);
						controller.enqueue(
							encoder.encode(
								`${JSON.stringify({ jsonrpc: '2.0', id: props.rpcId }).slice(0, -1)},"result":{"content":[{"type":"text","text":"`,
							),
						);
						phase = 'text';
					} else if (phase === 'text') {
						if (props.input.responseBytes === 0) {
							controller.enqueue(encoder.encode(JSON.stringify(props.input.value).slice(1, -1)));
							phase = 'suffix';
						} else {
							const chunkBytes = Math.min(64 * 1024, remainingBytes);
							if (chunkBytes > 0) controller.enqueue(encoder.encode('x'.repeat(chunkBytes)));
							remainingBytes -= chunkBytes;
							if (remainingBytes === 0) phase = 'suffix';
						}
					} else if (phase === 'suffix') {
						controller.enqueue(encoder.encode('"}]}}'));
						await finish();
						phase = 'done';
						controller.close();
					}
				} catch (error) {
					await finish();
					controller.error(error);
				}
			},
			async cancel(): Promise<void> {
				await finish();
			},
		}),
		{ headers: { 'content-type': 'application/json' } },
	);
}
