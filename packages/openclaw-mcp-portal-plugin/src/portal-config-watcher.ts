import { createHash } from 'node:crypto';

function stableJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) => stableJsonValue(entry));
	}
	if (typeof value !== 'object' || value === null) {
		return value;
	}

	return Object.fromEntries(
		Object.entries(value)
			.toSorted(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
			.map(([key, entry]) => [key, stableJsonValue(entry)]),
	);
}

export function createPortalConfigFingerprint(value: unknown): string {
	return createHash('sha256')
		.update(JSON.stringify(stableJsonValue(value)))
		.digest('hex');
}

export class PortalConfigWatcher {
	private fingerprint: string | null = null;

	hasChanged(value: unknown): boolean {
		const nextFingerprint = createPortalConfigFingerprint(value);
		if (this.fingerprint === nextFingerprint) {
			return false;
		}
		this.fingerprint = nextFingerprint;
		return true;
	}
}
