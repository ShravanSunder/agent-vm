import fs from 'node:fs/promises';
import path from 'node:path';

import {
	buildGatewaySessionLabel,
	gatewayTypeValues,
	type GatewayProcessSpec,
	type GatewayType,
} from '@agent-vm/gateway-lifecycle';
import type { ManagedVm } from '@agent-vm/gondolin-adapter';
import { ZodError, z } from 'zod';

import {
	gatewayEpochIdentitySchema,
	type GatewayEpochIdentity,
} from '../controller/vm-ownership/vm-ownership-contracts.js';
import { readProcessIdentity as defaultReadProcessIdentity } from '../shared/managed-vm-process.js';
import { writeFileAtomically } from '../shared/write-file-atomically.js';

const gatewayTypeSchema = z.enum(gatewayTypeValues);

export const gatewayRuntimeRecordSchema = z
	.strictObject({
		schemaVersion: z.literal(2),
		configPath: z.string().min(1),
		controllerPort: z.number().int().positive(),
		createdAt: z.iso.datetime(),
		gatewayType: gatewayTypeSchema,
		guestListenPort: z.number().int().positive(),
		gateway: gatewayEpochIdentitySchema,
		ingressPort: z.number().int().positive().optional(),
		processIdentity: z.strictObject({
			command: z.string().min(1),
			lstart: z.string().min(1),
		}),
		projectNamespace: z.string().min(1),
		qemuPid: z.number().int().positive(),
		sessionLabel: z.string().min(1),
		vmId: z.string().min(1),
		zoneId: z.string().min(1),
	})
	.superRefine((record, context) => {
		if (record.gateway.gatewayVmId !== record.vmId) {
			context.addIssue({
				code: 'custom',
				message: 'Gateway epoch VM identity must match the runtime record VM identity.',
				path: ['gateway', 'gatewayVmId'],
			});
		}
		if (record.gateway.zoneId !== record.zoneId) {
			context.addIssue({
				code: 'custom',
				message: 'Gateway epoch zone must match the runtime record zone.',
				path: ['gateway', 'zoneId'],
			});
		}
	});

export type GatewayRuntimeRecord = z.infer<typeof gatewayRuntimeRecordSchema>;

export type GatewayRuntimeRecordLoadResult =
	| {
			readonly kind: 'loaded';
			readonly path: string;
			readonly record: GatewayRuntimeRecord;
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

const gatewayRuntimeRecordFileName = 'gateway-runtime.json';

function resolveGatewayRuntimeRecordPath(stateDirectory: string): string {
	return path.join(stateDirectory, gatewayRuntimeRecordFileName);
}

function parseGatewayRuntimeRecord(rawRuntimeRecord: string): GatewayRuntimeRecord {
	const parsedRuntimeRecord = JSON.parse(rawRuntimeRecord) as unknown;
	return gatewayRuntimeRecordSchema.parse(parsedRuntimeRecord);
}

function runtimeRecordParseError(error: SyntaxError | ZodError): Error {
	return error instanceof Error ? error : new Error(String(error));
}

export async function loadGatewayRuntimeRecordResult(
	stateDirectory: string,
): Promise<GatewayRuntimeRecordLoadResult> {
	const runtimeRecordPath = resolveGatewayRuntimeRecordPath(stateDirectory);
	try {
		return {
			kind: 'loaded',
			path: runtimeRecordPath,
			record: parseGatewayRuntimeRecord(await fs.readFile(runtimeRecordPath, 'utf8')),
		};
	} catch (error) {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
			return {
				kind: 'missing',
				path: runtimeRecordPath,
			};
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

export async function loadGatewayRuntimeRecord(
	stateDirectory: string,
): Promise<GatewayRuntimeRecord | null> {
	const loadResult = await loadGatewayRuntimeRecordResult(stateDirectory);
	if (loadResult.kind === 'missing') {
		return null;
	}
	if (loadResult.kind === 'parse-error') {
		throw loadResult.error;
	}
	return loadResult.record;
}

export async function writeGatewayRuntimeRecord(
	stateDirectory: string,
	record: GatewayRuntimeRecord,
): Promise<void> {
	const parsedRecord = gatewayRuntimeRecordSchema.parse(record);
	const runtimeRecordPath = resolveGatewayRuntimeRecordPath(stateDirectory);
	await fs.mkdir(stateDirectory, { recursive: true });
	await writeFileAtomically(runtimeRecordPath, `${JSON.stringify(parsedRecord, null, 2)}\n`, {
		mode: 0o600,
	});
}

export async function deleteGatewayRuntimeRecord(stateDirectory: string): Promise<void> {
	await fs.rm(resolveGatewayRuntimeRecordPath(stateDirectory), { force: true });
}

function resolveManagedVmQemuPid(managedVm: ManagedVm): number {
	if (typeof managedVm.getHostPid !== 'function') {
		throw new Error('Managed VM wrapper is missing getHostPid(); update the Gondolin adapter.');
	}
	const qemuPid = managedVm.getHostPid();
	if (qemuPid === null) {
		throw new Error(
			'Gondolin VM runtime does not expose an active host pid; upgrade @earendil-works/gondolin to a version with VM.getHostPid().',
		);
	}
	if (!Number.isInteger(qemuPid) || qemuPid <= 0) {
		throw new Error(`Gondolin VM runtime exposed an invalid host pid: ${qemuPid}.`);
	}

	return qemuPid;
}

export async function buildGatewayRuntimeRecord(options: {
	readonly controllerPort: number;
	readonly gatewayType: GatewayType;
	readonly gatewayIdentity: GatewayEpochIdentity;
	readonly ingressPort?: number;
	readonly managedVm: ManagedVm;
	readonly processSpec: GatewayProcessSpec;
	readonly projectNamespace: string;
	readonly readProcessIdentity?: typeof defaultReadProcessIdentity;
	readonly systemConfigPath: string;
	readonly zoneId: string;
}): Promise<GatewayRuntimeRecord> {
	const gatewayType = gatewayTypeSchema.parse(options.gatewayType);
	const qemuPid = resolveManagedVmQemuPid(options.managedVm);
	const processIdentityReader = options.readProcessIdentity ?? defaultReadProcessIdentity;
	const processIdentity = await processIdentityReader(qemuPid);
	if (processIdentity === null) {
		throw new Error(
			`Failed to capture process identity for gateway VM '${options.managedVm.id}' pid ${String(qemuPid)}.`,
		);
	}

	return gatewayRuntimeRecordSchema.parse({
		configPath: options.systemConfigPath,
		controllerPort: options.controllerPort,
		createdAt: new Date().toISOString(),
		gateway: options.gatewayIdentity,
		gatewayType,
		guestListenPort: options.processSpec.guestListenPort,
		...(options.ingressPort === undefined ? {} : { ingressPort: options.ingressPort }),
		processIdentity,
		projectNamespace: options.projectNamespace,
		qemuPid,
		schemaVersion: 2,
		sessionLabel: buildGatewaySessionLabel(options.projectNamespace, options.zoneId),
		vmId: options.managedVm.id,
		zoneId: options.zoneId,
	});
}
