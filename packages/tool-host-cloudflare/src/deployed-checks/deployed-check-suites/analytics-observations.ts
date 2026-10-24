import { z } from 'zod';

import { analyticsText } from '#worker-host/analytics-engine-sink/analytics-engine-sink';
import {
	analyticsSqlResponseSchema,
	type TailRecord,
} from '#worker-host/deployed-checks/deployed-check-suites/models/deployed-evidence';

export const expectedWorkspaceRecordsSchema = z
	.array(
		z.strictObject({
			organizationId: z.uuid(),
			workspaceId: z.uuid(),
			label: z.string().min(1),
		}),
	)
	.min(1)
	.refine(
		(records) => new Set(records.map((record) => record.workspaceId)).size === records.length,
		'Expected workspace IDs must be unique.',
	);
export type ExpectedWorkspaceRecord = z.infer<typeof expectedWorkspaceRecordsSchema>[number];

function bytes(text: string): number {
	return new TextEncoder().encode(text).byteLength;
}

export function assertAnalyticsShape(
	value: unknown,
	context: {
		readonly runId: string;
		readonly workspaces: readonly ExpectedWorkspaceRecord[];
		readonly agentIds: readonly string[];
	},
): void {
	const response = analyticsSqlResponseSchema.safeParse(value);
	if (!response.success)
		throw new Error('Analytics SQL result has no rows of the expected nine-blob shape.');
	for (const row of response.data.data) {
		const workspace = context.workspaces.find((entry) => entry.workspaceId === row.index1);
		if (
			workspace === undefined ||
			row.blob1 !== workspace.organizationId ||
			row.blob2 !== analyticsText(`${context.runId}:${workspace.label}`) ||
			!context.agentIds.includes(row.blob3)
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
			row.blob9,
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
