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

export const gatewayRuntimeRecordSchema = z.object({
	configPath: z.string().min(1),
	controllerPort: z.number().int().positive(),
	createdAt: z.string().datetime(),
	gatewayType: z.enum(gatewayTypeValues),
	guestListenPort: z.number().int().positive(),
	ingressPort: z.number().int().positive(),
	projectNamespace: z.string().min(1),
	qemuPid: z.number().int().positive(),
	sessionLabel: z.string().min(1),
	vmId: z.string().min(1),
	zoneId: z.string().min(1),
});

const legacyGatewayRuntimeRecordSchema = gatewayRuntimeRecordSchema.omit({
	configPath: true,
	controllerPort: true,
});

export type GatewayRuntimeRecord = z.infer<typeof gatewayRuntimeRecordSchema>;
export type GatewayRuntimeLog = (message: string) => void;
export interface GatewayRuntimeRecordLegacyDefaults {
	readonly configPath: string;
	readonly controllerPort: number;
}

const gatewayRuntimeRecordFileName = 'gateway-runtime.json';

function resolveGatewayRuntimeRecordPath(stateDirectory: string): string {
	return path.join(stateDirectory, gatewayRuntimeRecordFileName);
}

function resolveInvalidGatewayRuntimeRecordPath(stateDirectory: string): string {
	return path.join(stateDirectory, `gateway-runtime.invalid.${Date.now()}.json`);
}

async function quarantineMalformedGatewayRuntimeRecord(
	stateDirectory: string,
	runtimeRecordPath: string,
	log: GatewayRuntimeLog,
): Promise<void> {
	const invalidRuntimeRecordPath = resolveInvalidGatewayRuntimeRecordPath(stateDirectory);
	try {
		await fs.rename(runtimeRecordPath, invalidRuntimeRecordPath);
		log(
			`Quarantined malformed gateway runtime record '${runtimeRecordPath}' to '${invalidRuntimeRecordPath}'.`,
		);
		return;
	} catch (error) {
		await fs.rm(runtimeRecordPath, { force: true });
		log(
			`Deleted malformed gateway runtime record '${runtimeRecordPath}' after quarantine rename failed: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
		);
	}
}

export async function quarantineGatewayRuntimeRecord(
	stateDirectory: string,
	options: {
		readonly log?: GatewayRuntimeLog;
		readonly reason: string;
	} = { reason: 'runtime record no longer matches the active cleanup scope' },
): Promise<void> {
	const runtimeRecordPath = resolveGatewayRuntimeRecordPath(stateDirectory);
	const quarantinedRuntimeRecordPath = path.join(
		stateDirectory,
		`gateway-runtime.quarantined.${Date.now()}.json`,
	);
	try {
		await fs.rename(runtimeRecordPath, quarantinedRuntimeRecordPath);
		(options.log ?? writeGatewayRuntimeLog)(
			`Quarantined gateway runtime record '${runtimeRecordPath}' to '${quarantinedRuntimeRecordPath}': ${options.reason}.`,
		);
	} catch (error) {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
			return;
		}
		throw error;
	}
}

function writeGatewayRuntimeLog(message: string): void {
	process.stderr.write(`[agent-vm] ${message}\n`);
}

export async function loadGatewayRuntimeRecord(
	stateDirectory: string,
	options: {
		readonly legacyRecordDefaults?: GatewayRuntimeRecordLegacyDefaults;
		readonly log?: GatewayRuntimeLog;
	} = {},
): Promise<GatewayRuntimeRecord | null> {
	const runtimeRecordPath = resolveGatewayRuntimeRecordPath(stateDirectory);
	let rawRuntimeRecord: string;
	try {
		rawRuntimeRecord = await fs.readFile(runtimeRecordPath, 'utf8');
	} catch (error) {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
			return null;
		}
		throw error;
	}

	try {
		const parsedRuntimeRecord = JSON.parse(rawRuntimeRecord) as unknown;
		const currentRuntimeRecord = gatewayRuntimeRecordSchema.safeParse(parsedRuntimeRecord);
		if (currentRuntimeRecord.success) {
			return currentRuntimeRecord.data;
		}
		const legacyRuntimeRecord = legacyGatewayRuntimeRecordSchema.safeParse(parsedRuntimeRecord);
		if (legacyRuntimeRecord.success && options.legacyRecordDefaults !== undefined) {
			return gatewayRuntimeRecordSchema.parse({
				...legacyRuntimeRecord.data,
				configPath: options.legacyRecordDefaults.configPath,
				controllerPort: options.legacyRecordDefaults.controllerPort,
			});
		}
		if (legacyRuntimeRecord.success) {
			throw new Error(
				`Gateway runtime record '${runtimeRecordPath}' uses the legacy format and requires legacyRecordDefaults to supply configPath and controllerPort.`,
			);
		}
		throw currentRuntimeRecord.error;
	} catch (error) {
		if (!(error instanceof SyntaxError) && !(error instanceof ZodError)) {
			throw error;
		}
		await quarantineMalformedGatewayRuntimeRecord(
			stateDirectory,
			runtimeRecordPath,
			options.log ?? writeGatewayRuntimeLog,
		);
		return null;
	}
}

export async function writeGatewayRuntimeRecord(
	stateDirectory: string,
	record: GatewayRuntimeRecord,
): Promise<void> {
	const runtimeRecordPath = resolveGatewayRuntimeRecordPath(stateDirectory);
	await fs.mkdir(stateDirectory, { recursive: true });
	await writeFileAtomically(
		runtimeRecordPath,
		`${JSON.stringify(gatewayRuntimeRecordSchema.parse(record), null, 2)}\n`,
		{ mode: 0o600 },
	);
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

export function buildGatewayRuntimeRecord(options: {
	readonly controllerPort: number;
	readonly gatewayType: GatewayType;
	readonly ingressPort: number;
	readonly managedVm: ManagedVm;
	readonly processSpec: GatewayProcessSpec;
	readonly projectNamespace: string;
	readonly systemConfigPath: string;
	readonly zoneId: string;
}): GatewayRuntimeRecord {
	const gatewayType = gatewayRuntimeRecordSchema.shape.gatewayType.parse(options.gatewayType);

	return {
		configPath: options.systemConfigPath,
		controllerPort: options.controllerPort,
		createdAt: new Date().toISOString(),
		gatewayType,
		guestListenPort: options.processSpec.guestListenPort,
		ingressPort: options.ingressPort,
		projectNamespace: options.projectNamespace,
		qemuPid: resolveManagedVmQemuPid(options.managedVm),
		sessionLabel: buildGatewaySessionLabel(options.projectNamespace, options.zoneId),
		vmId: options.managedVm.id,
		zoneId: options.zoneId,
	};
}
