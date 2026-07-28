import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { GATEWAY_RUNTIME_TOOL_PORTAL_CONTROL_GUEST_PORT } from '@agent-vm/gateway-control-contracts';
import {
	buildGatewaySessionLabel,
	parseManagedGatewayBootContract,
	type ManagedGatewayBootContract,
} from '@agent-vm/gateway-lifecycle';
import type { ManagedVm, ManagedVmImageBuildResult } from '@agent-vm/managed-vm';
import { ZodError, z } from 'zod';

import type { ControllerManagedGatewayRuntimeRecordTarget } from '../controller/durable-state/controller-state-record-paths.js';
import {
	gatewayEpochIdentitySchema,
	type GatewayEpochIdentity,
} from '../controller/vm-ownership/vm-ownership-contracts.js';
import type { ManagedVmProcessTarget } from '../shared/controller-managed-vm-termination.js';
import { readProcessIdentity as defaultReadProcessIdentity } from '../shared/managed-vm-process.js';
import { writeFileAtomically } from '../shared/write-file-atomically.js';
import type {
	GatewayExpectedAdmissionCohort,
	GatewayIngressRouteIdentity,
} from './gateway-aggregate-admission-state.js';

const boundedIdentityValueSchema = z
	.string()
	.min(1)
	.max(256)
	.refine((value) => !value.includes('\0'));
const boundedAbsolutePathSchema = z
	.string()
	.min(1)
	.max(4096)
	.refine((value) => path.isAbsolute(value) && !value.includes('\0'));
const boundedProcessIdentityTextSchema = z
	.string()
	.min(1)
	.max(16_384)
	.refine((value) => !value.includes('\0'));
const networkPortSchema = z.number().int().min(1).max(65_535);
const processIdentitySchema = z.strictObject({
	command: boundedProcessIdentityTextSchema,
	lstart: boundedProcessIdentityTextSchema,
});

const managedGatewayBootContractRecordSchema = z
	.unknown()
	.transform<ManagedGatewayBootContract>((value, context) => {
		try {
			return parseManagedGatewayBootContract(value);
		} catch (error: unknown) {
			context.addIssue({
				code: 'custom',
				message: error instanceof Error ? error.message : String(error),
			});
			return z.NEVER;
		}
	});

const managedGatewayImageIdentitySchema = z.strictObject({
	built: z.boolean(),
	fingerprint: boundedIdentityValueSchema,
	imageReference: boundedIdentityValueSchema,
});

const managedVmProcessTargetSchema = z.strictObject({
	hostPid: z.number().int().positive(),
	processIdentity: processIdentitySchema,
	vmId: boundedIdentityValueSchema,
});

const gatewayAdmissionFenceSchema = z.strictObject({
	controllerEpoch: boundedIdentityValueSchema,
	gatewayEpoch: boundedIdentityValueSchema,
	vmId: boundedIdentityValueSchema,
	zoneId: boundedIdentityValueSchema,
});

const gatewayToolPortalAdmissionIdentitySchema = z.strictObject({
	processEpoch: boundedIdentityValueSchema,
	role: z.literal('tool-portal'),
	runtimeEpoch: boundedIdentityValueSchema,
	serviceId: boundedIdentityValueSchema,
});

const gatewayFrameworkAdmissionIdentitySchema = z
	.strictObject({
		attachmentGeneration: z.number().int().nonnegative(),
		clientKind: z.enum(['hermes-managed-plugin', 'openclaw-managed-plugin']),
		configuredAgentIds: z.array(boundedIdentityValueSchema).min(1),
		frameworkEpoch: boundedIdentityValueSchema,
		frameworkKind: z.enum(['hermes', 'openclaw']),
		projectionCohortDigest: z.string().regex(/^projection-cohort:[a-f0-9]{64}$/u),
	})
	.superRefine((identity, context) => {
		if (new Set(identity.configuredAgentIds).size !== identity.configuredAgentIds.length) {
			context.addIssue({
				code: 'custom',
				message: 'Configured managed Gateway agent identities must be unique.',
				path: ['configuredAgentIds'],
			});
		}
		const expectedClientKind = `${identity.frameworkKind}-managed-plugin`;
		if (identity.clientKind !== expectedClientKind) {
			context.addIssue({
				code: 'custom',
				message: 'Managed Gateway client kind must match its framework kind.',
				path: ['clientKind'],
			});
		}
	});

