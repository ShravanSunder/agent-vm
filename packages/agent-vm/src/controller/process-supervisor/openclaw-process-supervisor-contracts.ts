import { z } from 'zod';

export const OPENCLAW_PROCESS_SUPERVISOR_CONTRACT_VERSION = 1 as const;
export const OPENCLAW_PROCESS_SUPERVISOR_GUEST_HELPER_PATH =
	'/usr/local/libexec/agent-vm-openclaw-process-supervisor';
export const OPENCLAW_PROCESS_SUPERVISOR_GUEST_STATE_DIRECTORY =
	'/run/agent-vm/openclaw-process-supervisor';

const identitySchema = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);

export const openClawProcessSupervisorGatewaySchema = z.strictObject({
	controllerEpoch: identitySchema,
	gatewayEpochId: identitySchema,
	gatewayVmId: identitySchema,
});

const requestBaseShape = {
	actionId: identitySchema,
	contractVersion: z.literal(OPENCLAW_PROCESS_SUPERVISOR_CONTRACT_VERSION),
	expectedProcessEpoch: identitySchema.nullable(),
	gateway: openClawProcessSupervisorGatewaySchema,
};

export const openClawProcessSupervisorRequestSchema = z.discriminatedUnion('kind', [
	z.strictObject({ ...requestBaseShape, kind: z.literal('contain') }),
	z.strictObject({ ...requestBaseShape, kind: z.literal('observe') }),
	z.strictObject({
		...requestBaseShape,
		kind: z.literal('start'),
		selectedProcessEpoch: identitySchema,
	}),
]);

const receiptBaseShape = {
	actionId: identitySchema,
	contractVersion: z.literal(OPENCLAW_PROCESS_SUPERVISOR_CONTRACT_VERSION),
	expectedProcessEpoch: identitySchema.nullable(),
	gateway: openClawProcessSupervisorGatewaySchema,
};
const exactPopulatedCgroupSchema = z.strictObject({
	name: identitySchema,
	populated: z.literal(true),
});
const exactEmptyCgroupSchema = z.strictObject({
	emptyObserved: z.literal(true),
	name: identitySchema,
	populated: z.literal(false),
});
const absentCgroupSchema = z.strictObject({
	name: z.null(),
	populated: z.literal(false),
});
const observedProcessCgroupSchema = z.strictObject({
	name: identitySchema,
	populated: z.boolean(),
});
const incompleteCgroupSchema = z.strictObject({
	emptyObserved: z.literal(true).optional(),
	name: identitySchema.nullable(),
	populated: z.boolean(),
});
const refusalReasonSchema = z.enum([
	'action-reused',
	'cgroup-empty-unproven',
	'cgroup-unavailable',
	'gateway-fence-mismatch',
	'helper-failed',
	'process-fence-mismatch',
	'process-overlap',
]);

const completedStartReceiptSchema = z.strictObject({
	...receiptBaseShape,
	cgroup: exactPopulatedCgroupSchema,
	kind: z.literal('start'),
	observedProcessEpoch: identitySchema,
	status: z.literal('completed'),
});
const completedAbsentObserveReceiptSchema = z.strictObject({
	...receiptBaseShape,
	cgroup: absentCgroupSchema,
	expectedProcessEpoch: z.null(),
	kind: z.literal('observe'),
	observedProcessEpoch: z.null(),
	status: z.literal('completed'),
});
const completedProcessObserveReceiptSchema = z
	.strictObject({
		...receiptBaseShape,
		cgroup: observedProcessCgroupSchema,
		expectedProcessEpoch: identitySchema,
		kind: z.literal('observe'),
		observedProcessEpoch: identitySchema,
		status: z.literal('completed'),
	})
	.refine((receipt) => receipt.observedProcessEpoch === receipt.expectedProcessEpoch, {
		message: 'completed process observation must bind the exact expected process epoch',
		path: ['observedProcessEpoch'],
	});
const completedContainReceiptSchema = z
	.strictObject({
		...receiptBaseShape,
		cgroup: exactEmptyCgroupSchema,
		expectedProcessEpoch: identitySchema,
		kind: z.literal('contain'),
		observedProcessEpoch: identitySchema,
		status: z.literal('completed'),
	})
	.refine((receipt) => receipt.observedProcessEpoch === receipt.expectedProcessEpoch, {
		message: 'completed containment must bind the exact expected process epoch',
		path: ['observedProcessEpoch'],
	});
const nonCompletedReceiptSchema = z.strictObject({
	...receiptBaseShape,
	cgroup: incompleteCgroupSchema,
	kind: z.enum(['contain', 'observe', 'start']),
	observedProcessEpoch: identitySchema.nullable(),
	reason: refusalReasonSchema,
	status: z.enum(['incomplete', 'refused']),
});

export const openClawProcessSupervisorReceiptSchema = z.union([
	completedStartReceiptSchema,
	completedAbsentObserveReceiptSchema,
	completedProcessObserveReceiptSchema,
	completedContainReceiptSchema,
	nonCompletedReceiptSchema,
]);

export type OpenClawProcessSupervisorGateway = z.infer<
	typeof openClawProcessSupervisorGatewaySchema
>;
export type OpenClawProcessSupervisorRequest = z.infer<
	typeof openClawProcessSupervisorRequestSchema
>;
export type OpenClawProcessSupervisorReceipt = z.infer<
	typeof openClawProcessSupervisorReceiptSchema
>;
