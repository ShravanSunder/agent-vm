export const CONTROL_LEASE_RELIABILITY_OPERATION_IDS = [
	'control-session-recovery',
	'openclaw-process-recovery',
	'active-operation-containment',
	'lease-leaf-replacement',
	'gateway-subtree-replacement',
	'controller-restart-cleanup',
	'control-admission-isolation',
	'observability-pressure-isolation',
	'recovery-no-flap',
] as const;

export type ControlLeaseReliabilityOperationId =
	(typeof CONTROL_LEASE_RELIABILITY_OPERATION_IDS)[number];
export type ControlLeaseReliabilityProject = 'e2e-openclaw' | 'e2e-vm';

export interface ControlLeaseReliabilityScenario {
	readonly operationId: ControlLeaseReliabilityOperationId;
	readonly project: ControlLeaseReliabilityProject;
	readonly requiresQueryIdentity: boolean;
	readonly testFile: string;
}

const integrationTestRoot = 'packages/agent-vm/src/integration-tests';

export const CONTROL_LEASE_RELIABILITY_SCENARIOS = [
	{
		operationId: 'control-session-recovery',
		project: 'e2e-openclaw',
		requiresQueryIdentity: false,
		testFile: `${integrationTestRoot}/control-session-recovery.openclaw.e2e.test.ts`,
	},
	{
		operationId: 'openclaw-process-recovery',
		project: 'e2e-openclaw',
		requiresQueryIdentity: false,
		testFile: `${integrationTestRoot}/openclaw-process-recovery.openclaw.e2e.test.ts`,
	},
	{
		operationId: 'active-operation-containment',
		project: 'e2e-openclaw',
		requiresQueryIdentity: false,
		testFile: `${integrationTestRoot}/active-operation-containment.openclaw.e2e.test.ts`,
	},
	{
		operationId: 'lease-leaf-replacement',
		project: 'e2e-openclaw',
		requiresQueryIdentity: false,
		testFile: `${integrationTestRoot}/lease-leaf-replacement.openclaw.e2e.test.ts`,
	},
	{
		operationId: 'gateway-subtree-replacement',
		project: 'e2e-openclaw',
		requiresQueryIdentity: false,
		testFile: `${integrationTestRoot}/gateway-subtree-replacement.openclaw.e2e.test.ts`,
	},
	{
		operationId: 'controller-restart-cleanup',
		project: 'e2e-vm',
		requiresQueryIdentity: false,
		testFile: `${integrationTestRoot}/controller-restart-cleanup.vm.e2e.test.ts`,
	},
	{
		operationId: 'control-admission-isolation',
		project: 'e2e-openclaw',
		requiresQueryIdentity: false,
		testFile: `${integrationTestRoot}/control-admission-isolation.openclaw.e2e.test.ts`,
	},
	{
		operationId: 'observability-pressure-isolation',
		project: 'e2e-openclaw',
		requiresQueryIdentity: true,
		testFile: `${integrationTestRoot}/observability-pressure-isolation.openclaw.e2e.test.ts`,
	},
	{
		operationId: 'recovery-no-flap',
		project: 'e2e-openclaw',
		requiresQueryIdentity: true,
		testFile: `${integrationTestRoot}/recovery-no-flap.openclaw.e2e.test.ts`,
	},
] as const satisfies readonly ControlLeaseReliabilityScenario[];