const gatewayUdsAdmissionIdentitySchema = z.strictObject({
	frameworkEpoch: boundedIdentityValueSchema,
	gatewayEpoch: boundedIdentityValueSchema,
	runtimeEpoch: boundedIdentityValueSchema,
	socketPath: boundedAbsolutePathSchema,
});

const gatewayControlAdmissionIdentitySchema = z.strictObject({
	controllerEpoch: boundedIdentityValueSchema,
	generationId: boundedIdentityValueSchema,
	peerId: boundedIdentityValueSchema,
	processEpoch: boundedIdentityValueSchema,
});

const gatewayFrameworkRootIngressRouteIdentitySchema = z.strictObject({
	guestPort: networkPortSchema,
	kind: z.literal('framework-root'),
	prefix: z
		.string()
		.min(1)
		.max(1024)
		.startsWith('/')
		.refine((value) => !value.includes('\0')),
	stripPrefix: z.boolean(),
});

const gatewayProtectedIngressRouteIdentityBaseSchema = z.strictObject({
	audience: boundedIdentityValueSchema,
	guestPort: networkPortSchema,
	prefix: z
		.string()
		.min(1)
		.max(1024)
		.startsWith('/')
		.refine((value) => !value.includes('\0')),
	stripPrefix: z.boolean(),
});

const gatewayToolPortalControlRouteIdentitySchema =
	gatewayProtectedIngressRouteIdentityBaseSchema.extend({
		guestPort: z.literal(GATEWAY_RUNTIME_TOOL_PORTAL_CONTROL_GUEST_PORT),
		kind: z.literal('tool-portal-control'),
	});
const gatewayIngressRouteIdentitySchema = z.discriminatedUnion('kind', [
	gatewayFrameworkRootIngressRouteIdentitySchema,
	gatewayToolPortalControlRouteIdentitySchema,
]);

const gatewayIngressAdmissionIntentSchema = z.strictObject({
	controlRoute: gatewayToolPortalControlRouteIdentitySchema,
	frameworkRootRoute: gatewayFrameworkRootIngressRouteIdentitySchema,
});

export const gatewayExpectedAdmissionCohortSchema: z.ZodType<GatewayExpectedAdmissionCohort> = z
	.strictObject({
		controlIdentity: gatewayControlAdmissionIdentitySchema,
		fence: gatewayAdmissionFenceSchema,
		frameworkIdentity: gatewayFrameworkAdmissionIdentitySchema,
		ingressIntent: gatewayIngressAdmissionIntentSchema,
		providerRevision: boundedIdentityValueSchema,
		requiredBackendRevision: boundedIdentityValueSchema,
		semanticRevision: boundedIdentityValueSchema,
		toolPortalIdentity: gatewayToolPortalAdmissionIdentitySchema,
		udsIdentity: gatewayUdsAdmissionIdentitySchema,
	})
	.superRefine((cohort, context) => {
		if (cohort.controlIdentity.controllerEpoch !== cohort.fence.controllerEpoch) {
			context.addIssue({
				code: 'custom',
				message: 'Control and Gateway fence controller epochs must match.',
				path: ['controlIdentity', 'controllerEpoch'],
			});
		}
		if (cohort.controlIdentity.generationId !== cohort.fence.gatewayEpoch) {
			context.addIssue({
				code: 'custom',
				message: 'Control generation and Gateway admission epochs must match.',
				path: ['controlIdentity', 'generationId'],
			});
		}
		if (cohort.udsIdentity.gatewayEpoch !== cohort.fence.gatewayEpoch) {
			context.addIssue({
				code: 'custom',
				message: 'UDS and Gateway admission epochs must match.',
				path: ['udsIdentity', 'gatewayEpoch'],
			});
		}
		if (cohort.controlIdentity.processEpoch !== cohort.toolPortalIdentity.processEpoch) {
			context.addIssue({
				code: 'custom',
				message: 'Control and Tool Portal process epochs must match.',
				path: ['controlIdentity', 'processEpoch'],
			});
		}
		if (cohort.udsIdentity.runtimeEpoch !== cohort.toolPortalIdentity.runtimeEpoch) {
			context.addIssue({
				code: 'custom',
				message: 'UDS and Tool Portal runtime epochs must match.',
				path: ['udsIdentity', 'runtimeEpoch'],
			});
		}
		if (cohort.udsIdentity.frameworkEpoch !== cohort.frameworkIdentity.frameworkEpoch) {
			context.addIssue({
				code: 'custom',
				message: 'UDS and managed framework epochs must match.',
				path: ['udsIdentity', 'frameworkEpoch'],
			});
		}
	});

