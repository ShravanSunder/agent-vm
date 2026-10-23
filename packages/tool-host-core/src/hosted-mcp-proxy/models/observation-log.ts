export type ObservationLog =
	| {
			readonly event: 'request-started' | 'request-ended';
			readonly isolateId: string;
			readonly requestId: string;
			readonly activeRequests: number;
	  }
	| { readonly event: 'analytics-write-dropped' | 'worker-request-unavailable' };
