import fs from 'node:fs/promises';
import path from 'node:path';

import { writeFileAtomically } from '@agent-vm/gondolin-adapter';
import { z } from 'zod';

import {
	deserializeGatewayControlSessionMaterial,
	serializeGatewayControlSessionMaterial,
	serializedGatewayControlSessionMaterialSchema,
	type GatewayControlSessionMaterial,
} from './gateway-control-session.js';

const gatewayControlSessionMaterialFileName = 'session-material.json';

const gatewayControlSessionMaterialRecordSchema = z.strictObject({
	material: serializedGatewayControlSessionMaterialSchema,
	schemaVersion: z.literal(1),
});

type GatewayControlSessionMaterialRecord = z.infer<
	typeof gatewayControlSessionMaterialRecordSchema
>;

function resolveGatewayControlSessionMaterialDirectory(
	runtimeDirectory: string,
	zoneId: string,
): string {
	return path.join(runtimeDirectory, 'control-sessions', 'gateway', zoneId);
}

export function resolveGatewayControlSessionMaterialPath(
	runtimeDirectory: string,
	zoneId: string,
): string {
	return path.join(
		resolveGatewayControlSessionMaterialDirectory(runtimeDirectory, zoneId),
		gatewayControlSessionMaterialFileName,
	);
}

export async function writeGatewayControlSessionMaterial(
	runtimeDirectory: string,
	material: GatewayControlSessionMaterial,
): Promise<void> {
	const materialDirectory = resolveGatewayControlSessionMaterialDirectory(
		runtimeDirectory,
		material.zoneId,
	);
	const materialPath = resolveGatewayControlSessionMaterialPath(runtimeDirectory, material.zoneId);
	const record: GatewayControlSessionMaterialRecord =
		gatewayControlSessionMaterialRecordSchema.parse({
			material: serializeGatewayControlSessionMaterial(material),
			schemaVersion: 1,
		});

	await fs.mkdir(materialDirectory, { recursive: true });
	await writeFileAtomically(materialPath, `${JSON.stringify(record, null, 2)}\n`, {
		mode: 0o600,
	});
}

export async function loadGatewayControlSessionMaterial(
	runtimeDirectory: string,
	zoneId: string,
): Promise<GatewayControlSessionMaterial | null> {
	try {
		const rawRecord = await fs.readFile(
			resolveGatewayControlSessionMaterialPath(runtimeDirectory, zoneId),
			'utf8',
		);
		const parsedRecord = gatewayControlSessionMaterialRecordSchema.parse(
			JSON.parse(rawRecord) as unknown,
		);
		return deserializeGatewayControlSessionMaterial(parsedRecord.material);
	} catch (error) {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
			return null;
		}
		throw error;
	}
}

export async function deleteGatewayControlSessionMaterial(
	runtimeDirectory: string,
	zoneId: string,
): Promise<void> {
	await fs.rm(resolveGatewayControlSessionMaterialPath(runtimeDirectory, zoneId), { force: true });
}
