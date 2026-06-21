import {
	ManagedVmArtifactReadRequestSchema,
	type ManagedVmArtifactReadRequest,
	ManagedVmExecRequestSchema,
	type ManagedVmExecRequest,
} from '@agent-vm/controller-execution-contracts';

export interface FakeManagedVmExecResult {
	readonly exitCode: number;
	readonly status: 'ok';
	readonly stderr: string;
	readonly stdout: string;
}

export interface FakeManagedVmArtifactReadResult {
	readonly bytes: Uint8Array;
	readonly status: 'ok';
}

export interface FakeManagedVmRunner {
	readonly exec: (request: ManagedVmExecRequest) => Promise<FakeManagedVmExecResult>;
	readonly readArtifact: (
		request: ManagedVmArtifactReadRequest,
	) => Promise<FakeManagedVmArtifactReadResult>;
	readonly recordedArtifactReadRequests: readonly ManagedVmArtifactReadRequest[];
	readonly recordedExecRequests: readonly ManagedVmExecRequest[];
}

export function createFakeManagedVmRunner(): FakeManagedVmRunner {
	const recordedExecRequests: ManagedVmExecRequest[] = [];
	const recordedArtifactReadRequests: ManagedVmArtifactReadRequest[] = [];
	return {
		exec: async (request) => {
			const parsedRequest = ManagedVmExecRequestSchema.parse(request);
			recordedExecRequests.push(parsedRequest);
			return {
				exitCode: 0,
				status: 'ok',
				stderr: '',
				stdout: '',
			};
		},
		readArtifact: async (request) => {
			const parsedRequest = ManagedVmArtifactReadRequestSchema.parse(request);
			recordedArtifactReadRequests.push(parsedRequest);
			return {
				bytes: new Uint8Array(),
				status: 'ok',
			};
		},
		recordedArtifactReadRequests,
		recordedExecRequests,
	};
}
