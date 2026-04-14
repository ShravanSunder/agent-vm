import fs from 'node:fs/promises';
import path from 'node:path';

import type { GatewayProcessSpec } from '@shravansunder/agent-vm-gateway-interface';
import type { ManagedVm } from '@shravansunder/agent-vm-gondolin-core';
import { ZodError, z } from 'zod';

export const gatewayRuntimeRecordSchema = z.object({
	createdAt: z.string().datetime(),
	gatewayType: z.enum(['openclaw', 'worker']),
	guestListenPort: z.number().int().positive(),
	ingressPort: z.number().int().positive(),
	projectNamespace: z.string().min(1),
	qemuPid: z.number().int().positive(),
	sessionId: z.string().min(1),
	sessionLabel: z.string().min(1),
	vmId: z.string().min(1),
	zoneId: z.string().min(1),
});

export type GatewayRuntimeRecord = z.infer<typeof gatewayRuntimeRecordSchema>;
export type GatewayRuntimeLog = (message: string) => void;

const gatewayRuntimeRecordFileName = 'gateway-runtime.json';

function resolveGatewayRuntimeRecordPath(stateDirectory: string): string {
	return path.join(stateDirectory, gatewayRuntimeRecordFileName);
}

function resolveInvalidGatewayRuntimeRecordPath(stateDirectory: string): string {
	return path.join(stateDirectory, `gateway-runtime.invalid.${Date.now()}.json`);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

async function writeFileAtomically(filePath: string, content: string): Promise<void> {
	const temporaryFilePath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	await fs.writeFile(temporaryFilePath, content, 'utf8');
	try {
		await fs.rename(temporaryFilePath, filePath);
	} catch (error) {
		await fs.rm(temporaryFilePath, { force: true }).catch(() => {});
		throw error;
	}
}

async function quarantineMalformedGatewayRuntimeRecord(
	stateDirectory: string,
	runtimeRecordPath: string,
	log: GatewayRuntimeLog,
): Promise<void> {
	const invalidRuntimeRecordPath = resolveInvalidGatewayRuntimeRecordPath(stateDirectory);
	let quarantined = true;
	await fs.rename(runtimeRecordPath, invalidRuntimeRecordPath).catch(async () => {
		quarantined = false;
		await fs.rm(runtimeRecordPath, { force: true });
	});
	if (quarantined) {
		log(
			`Quarantined malformed gateway runtime record '${runtimeRecordPath}' to '${invalidRuntimeRecordPath}'.`,
		);
		return;
	}
	log(
		`Deleted malformed gateway runtime record '${runtimeRecordPath}' after quarantine rename failed.`,
	);
}

function writeGatewayRuntimeLog(message: string): void {
	process.stderr.write(`[agent-vm] ${message}\n`);
}

export async function loadGatewayRuntimeRecord(
	stateDirectory: string,
	options: {
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
		return gatewayRuntimeRecordSchema.parse(JSON.parse(rawRuntimeRecord));
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
	await writeFileAtomically(runtimeRecordPath, `${JSON.stringify(record, null, 2)}\n`);
}

export async function deleteGatewayRuntimeRecord(stateDirectory: string): Promise<void> {
	await fs.rm(resolveGatewayRuntimeRecordPath(stateDirectory), { force: true });
}

function resolveManagedVmQemuPid(managedVm: ManagedVm): number {
	const vmInstance = managedVm.getVmInstance() as unknown;
	if (!isObjectRecord(vmInstance)) {
		throw new Error('Gateway VM runtime is missing its live VM instance.');
	}

	// Level 1 currently relies on Gondolin's live runtime object graph:
	// VM -> SandboxServer -> SandboxController -> child_process.ChildProcess.
	// If Gondolin refactors that structure, we fail closed here instead of
	// silently persisting an invalid pid into gateway-runtime.json.
	const server = vmInstance.server;
	if (!isObjectRecord(server)) {
		throw new Error('Gateway VM runtime is missing its live sandbox server.');
	}

	const controller = server.controller;
	if (!isObjectRecord(controller)) {
		throw new Error('Gateway VM runtime is missing its live sandbox controller.');
	}

	const child = controller.child;
	if (!isObjectRecord(child)) {
		throw new Error('Gateway VM runtime is missing its live QEMU child process.');
	}

	const qemuPid = child.pid;
	if (typeof qemuPid !== 'number' || !Number.isInteger(qemuPid) || qemuPid <= 0) {
		throw new Error('Gateway VM runtime is missing its live QEMU pid.');
	}

	return qemuPid;
}

export function buildGatewayRuntimeRecord(options: {
	readonly gatewayType: GatewayRuntimeRecord['gatewayType'];
	readonly ingressPort: number;
	readonly managedVm: ManagedVm;
	readonly processSpec: GatewayProcessSpec;
	readonly projectNamespace: string;
	readonly zoneId: string;
}): GatewayRuntimeRecord {
	const sessionId = options.managedVm.id;

	return {
		createdAt: new Date().toISOString(),
		gatewayType: options.gatewayType,
		guestListenPort: options.processSpec.guestListenPort,
		ingressPort: options.ingressPort,
		projectNamespace: options.projectNamespace,
		qemuPid: resolveManagedVmQemuPid(options.managedVm),
		sessionId,
		sessionLabel: `${options.projectNamespace}:${options.zoneId}:gateway`,
		vmId: options.managedVm.id,
		zoneId: options.zoneId,
	};
}