export const managedGatewayRuntimeRecordSchema = z
	.strictObject({
		appliedIngressRoutes: z.array(gatewayIngressRouteIdentitySchema).readonly(),
		bootContract: managedGatewayBootContractRecordSchema,
		configPath: boundedAbsolutePathSchema,
		controllerPort: networkPortSchema,
		createdAt: z.iso.datetime(),
		expectedCohort: gatewayExpectedAdmissionCohortSchema,
		gateway: gatewayEpochIdentitySchema,
		image: managedGatewayImageIdentitySchema,
		ingressPort: networkPortSchema.optional(),
		processIdentity: processIdentitySchema,
		processTarget: managedVmProcessTargetSchema,
		projectNamespace: boundedIdentityValueSchema,
		qemuPid: z.number().int().positive(),
		runtimeKind: z.literal('managed-gateway'),
		schemaVersion: z.literal(4),
		sessionLabel: boundedIdentityValueSchema,
		vmId: boundedIdentityValueSchema,
		zoneId: boundedIdentityValueSchema,
	})
	.superRefine((record, context) => {
		const { bootContract, expectedCohort, gateway, processTarget } = record;
		const crossIdentityChecks = [
			{
				actual: gateway.gatewayVmId,
				expected: record.vmId,
				message: 'Gateway epoch VM identity must match the runtime record VM identity.',
				path: ['gateway', 'gatewayVmId'],
			},
			{
				actual: gateway.zoneId,
				expected: record.zoneId,
				message: 'Gateway epoch zone must match the runtime record zone.',
				path: ['gateway', 'zoneId'],
			},
			{
				actual: expectedCohort.fence.vmId,
				expected: gateway.gatewayVmId,
				message: 'Admission fence VM identity must match the exact Gateway VM identity.',
				path: ['expectedCohort', 'fence', 'vmId'],
			},
			{
				actual: expectedCohort.fence.zoneId,
				expected: gateway.zoneId,
				message: 'Admission fence zone must match the exact Gateway zone.',
				path: ['expectedCohort', 'fence', 'zoneId'],
			},
			{
				actual: expectedCohort.fence.controllerEpoch,
				expected: gateway.controllerEpoch,
				message: 'Admission fence controller epoch must match the exact Gateway identity.',
				path: ['expectedCohort', 'fence', 'controllerEpoch'],
			},
			{
				actual: expectedCohort.fence.gatewayEpoch,
				expected: gateway.generationId,
				message: 'Admission Gateway epoch must match the exact Gateway generation.',
				path: ['expectedCohort', 'fence', 'gatewayEpoch'],
			},
			{
				actual: record.sessionLabel,
				expected: buildGatewaySessionLabel(record.projectNamespace, record.zoneId),
				message: 'Gateway session label must match the deployment namespace and zone.',
				path: ['sessionLabel'],
			},
		] as const;
		for (const check of crossIdentityChecks) {
			if (check.actual !== check.expected) {
				context.addIssue({ code: 'custom', message: check.message, path: [...check.path] });
			}
		}
		if (processTarget.hostPid !== record.qemuPid) {
			context.addIssue({
				code: 'custom',
				message: 'Exact managed VM process target pid must match the legacy QEMU pid.',
				path: ['processTarget', 'hostPid'],
			});
		}
		if (!isDeepStrictEqual(processTarget.processIdentity, record.processIdentity)) {
			context.addIssue({
				code: 'custom',
				message: 'Exact managed VM process target identity must match the legacy process identity.',
				path: ['processTarget', 'processIdentity'],
			});
		}
		if (processTarget.vmId !== record.vmId) {
			context.addIssue({
				code: 'custom',
				message: 'Exact managed VM process target VM id must match the runtime record VM id.',
				path: ['processTarget', 'vmId'],
			});
		}
		if (
			bootContract.frameworkService.framework !== expectedCohort.frameworkIdentity.frameworkKind
		) {
			context.addIssue({
				code: 'custom',
				message: 'Managed Gateway boot framework must match the admitted framework identity.',
				path: ['bootContract', 'frameworkService', 'framework'],
			});
		}
		if (
			bootContract.frameworkService.ingress.guestPort !==
			expectedCohort.ingressIntent.frameworkRootRoute.guestPort
		) {
			context.addIssue({
				code: 'custom',
				message: 'Managed Gateway boot framework port must match the framework ingress route.',
				path: ['bootContract', 'frameworkService', 'ingress', 'guestPort'],
			});
		}
		const expectedAppliedIngressRoutes: readonly GatewayIngressRouteIdentity[] = [
			expectedCohort.ingressIntent.controlRoute,
			expectedCohort.ingressIntent.frameworkRootRoute,
		];
		const canonicalizeIngressRoutes = (
			routes: readonly GatewayIngressRouteIdentity[],
		): readonly GatewayIngressRouteIdentity[] =>
			[...routes].toSorted((leftRoute, rightRoute) => {
				const kindComparison = leftRoute.kind.localeCompare(rightRoute.kind);
				if (kindComparison !== 0) return kindComparison;
				const prefixComparison = leftRoute.prefix.localeCompare(rightRoute.prefix);
				if (prefixComparison !== 0) return prefixComparison;
				return leftRoute.guestPort - rightRoute.guestPort;
			});
		if (
			!isDeepStrictEqual(
				canonicalizeIngressRoutes(record.appliedIngressRoutes),
				canonicalizeIngressRoutes(expectedAppliedIngressRoutes),
			)
		) {
			context.addIssue({
				code: 'custom',
				message: 'Applied ingress routes must exactly match the final admitted ingress inventory.',
				path: ['appliedIngressRoutes'],
			});
		}
	});

