import {
	OpenClawDeploymentRequirementError,
	type OpenClawDeploymentRequirementFinding,
} from '../operations/openclaw-deployment-requirements.js';

export const defaultOpenClawRuntimeStatusMaxAgeMs = 60_000;

export interface OpenClawRuntimeStatusReport {
	readonly findings: readonly OpenClawDeploymentRequirementFinding[];
	readonly pluginId: 'gondolin';
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

	assertFreshOk(zoneId: string): void {
		const snapshot = this.snapshotsByZoneId.get(zoneId);
		if (!snapshot) {
			throw new OpenClawRuntimeStatusUnavailableError(
				zoneId,
				'gondolin plugin has not reported runtime status',
			);
		}

		const ageMs = this.nowMs() - snapshot.receivedAtMs;
		if (ageMs > this.maxAgeMs) {
			throw new OpenClawRuntimeStatusUnavailableError(
				zoneId,
				`last gondolin plugin status is stale by ${String(ageMs - this.maxAgeMs)}ms`,
			);
		}

		const failedFindings = snapshot.findings.filter((finding) => !finding.ok);
		if (failedFindings.length > 0) {
			throw new OpenClawDeploymentRequirementError(zoneId, failedFindings);
		}
	}
}
