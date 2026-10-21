export type WorkerObservationLog =
	| {
			readonly event: 'request-started' | 'request-ended';
			readonly isolateId: string;
			readonly requestId: string;
			readonly activeRequests: number;
	  }
	| { readonly event: 'analytics-write-dropped' | 'worker-request-unavailable' };

export function writeWorkerObservationLog(event: WorkerObservationLog): void {
	const workerConsole = globalThis.console;
	workerConsole.info(JSON.stringify(event));
}
