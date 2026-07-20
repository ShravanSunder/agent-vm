import { createHash } from 'node:crypto';

import {
	BoundedOpaqueIdentifierSchema,
	SandboxEnvironmentCloseResultSchema,
	SandboxEnvironmentHandleRequestSchema,
	SandboxEnvironmentHandleSchema,
	SandboxEnvironmentOpenRequestSchema,
	SandboxEnvironmentOpenResultSchema,
	SandboxEnvironmentStatusResultSchema,
	type SandboxEnvironmentCloseRequest,
	type SandboxEnvironmentCloseResult,
	type SandboxEnvironmentHandle,
	type SandboxEnvironmentOpenRequest,
	type SandboxEnvironmentOpenResult,
	type SandboxEnvironmentStatusRequest,
	type SandboxEnvironmentStatusResult,
} from '@agent-vm/agent-portal-sdk/contracts';

interface SandboxEnvironmentRecord {
	readonly environment: SandboxEnvironmentHandle;
	readonly logicalCwd?: string;
	state: 'active' | 'closed' | 'replaced';
}

export interface GatewayRuntimeResolvedActiveEnvironment {
	readonly environment: SandboxEnvironmentHandle;
	readonly logicalCwd?: string;
	readonly workRelativeCwd: string;
}

export interface GatewayRuntimeSandboxEnvironmentRuntime {
	close(request: SandboxEnvironmentCloseRequest): SandboxEnvironmentCloseResult;
	open(request: SandboxEnvironmentOpenRequest): SandboxEnvironmentOpenResult;
	resolveActiveEnvironment(
		environment: SandboxEnvironmentHandle,
	): GatewayRuntimeResolvedActiveEnvironment;
	retire(): void;
	status(request: SandboxEnvironmentStatusRequest): SandboxEnvironmentStatusResult;
}

export interface CreateGatewayRuntimeSandboxEnvironmentRuntimeOptions {
	readonly createHandleId: () => string;
	readonly maximumEnvironmentCount: number;
	readonly maximumTerminalTombstones: number;
	readonly owningGeneration: string;
}

