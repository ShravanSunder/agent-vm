import { z } from 'zod';

/** Each Worker invocation owns its outbound wait; shared barrier state lives in the Node fixture. */
export async function callAuthProofBarrier(props: {
	readonly bindings: AuthWorkerEnv;
	readonly channel: 'hold' | 'management-hold';
	readonly operation: 'arm' | 'status' | 'entered' | 'arrive' | 'release';
	readonly key: string;
	readonly event?: unknown;
}): Promise<Response> {
	const configuration = z.object({ AUTH_PROOF_CONTROL_ORIGIN: z.url() }).parse(props.bindings);
	const url = new URL(
		`/__auth-proof/${props.channel}/${props.operation}`,
		configuration.AUTH_PROOF_CONTROL_ORIGIN,
	);
	url.searchParams.set('key', props.key);
	const response = await fetch(url, {
		method: ['status', 'entered'].includes(props.operation) ? 'GET' : 'POST',
		...(props.event === undefined
			? {}
			: { headers: { 'content-type': 'application/json' }, body: JSON.stringify(props.event) }),
	});
	if (!response.ok) throw new Error(`Proof barrier ${props.operation} failed (${response.status})`);
	return response;
}