export type ManagedGatewayRuntimeRecord = z.infer<typeof managedGatewayRuntimeRecordSchema>;

export type ManagedGatewayRuntimeRecordLoadResult =
	| {
			readonly kind: 'loaded';
			readonly path: string;
			readonly record: ManagedGatewayRuntimeRecord;
	  }
	| {
			readonly kind: 'missing';
			readonly path: string;
	  }
	| {
			readonly error: Error;
			readonly kind: 'parse-error';
			readonly path: string;
	  };

function parseManagedGatewayRuntimeRecord(
	rawRuntimeRecord: string,
	target: ControllerManagedGatewayRuntimeRecordTarget,
): ManagedGatewayRuntimeRecord {
	const parsedRuntimeRecord = JSON.parse(rawRuntimeRecord) as unknown;
	return parseTargetBoundManagedGatewayRuntimeRecord(parsedRuntimeRecord, target);
}

function parseTargetBoundManagedGatewayRuntimeRecord(
	runtimeRecord: unknown,
	target: ControllerManagedGatewayRuntimeRecordTarget,
): ManagedGatewayRuntimeRecord {
	return managedGatewayRuntimeRecordSchema
		.refine((record) => record.zoneId === target.zoneId, {
			message: 'Managed Gateway runtime record zone must match its controller target zone.',
			path: ['zoneId'],
		})
		.parse(runtimeRecord);
}

function runtimeRecordParseError(error: SyntaxError | ZodError): Error {
	return error instanceof Error ? error : new Error(String(error));
}

export async function loadManagedGatewayRuntimeRecordResult(
	target: ControllerManagedGatewayRuntimeRecordTarget,
): Promise<ManagedGatewayRuntimeRecordLoadResult> {
	const runtimeRecordPath = target.filePath;
	try {
		return {
			kind: 'loaded',
			path: runtimeRecordPath,
			record: parseManagedGatewayRuntimeRecord(
				await fs.readFile(runtimeRecordPath, 'utf8'),
				target,
			),
		};
	} catch (error) {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
			return { kind: 'missing', path: runtimeRecordPath };
		}
		if (!(error instanceof SyntaxError) && !(error instanceof ZodError)) {
			throw error;
		}
		return {
			error: runtimeRecordParseError(error),
			kind: 'parse-error',
			path: runtimeRecordPath,
		};
	}
}

