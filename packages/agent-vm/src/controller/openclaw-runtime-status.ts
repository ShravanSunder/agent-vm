import {
	OpenClawDeploymentRequirementError,
	type OpenClawDeploymentRequirementFinding,
} from '../operations/openclaw-deployment-requirements.js';

export const defaultOpenClawRuntimeStatusMaxAgeMs = 60_000;

export interface OpenClawRuntimeStatusReport {
	readonly bootId: string;
	readonly connectionId: string;
	readonly controllerEpoch: string;
	readonly findings: readonly OpenClawDeploymentRequirementFinding[];
	readonly peerId: string;
	readonly pluginId: string;
	readonly sessionId: string;
	readonly zoneId: string;
}

export interface OpenClawRuntimeStatusSessionRef {
	readonly bootId: string;
	readonly connectionId: string;
	readonly controllerEpoch: string;
	readonly peerId: string;
	readonly sessionId: string;
	readonly zoneId: string;
}

export class OpenClawRuntimeStatusUnavailableError extends Error {
	readonly kind = 'openclaw-runtime-status-unavailable';
	readonly zoneId: string;

	constructor(zoneId: string, reason: string) {
		super(`OpenClaw zone '${zoneId}' runtime status unavailable: ${reason}`);
		this.name = 'OpenClawRuntimeStatusUnavailableError';
		this.zoneId = zoneId;
	}
}

interface OpenClawRuntimeStatusSnapshot extends OpenClawRuntimeStatusReport {
	readonly receivedAtMs: number;
}

function assertRuntimeStatusSnapshotOk(options: {
	readonly maxAgeMs: number;
	readonly nowMs: number;
	readonly snapshot: OpenClawRuntimeStatusSnapshot;
}): void {
	const ageMs = options.nowMs - options.snapshot.receivedAtMs;
	if (ageMs > options.maxAgeMs) {
		throw new OpenClawRuntimeStatusUnavailableError(
			options.snapshot.zoneId,
			`last gondolin plugin status is stale by ${String(ageMs - options.maxAgeMs)}ms`,
		);
	}

	const failedFindings = options.snapshot.findings.filter((finding) => !finding.ok);
	if (failedFindings.length > 0) {
		throw new OpenClawDeploymentRequirementError(options.snapshot.zoneId, failedFindings);
	}
}

export class OpenClawRuntimeStatusStore {
	private readonly maxAgeMs: number;
	private readonly nowMs: () => number;
	private readonly snapshotsByZoneId = new Map<string, OpenClawRuntimeStatusSnapshot>();

	constructor(options?: { readonly maxAgeMs?: number; readonly nowMs?: () => number }) {
		this.maxAgeMs = options?.maxAgeMs ?? defaultOpenClawRuntimeStatusMaxAgeMs;
		this.nowMs = options?.nowMs ?? Date.now;
	}

	record(report: OpenClawRuntimeStatusReport): OpenClawRuntimeStatusSnapshot {
		const snapshot = {
			...report,
			receivedAtMs: this.nowMs(),
		};
		this.snapshotsByZoneId.set(report.zoneId, snapshot);
		return snapshot;
	}

	assertAnyFreshOk(zoneId: string): void {
		const snapshot = this.snapshotsByZoneId.get(zoneId);
		if (!snapshot) {
			throw new OpenClawRuntimeStatusUnavailableError(
				zoneId,
				'gondolin plugin has not reported runtime status',
			);
		}
		assertRuntimeStatusSnapshotOk({
			maxAgeMs: this.maxAgeMs,
			nowMs: this.nowMs(),
			snapshot,
		});
	}

	assertFreshOk(session: OpenClawRuntimeStatusSessionRef): void {
		const snapshot = this.snapshotsByZoneId.get(session.zoneId);
		if (!snapshot) {
			throw new OpenClawRuntimeStatusUnavailableError(
				session.zoneId,
				'gondolin plugin has not reported runtime status',
			);
		}
		if (
			snapshot.bootId !== session.bootId ||
			snapshot.connectionId !== session.connectionId ||
			snapshot.controllerEpoch !== session.controllerEpoch ||
			snapshot.peerId !== session.peerId ||
			snapshot.sessionId !== session.sessionId
		) {
			throw new OpenClawRuntimeStatusUnavailableError(
				session.zoneId,
				'gondolin plugin runtime status belongs to a stale control session',
			);
		}

		assertRuntimeStatusSnapshotOk({
			maxAgeMs: this.maxAgeMs,
			nowMs: this.nowMs(),
			snapshot,
		});
	}
}
