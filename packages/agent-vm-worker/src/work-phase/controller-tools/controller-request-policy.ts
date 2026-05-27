import {
	fetchControllerWithPolicy,
	type ControllerRequestPolicy,
	type WorkerInternalControllerRequestOperation,
} from '@agent-vm/gateway-interface';

export { ControllerRequestPolicyTransportError as WorkerControllerRequestPolicyTransportError } from '@agent-vm/gateway-interface';
export type { ControllerRequestPolicyTransportErrorCode as WorkerControllerRequestPolicyTransportErrorCode } from '@agent-vm/gateway-interface';

export interface FetchWorkerControllerWithPolicyOptions {
	readonly fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
	readonly init?: RequestInit;
	readonly input: string | URL | Request;
	readonly operation: WorkerInternalControllerRequestOperation;
	readonly policy?: ControllerRequestPolicy;
}

export async function fetchWorkerControllerWithPolicy(
	options: FetchWorkerControllerWithPolicyOptions,
): Promise<Response> {
	return await fetchControllerWithPolicy(options);
}