export async function loadManagedGatewayRuntimeRecord(
	target: ControllerManagedGatewayRuntimeRecordTarget,
): Promise<ManagedGatewayRuntimeRecord | null> {
	const loadResult = await loadManagedGatewayRuntimeRecordResult(target);
	if (loadResult.kind === 'missing') return null;
	if (loadResult.kind === 'parse-error') throw loadResult.error;
	return loadResult.record;
}

export async function writeManagedGatewayRuntimeRecord(
	target: ControllerManagedGatewayRuntimeRecordTarget,
	record: ManagedGatewayRuntimeRecord,
): Promise<void> {
	const parsedRecord = parseTargetBoundManagedGatewayRuntimeRecord(record, target);
	const runtimeRecordPath = target.filePath;
	await fs.mkdir(path.dirname(runtimeRecordPath), { recursive: true });
	await writeFileAtomically(runtimeRecordPath, `${JSON.stringify(parsedRecord, null, 2)}\n`, {
		mode: 0o600,
	});
}

export async function deleteManagedGatewayRuntimeRecord(
	target: ControllerManagedGatewayRuntimeRecordTarget,
): Promise<void> {
	await fs.rm(target.filePath, { force: true });
}

function resolveManagedVmHostProcessId(managedVm: ManagedVm): number {
	const qemuPid = managedVm.getHostProcessId();
	if (qemuPid === null) {
		throw new Error(`Managed VM '${managedVm.id}' does not expose an active host process id.`);
	}
	if (!Number.isInteger(qemuPid) || qemuPid <= 0) {
		throw new Error(`Managed VM '${managedVm.id}' exposed an invalid host process id: ${qemuPid}.`);
	}
	return qemuPid;
}

export async function buildManagedGatewayRuntimeRecord(options: {
	readonly appliedIngressRoutes: readonly GatewayIngressRouteIdentity[];
	readonly bootContract: ManagedGatewayBootContract;
	readonly controllerPort: number;
	readonly expectedCohort: GatewayExpectedAdmissionCohort;
	readonly gatewayIdentity: GatewayEpochIdentity;
	readonly ingressPort?: number;
	readonly image: ManagedVmImageBuildResult;
	readonly managedVm: ManagedVm;
	readonly processTarget: ManagedVmProcessTarget;
	readonly projectNamespace: string;
	readonly readProcessIdentity?: typeof defaultReadProcessIdentity;
	readonly systemConfigPath: string;
	readonly zoneId: string;
}): Promise<ManagedGatewayRuntimeRecord> {
	const qemuPid = resolveManagedVmHostProcessId(options.managedVm);
	if (
		options.processTarget.hostPid !== qemuPid ||
		options.processTarget.vmId !== options.managedVm.id
	) {
		throw new Error(
			`Managed Gateway VM '${options.managedVm.id}' live identity does not match its exact process target.`,
		);
	}
	const processIdentityReader = options.readProcessIdentity ?? defaultReadProcessIdentity;
	const processIdentity = await processIdentityReader(qemuPid);
	if (processIdentity === null) {
		throw new Error(
			`Failed to capture process identity for gateway VM '${options.managedVm.id}' pid ${String(qemuPid)}.`,
		);
	}

	return managedGatewayRuntimeRecordSchema.parse({
		appliedIngressRoutes: options.appliedIngressRoutes,
		bootContract: options.bootContract,
		configPath: options.systemConfigPath,
		controllerPort: options.controllerPort,
		createdAt: new Date().toISOString(),
		expectedCohort: options.expectedCohort,
		gateway: options.gatewayIdentity,
		image: options.image,
		...(options.ingressPort === undefined ? {} : { ingressPort: options.ingressPort }),
		processIdentity,
		processTarget: options.processTarget,
		projectNamespace: options.projectNamespace,
		qemuPid,
		runtimeKind: 'managed-gateway',
		schemaVersion: 4,
		sessionLabel: buildGatewaySessionLabel(options.projectNamespace, options.zoneId),
		vmId: options.managedVm.id,
		zoneId: options.zoneId,
	});
}