function requirePositiveSafeInteger(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${label} must be a positive safe integer.`);
	}
}

export function createGatewayRuntimeSandboxEnvironmentRuntime(
	options: CreateGatewayRuntimeSandboxEnvironmentRuntimeOptions,
): GatewayRuntimeSandboxEnvironmentRuntime {
	requirePositiveSafeInteger(options.maximumEnvironmentCount, 'Maximum environment count');
	requirePositiveSafeInteger(
		options.maximumTerminalTombstones,
		'Maximum environment terminal tombstones',
	);
	const owningGeneration = BoundedOpaqueIdentifierSchema.parse(options.owningGeneration);
	const recordsByHandleId = new Map<string, SandboxEnvironmentRecord>();
	const terminalHandleOrder: string[] = [];
	let issuanceSequence = 0;
	let retired = false;

	const createEnvironmentHandle = (): SandboxEnvironmentHandle => {
		if (issuanceSequence >= Number.MAX_SAFE_INTEGER) {
			throw new Error('Sandbox environment handle issuance sequence is exhausted.');
		}
		issuanceSequence += 1;
		const factoryMaterial = BoundedOpaqueIdentifierSchema.parse(options.createHandleId());
		const materialDigest = createHash('sha256')
			.update(owningGeneration, 'utf8')
			.update('\0')
			.update(String(issuanceSequence), 'utf8')
			.update('\0')
			.update(factoryMaterial, 'utf8')
			.digest('hex');
		return SandboxEnvironmentHandleSchema.parse({
			handleId: `environment:${issuanceSequence}:${materialDigest}`,
			kind: 'environment',
			owningGeneration,
		});
	};

	const evictOldestTerminalRecord = (): boolean => {
		for (;;) {
			const oldestHandleId = terminalHandleOrder.shift();
			if (oldestHandleId === undefined) return false;
			const oldestRecord = recordsByHandleId.get(oldestHandleId);
			if (oldestRecord === undefined) continue;
			if (oldestRecord.state === 'active') {
				throw new Error('Sandbox environment terminal order contains active authority.');
			}
			recordsByHandleId.delete(oldestHandleId);
			return true;
		}
	};

	const enforceTerminalTombstoneLimit = (): void => {
		while (terminalHandleOrder.length > options.maximumTerminalTombstones) {
			if (!evictOldestTerminalRecord()) {
				throw new Error('Sandbox environment terminal retention state is inconsistent.');
			}
		}
	};

	const requireRecord = (candidate: SandboxEnvironmentHandle): SandboxEnvironmentRecord => {
		const environment = SandboxEnvironmentHandleSchema.parse(candidate);
		if (environment.owningGeneration !== owningGeneration) {
			throw new Error('Sandbox environment handle belongs to a different generation.');
		}
		const record = recordsByHandleId.get(environment.handleId);
		if (record === undefined) throw new Error('Unknown sandbox environment handle.');
		return record;
	};

	const markTerminal = (record: SandboxEnvironmentRecord, state: 'closed' | 'replaced'): void => {
		if (record.state !== 'active') return;
		record.state = state;
		terminalHandleOrder.push(record.environment.handleId);
		enforceTerminalTombstoneLimit();
	};

	return {
		close: (request) => {
			const parsedRequest = SandboxEnvironmentHandleRequestSchema.parse(request);
			const record = requireRecord(parsedRequest.environment);
			if (record.state === 'replaced') {
				throw new Error('Cannot close a replaced sandbox environment.');
			}
			if (record.state === 'closed') {
				return SandboxEnvironmentCloseResultSchema.parse({
					environment: record.environment,
					kind: 'already-closed',
				});
			}
			markTerminal(record, 'closed');
			return SandboxEnvironmentCloseResultSchema.parse({
				environment: record.environment,
				kind: 'closed',
			});
		},
		open: (request) => {
			if (retired) throw new Error('Sandbox environment runtime is retired.');
			const parsedRequest = SandboxEnvironmentOpenRequestSchema.parse(request);
			const environment = createEnvironmentHandle();
			while (recordsByHandleId.size >= options.maximumEnvironmentCount) {
				if (!evictOldestTerminalRecord()) {
					throw new Error('Sandbox environment count limit exceeded.');
				}
			}
			const record = {
				environment,
				...(parsedRequest.logicalCwd === undefined ? {} : { logicalCwd: parsedRequest.logicalCwd }),
				state: 'active',
			} satisfies SandboxEnvironmentRecord;
			recordsByHandleId.set(environment.handleId, record);
			return SandboxEnvironmentOpenResultSchema.parse({
				environment,
				kind: 'opened',
				...(record.logicalCwd === undefined ? {} : { logicalCwd: record.logicalCwd }),
			});
		},
		resolveActiveEnvironment: (candidate) => {
			if (retired) throw new Error('Sandbox environment runtime is retired.');
			const record = requireRecord(candidate);
			if (record.state !== 'active') {
				throw new Error('Sandbox environment handle is not active.');
			}
			return {
				environment: record.environment,
				...(record.logicalCwd === undefined ? {} : { logicalCwd: record.logicalCwd }),
				workRelativeCwd: record.logicalCwd ?? '',
			};
		},
		retire: () => {
			if (retired) return;
			retired = true;
			for (const record of recordsByHandleId.values()) {
				markTerminal(record, 'replaced');
			}
		},
		status: (request) => {
			const parsedRequest = SandboxEnvironmentHandleRequestSchema.parse(request);
			const record = requireRecord(parsedRequest.environment);
			if (record.state === 'active') {
				return SandboxEnvironmentStatusResultSchema.parse({
					environment: record.environment,
					kind: 'active',
					...(record.logicalCwd === undefined ? {} : { logicalCwd: record.logicalCwd }),
				});
			}
			return SandboxEnvironmentStatusResultSchema.parse({
				environment: record.environment,
				kind: record.state,
			});
		},
	};
}
