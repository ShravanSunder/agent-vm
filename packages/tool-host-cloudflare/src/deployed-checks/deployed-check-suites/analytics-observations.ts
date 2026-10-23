import type { PrivateDeployFile } from '#worker-host/deployed-checks/deploy-configuration/models/private-deploy-file';

function bytes(text: string): number {
	return new TextEncoder().encode(text).byteLength;
}
import {
	analyticsSqlResponseSchema,
	type TailRecord,
} from '#worker-host/deployed-checks/deployed-check-suites/models/deployed-evidence';

export function assertAnalyticsShape(value: unknown, configuration: PrivateDeployFile): void {
	const response = analyticsSqlResponseSchema.safeParse(value);
	if (!response.success) throw new Error('Analytics SQL result has no rows of the expected shape.');
	for (const row of response.data.data) {
		const organization = configuration.organizations.find(
			(entry) => entry.organizationId === row.index1,
		);
		if (
			organization === undefined ||
			row.blob1 !== `${configuration.runId}:${organization.label}` ||
			![configuration.agentId, configuration.otherAgentId].includes(row.blob2)
		)
			throw new Error('Analytics rows do not belong to this deployed check run.');
		const blobs = [
			row.blob1,
			row.blob2,
			row.blob3,
			row.blob4,
			row.blob5,
			row.blob6,
			row.blob7,
			row.blob8,
		];
		if (
			bytes(row.index1) > 96 ||
			blobs.some((text) => bytes(text) > 256) ||
			bytes(blobs.join('')) > 16 * 1024
		)
			throw new Error('Analytics point exceeds the expected byte bounds.');
	}
}
export function assertNoLogCanaries(
	records: readonly TailRecord[],
	canaries: readonly string[],
): void {
	if (records.length === 0 || !records.some((record) => record.logs.length > 0))
		throw new Error('No deployed log data to inspect.');
	const loggedText = JSON.stringify(
		records.flatMap((record) => [record.logs, record.exceptions ?? []]),
	);
	if (canaries.some((canary) => canary.length > 0 && loggedText.includes(canary)))
		throw new Error('Private canary appeared in Worker logs.');
}
