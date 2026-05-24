import fs from 'node:fs/promises';
import path from 'node:path';

import {
	buildGatewaySessionLabel,
	gatewayTypeValues,
	type GatewayProcessSpec,
	type GatewayType,
} from '@agent-vm/gateway-interface';
import { type ManagedVm, writeFileAtomically } from '@agent-vm/gondolin-adapter';
import { ZodError, z } from 'zod';

import { readProcessIdentity as defaultReadProcessIdentity } from '../shared/managed-vm-process.js';

export const gatewayRuntimeRecordSchema = z.strictObject({
	schemaVersion: z.literal(1),
	configPath: z.string().min(1),
	controllerPort: z.number().int().positive(),
	createdAt: z.iso.datetime(),
	gatewayType: z.enum(gatewayTypeValues),
	guestListenPort: z.number().int().positive(),
	ingressPort: z.number().int().positive(),
	processIdentity: z.strictObject({
		command: z.string().min(1),
		lstart: z.string().min(1),
	}),
	projectNamespace: z.string().min(1),
	qemuPid: z.number().int().positive(),
	sessionLabel: z.string().min(1),
	vmId: z.string().min(1),
	zoneId: z.string().min(1),
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
	readonly ingressPort: number;
	readonly managedVm: ManagedVm;
	readonly processSpec: GatewayProcessSpec;
	readonly projectNamespace: string;
	readonly readProcessIdentity?: typeof defaultReadProcessIdentity;
	readonly systemConfigPath: string;
	readonly zoneId: string;
}): Promise<GatewayRuntimeRecord> {
	const gatewayType = gatewayRuntimeRecordSchema.shape.gatewayType.parse(options.gatewayType);
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
		gatewayType,
		guestListenPort: options.processSpec.guestListenPort,
		ingressPort: options.ingressPort,
		processIdentity,
		projectNamespace: options.projectNamespace,
		qemuPid,
		schemaVersion: 1,
		sessionLabel: buildGatewaySessionLabel(options.projectNamespace, options.zoneId),
		vmId: options.managedVm.id,
		zoneId: options.zoneId,
	});
}
